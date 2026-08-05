/*
 * Browser e2e for the cloud login handoff (NAVFLOW_LOGIN_URL). Runs the REAL daemon serving the
 * built console behind a stub "control plane", and drives the actual AuthGate with Playwright:
 *   1. /health advertises login_url when NAVFLOW_LOGIN_URL is set
 *   2. logged out + login_url present  → redirect to  {login_url}?return=<cell host>
 *   3. ?code= present                  → POST {origin}/exchange, store the real key, strip the URL,
 *                                        and authenticate against the daemon (token persists)
 *
 * No cloud, no release. The stub mints a real scoped key on the daemon (as the control plane does),
 * so the exchanged token actually works — the console stays authed instead of bouncing to login.
 *
 * Run:  npm run test:e2e   (builds the console first, then this)
 * Needs: the tares daemon importable (repo .venv or system python with tares installed).
 */
const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const UI_DIR = path.resolve(__dirname, "..");        // <repo>/ui
const REPO = path.resolve(__dirname, "..", "..");    // <repo>
const { chromium } = require(path.join(UI_DIR, "node_modules", "playwright"));

const DAEMON_PORT = 8808;
const CP_PORT = 8809;
const ROOT_TOKEN = "root-secret";
const LOGIN_URL = `http://localhost:${CP_PORT}/login`;

let pass = 0, fail = 0;
const ck = (label, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log((cond ? "  ok   " : "  FAIL ") + label + (cond ? "" : `   ${detail}`));
};

// Mint a real scoped key on the daemon with the root token — exactly what the control plane's
// /exchange does. Returns a token the daemon will accept, so the console stays authenticated.
function mintKey() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ name: "e2e", scopes: ["read", "ingest", "admin"] });
    const r = http.request(`http://localhost:${DAEMON_PORT}/api/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ROOT_TOKEN}`,
                 "content-length": Buffer.byteLength(body) },
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { try { const j = JSON.parse(d); j.secret ? resolve(j.secret) : reject(new Error(d)); } catch (e) { reject(e); } });
    });
    r.on("error", reject); r.write(body); r.end();
  });
}

// Stub control plane: GET /login (landing) + POST /exchange (mints a real key), with CORS.
const cp = http.createServer((req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const u = new URL(req.url, `http://localhost:${CP_PORT}`);
  if (u.pathname === "/login") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<h1>STUB LOGIN</h1><p>return=${u.searchParams.get("return") || ""}</p>`);
  }
  if (u.pathname === "/exchange" && req.method === "POST") {
    let b = ""; req.on("data", (c) => (b += c));
    return req.on("end", async () => {
      let code = null; try { code = JSON.parse(b).code; } catch {}
      if (!code) { res.writeHead(400, { "content-type": "application/json", ...cors }); return res.end('{"detail":"no code"}'); }
      try {
        const token = await mintKey();
        res.writeHead(200, { "content-type": "application/json", ...cors });
        res.end(JSON.stringify({ token }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json", ...cors });
        res.end(JSON.stringify({ detail: String(e) }));
      }
    });
  }
  res.writeHead(404, cors); res.end("nope");
});

function waitFor(url, tries = 100) {
  return new Promise((resolve) => {
    const tick = () => http.get(url, (r) => { r.resume(); resolve(true); })
      .on("error", () => (--tries > 0 ? setTimeout(tick, 200) : resolve(false)));
    tick();
  });
}

(async () => {
  const py = fs.existsSync(path.join(REPO, ".venv/bin/python3"))
    ? path.join(REPO, ".venv/bin/python3") : "python3";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tares-e2e-"));
  const db = path.join(tmp, "handoff.duckdb");
  const seed = path.join(tmp, "seed.yaml");
  fs.writeFileSync(seed, "sources:\n  - name: evt\n    connector: webhook\n    poll: 5s\n    config: {}\n");

  cp.listen(CP_PORT);
  const daemon = spawn(py, ["-c", "from navflow.cli import run_daemon; run_daemon()"], {
    cwd: REPO,
    env: { ...process.env, NAVFLOW_DB: db, NAVFLOW_CATALOG: seed, NAVFLOW_PORT: String(DAEMON_PORT),
           NAVFLOW_OTLP_GRPC_PORT: "off", NAVFLOW_AUTH_TOKEN: ROOT_TOKEN, NAVFLOW_LOGIN_URL: LOGIN_URL,
           NAVFLOW_UI_DIST: path.join(UI_DIR, "dist") },
    stdio: "ignore",
  });

  const base = `http://localhost:${DAEMON_PORT}`;
  ck("daemon up + serving", await waitFor(`${base}/health`));

  const health = await new Promise((res) =>
    http.get(`${base}/health`, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(JSON.parse(d))); }));
  ck("/health advertises login_url", health.login_url === LOGIN_URL, JSON.stringify(health));

  const browser = await chromium.launch();
  try {
    // Test: logged out → redirect to the hosted login with ?return=<host>
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
      let redirected = true;
      try { await page.waitForURL(new RegExp(`localhost:${CP_PORT}/login`), { timeout: 8000 }); } catch { redirected = false; }
      ck("logged-out console redirects to login_url", redirected, "url=" + page.url());
      if (redirected) {
        const ret = new URL(page.url()).searchParams.get("return");
        ck("redirect carries ?return=<cell host>", ret === `localhost:${DAEMON_PORT}`, "return=" + ret);
      }
      await ctx.close();
    }

    // Test: ?code= → exchange for a real key, store it, strip the URL, stay authed
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${base}/?code=ABC123`, { waitUntil: "domcontentloaded" });
      let token = null;
      try {
        await page.waitForFunction(() => !!localStorage.getItem("navflow_token"), { timeout: 8000 });
        token = await page.evaluate(() => localStorage.getItem("navflow_token"));
      } catch {}
      ck("?code= exchanged → real cell key stored", !!token && token.startsWith("nvf_"), "token=" + token);
      ck("?code= stripped from the URL", !page.url().includes("code="), "url=" + page.url());
      await page.waitForTimeout(2000); // authed API calls would clear a bad token; a real key persists
      const still = await page.evaluate(() => localStorage.getItem("navflow_token"));
      ck("token persists (console authenticates, no clear)", !!still, "token=" + still);
      ck("stays on the cell (no redirect once authed)", page.url().startsWith(base), "url=" + page.url());
      await ctx.close();
    }
  } finally {
    await browser.close();
    daemon.kill("SIGTERM");
    cp.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

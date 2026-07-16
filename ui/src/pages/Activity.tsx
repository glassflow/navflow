import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { api, auth } from "../api";
import { Close, Search } from "../components/icons";
import { TimeAgo, usePolling } from "../components/bits";
import type { DispatchLogEntry } from "../types";

type Tab = "connect" | "queries" | "dispatches" | "subscriptions";
const LABELS: Record<Tab, string> = {
  connect: "Connect", queries: "Reads", dispatches: "Trigger dispatches",
  subscriptions: "Subscriptions",
};

export default function Activity() {
  const [tab, setTab] = useState<Tab>("connect");

  return (
    <>
      <h1>Agents</h1>
      <p className="subtitle">connect an external agent to this NavFlow instance, and watch what they do</p>

      <div className="tabs">
        {(Object.keys(LABELS) as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{LABELS[t]}</button>
        ))}
      </div>

      {tab === "connect" && <Connect />}
      {tab === "queries" && <Queries />}
      {tab === "dispatches" && <Dispatches />}
      {tab === "subscriptions" && <Subscriptions />}
    </>
  );
}

/** Shared filter toolbar: a search box + a live "N of M" count. */
function Toolbar({ q, setQ, placeholder, shown, total }: {
  q: string; setQ: (s: string) => void; placeholder: string; shown: number; total: number;
}) {
  return (
    <div className="toolbar">
      <div className="search-box">
        <Search />
        <input type="text" className="search" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <span className="grow" />
      <span className="count">{shown} of {total}</span>
    </div>
  );
}

function Copy({ text, label = "copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="copybtn" onClick={() => { navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>
      {done ? "copied" : label}
    </button>
  );
}

function CodeBlock({ title, code }: { title: string; code: string }) {
  return (
    <div className="codeblock">
      <div className="codeblock-head"><span>{title}</span><Copy text={code} /></div>
      <pre className="payload">{code}</pre>
    </div>
  );
}

function Connect() {
  const origin = window.location.origin;
  const [authReq, setAuthReq] = useState<boolean>();
  const [status, setStatus] = useState<"checking" | "live" | "absent">("checking");
  const [url, setUrl] = useState(`${origin}/mcp`);
  const [tools, setTools] = useState<{ name: string; description: string }[]>();
  const [reveal, setReveal] = useState(false);
  const [toolQ, setToolQ] = useState("");
  const token = auth.get();

  useEffect(() => {
    api.health().then((h) => setAuthReq(h.auth_required)).catch(() => setAuthReq(false));
    api.mcpTools().then(setTools).catch(() => setTools([]));

    // The MCP endpoint sits in one of two places: same host/port behind a reverse proxy
    // (the compose deployment — Caddy routes /mcp to the MCP server), or on its own port
    // when `navflow mcp` runs as a separate process locally (the documented default, :8788).
    const loc = window.location;
    const sameOrigin = `${origin}/mcp`;
    const localPort = `${loc.protocol}//${loc.hostname}:8788/mcp`;

    const probe = async (target: string, ms = 2500): Promise<boolean> => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), ms);
      try {
        if (target === sameOrigin) {
          // same-origin: a real MCP server answers non-HTML; the SPA catch-all returns HTML.
          const r = await fetch(target, { headers: { Accept: "application/json, text/event-stream" }, signal: ctl.signal });
          return !(r.headers.get("content-type") || "").includes("text/html");
        }
        // cross-origin: the MCP server sends no CORS headers, so we can't read the response —
        // but a no-cors fetch that resolves (rather than failing on connection refused) means
        // something is listening on that port.
        await fetch(target, { mode: "no-cors", signal: ctl.signal });
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    };

    (async () => {
      if (await probe(sameOrigin)) { setUrl(sameOrigin); setStatus("live"); return; }
      if (localPort !== sameOrigin && (await probe(localPort))) { setUrl(localPort); setStatus("live"); return; }
      setStatus("absent");
    })();
  }, [origin]);
  const tok = authReq ? (token || "<your-access-token>") : "";
  const shownTok = authReq && !reveal && token ? "••••••••" : tok;

  const claudeCode = (t: string) =>
    `claude mcp add --transport http navflow ${url}` + (authReq ? ` --header "Authorization: Bearer ${t}"` : "");
  const httpJson = (t: string) => JSON.stringify({
    mcpServers: { navflow: { type: "http", url, ...(authReq ? { headers: { Authorization: `Bearer ${t}` } } : {}) } },
  }, null, 2);
  const stdioJson = (t: string) => JSON.stringify({
    mcpServers: { navflow: { command: "navflow-mcp", env: { NAVFLOWD_URL: origin, ...(authReq ? { NAVFLOW_AUTH_TOKEN: t } : {}) } } },
  }, null, 2);

  const shownTools = useMemo(() => {
    const needle = toolQ.trim().toLowerCase();
    return (tools ?? []).filter((t) =>
      !needle || t.name.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle));
  }, [tools, toolQ]);

  return (
    <div className="connect">
      <div className={`mcp-status ${status}`}>
        {status === "checking" && "checking the MCP endpoint…"}
        {status === "live" && <span>MCP endpoint is live at <span className="mono">{url}</span></span>}
        {status === "absent" && <span>No MCP endpoint found — neither at <span className="mono">{origin}/mcp</span> (reverse-proxied) nor on the default port <span className="mono">:8788</span> (separate process). Run <span className="mono">navflow mcp</span> alongside the daemon (the compose deployment includes it), or use the <strong>stdio</strong> proxy below.</span>}
      </div>

      {authReq && (
        <div className="panel" style={{ marginTop: 14 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <div><span className="lbl">access token</span> <span className="mono">{shownTok}</span></div>
            <div className="btnrow">
              <button onClick={() => setReveal((r) => !r)}>{reveal ? "hide" : "reveal"}</button>
              {token && <Copy text={token} label="copy token" />}
            </div>
          </div>
          <p className="help" style={{ marginTop: 6, whiteSpace: "normal" }}>
            This is your console access token — it works in the snippets below, but it carries{" "}
            <strong>full admin rights</strong>. For an agent, prefer a{" "}
            <span className="mono">read</span>-scoped API key from the{" "}
            <Link to="/security">Security page</Link> (add <span className="mono">ingest</span> if
            the agent also writes memories) and paste it in place of the token.
          </p>
        </div>
      )}

      <h3 style={{ marginBottom: 4 }}>Claude Code</h3>
      <CodeBlock title="run in your terminal" code={claudeCode(tok)} />

      <h3 style={{ marginBottom: 4 }}>Claude Desktop · Cursor · generic MCP client (HTTP)</h3>
      <CodeBlock title="add to the client's MCP config" code={httpJson(shownTok)} />

      <h3 style={{ marginBottom: 4 }}>stdio (agent on the same machine, or no /mcp endpoint)</h3>
      <p className="help" style={{ whiteSpace: "normal" }}>
        Requires <span className="mono">pip install navflow</span> where the agent runs; it proxies to this daemon.
      </p>
      <CodeBlock title="MCP config (stdio)" code={stdioJson(shownTok)} />

      <h3 style={{ marginTop: 22 }}>Tools the agent gets {tools && <span className="dim">· {tools.length}</span>}</h3>
      <p className="help" style={{ whiteSpace: "normal" }}>Exactly what an agent can call over MCP — read straight from this instance's MCP surface.</p>
      {tools && tools.length > 0 && (
        <>
          <div className="toolbar">
            <div className="search-box">
              <Search />
              <input type="text" className="search" placeholder="Filter tools…" value={toolQ} onChange={(e) => setToolQ(e.target.value)} />
            </div>
            <span className="grow" />
            <span className="count">{shownTools.length} of {tools.length}</span>
          </div>
          <table>
            <thead><tr><th>tool</th><th>what it does</th></tr></thead>
            <tbody>
              {shownTools.map((t) => (
                <tr key={t.name}><td className="mono">{t.name}</td><td className="help" style={{ whiteSpace: "normal" }}>{t.description}</td></tr>
              ))}
              {!shownTools.length && (
                <tr><td colSpan={2} className="dim" style={{ textAlign: "center", padding: 24 }}>no tools match “{toolQ}”</td></tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function Queries() {
  const { data, error } = usePolling(() => api.queries(150));
  const [q, setQ] = useState("");
  const [client, setClient] = useState("mcp");  // default to agent reads — the interesting traffic

  // Filter options: "all" + mcp (always, the important one) + whatever else appears (ui, http).
  const clientOpts = useMemo(
    () => ["all", ...Array.from(new Set(["mcp", ...(data ?? []).map((r) => r.client)]))],
    [data],
  );

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? []).filter((row) =>
      (client === "all" || row.client === client) &&
      (!needle || row.view.toLowerCase().includes(needle) || row.key.toLowerCase().includes(needle) ||
        row.client.toLowerCase().includes(needle)));
  }, [data, q, client]);

  if (error) return <div className="alert error">{error}</div>;
  if (!data?.length) return <div className="empty">no reads yet — connect an agent in Connect and its reads show up here.</div>;
  return (
    <>
      <div className="toolbar">
        <div className="search-box">
          <Search />
          <input type="text" className="search" placeholder="Filter by view, key, client…"
                 value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="seg small" aria-label="client">
          {clientOpts.map((c) => (
            <button key={c} className={client === c ? "active" : ""} onClick={() => setClient(c)}>{c}</button>
          ))}
        </div>
        <span className="grow" />
        <span className="count">{shown.length} of {data.length}</span>
      </div>
      {!shown.length ? (
        <div className="empty">
          no <span className="mono">{client}</span> reads{q && <> matching “{q}”</>} in the last {data.length}
          {client === "mcp" && <> — connect an agent in Connect, or switch the client filter above.</>}
        </div>
      ) : (
        <table>
          <thead><tr><th>when</th><th>client</th><th>view</th><th>key</th><th>window</th><th className="num">rows</th></tr></thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.id}>
                <td style={{ whiteSpace: "nowrap" }}><TimeAgo ts={row.queried_at} /></td>
                <td><span className={`badge ${row.client === "mcp" ? "agent" : "starting"}`}>{row.client}</span></td>
                <td className="mono">{row.view}</td>
                <td className="mono">{row.key}</td>
                <td className="mono">{row.window}</td>
                <td className="num">{row.rows_returned}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function deliveryBadge(d: DispatchLogEntry) {
  if (d.subscribers === 0) return <span className="badge starting">no subscribers</span>;
  const cls = d.delivered === d.subscribers ? "ok" : "error";
  return <span className={`badge ${cls}`}>{d.delivered}/{d.subscribers} delivered</span>;
}

function Dispatches() {
  const { data, error } = usePolling(() => api.dispatches(150));
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<DispatchLogEntry | null>(null);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? []).filter((d) =>
      !needle || d.trigger.toLowerCase().includes(needle) || d.key.toLowerCase().includes(needle) ||
      d.kind.toLowerCase().includes(needle));
  }, [data, q]);

  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSel(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel]);

  if (error) return <div className="alert error">{error}</div>;
  if (!data?.length) return <div className="empty">no trigger firings yet</div>;
  return (
    <>
      <Toolbar q={q} setQ={setQ} placeholder="Filter by trigger, key, kind…" shown={shown.length} total={data.length} />
      <table>
        <thead><tr><th>fired</th><th>trigger</th><th>key</th><th>kind</th><th>delivery</th></tr></thead>
        <tbody>
          {shown.map((d) => (
            <tr
              key={d.dispatch_id}
              className={"clickable" + (sel?.dispatch_id === d.dispatch_id ? " sel" : "")}
              onClick={() => setSel(d)}
            >
              <td style={{ whiteSpace: "nowrap" }}><TimeAgo ts={d.fired_at} /></td>
              <td className="mono">{d.trigger}</td>
              <td className="mono">{d.key}</td>
              <td className="mono">{d.kind}</td>
              <td>{deliveryBadge(d)}</td>
            </tr>
          ))}
          {!shown.length && <tr><td colSpan={5} className="dim" style={{ textAlign: "center", padding: 24 }}>no dispatches match “{q}”</td></tr>}
        </tbody>
      </table>

      {sel && (
        <>
          <div className="sheet-overlay" onClick={() => setSel(null)} />
          <aside className="sheet" role="dialog" aria-label="Dispatch detail">
            <div className="sheet-head">
              <div className="sheet-title">
                <h2><span className="mono">{sel.trigger}</span></h2>
                <span className="subtitle" style={{ margin: 0 }}>fired for <span className="mono">{sel.key}</span></span>
              </div>
              <button className="sheet-close" onClick={() => setSel(null)} aria-label="Close"><Close /></button>
            </div>
            <div className="sheet-body">
              <div className="kv">
                <span className="k">fired</span><span><TimeAgo ts={sel.fired_at} /></span>
                <span className="k">kind</span><span className="mono">{sel.kind}</span>
                <span className="k">delivery</span><span>{deliveryBadge(sel)}</span>
                <span className="k">dispatch id</span><span className="mono">{sel.dispatch_id}</span>
              </div>
              <h3 style={{ margin: "18px 0 6px" }}>Payload</h3>
              <pre className="payload">{sel.payload}</pre>
            </div>
          </aside>
        </>
      )}
    </>
  );
}

function Subscriptions() {
  const { data, error } = usePolling(() => api.subscriptions());
  const [q, setQ] = useState("");

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? []).filter((s) =>
      !needle || s.trigger.toLowerCase().includes(needle) || s.url.toLowerCase().includes(needle));
  }, [data, q]);

  if (error) return <div className="alert error">{error}</div>;
  if (!data?.length) return <div className="empty">no webhook subscriptions — agents subscribe via the MCP `subscribe` tool</div>;
  return (
    <>
      <Toolbar q={q} setQ={setQ} placeholder="Filter by trigger, url…" shown={shown.length} total={data.length} />
      <table>
        <thead><tr><th>id</th><th>trigger</th><th>webhook url</th><th>created</th></tr></thead>
        <tbody>
          {shown.map((s) => (
            <tr key={s.subscription_id}>
              <td className="mono">{s.subscription_id}</td>
              <td className="mono">{s.trigger}</td>
              <td className="mono">{s.url}</td>
              <td><TimeAgo ts={s.created_at} /></td>
            </tr>
          ))}
          {!shown.length && <tr><td colSpan={4} className="dim" style={{ textAlign: "center", padding: 24 }}>no subscriptions match “{q}”</td></tr>}
        </tbody>
      </table>
    </>
  );
}

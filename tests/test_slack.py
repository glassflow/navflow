"""Slack as a first-class dispatch sink — `slack://channel/<id>` alongside webhooks and agents.

End-to-end against a stub Slack API (TARES_SLACK_API_BASE): configure a bot token, subscribe a
channel to a trigger, ingest until the trigger fires, and assert the channel behaves like any other
subscriber — it appears in the roster, its delivery lands in the ledger and is counted by
`GET /api/agents`, and the message itself is Block Kit with a text fallback and a deep link.

The failure modes are the point of the ticket, so they are asserted directly: `invalid_auth` and
`channel_not_found` come back as HTTP 200 with `{"ok": false}`, and must fail on the FIRST attempt
with that reason in the ledger — not five timeouts. A transient Slack fault must still retry.

The token is a credential: it is write-only over the API, and the environment beats the stored one.
"""
import asyncio, json, os, signal, subprocess, sys, threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import httpx

P = F = 0
def ck(l, c, d=""):
    global P, F; P += 1 if c else 0; F += 0 if c else 1
    print(("  ok   " if c else "  FAIL ") + l + ("" if c else f"  {d}"))

SEED = "/tmp/slack_catalog.yaml"
with open(SEED, "w") as fh:
    fh.write(
        "sources:\n  - name: evt\n    connector: webhook\n    poll: 5s\n"
        "    config:\n      labels:\n        - name: service\n          field: service\n"
        "          primary: true\n"
        "views:\n  - name: svc\n    key_field: service\n    sources: [evt]\n"
        # short cooldown: the same entity has to be able to fire again for each failure mode below
        "triggers:\n  - name: incident\n    view: svc\n    cooldown: 1s\n"
        "    condition:\n      aggregate: count\n      predicate: '>= 2'\n      window: 1m\n")

DB, PORT, STUB_PORT = "/tmp/slack.duckdb", "8810", "8811"
CHANNEL = "C0123456789"
TOKEN = "xoxb-stored-test-token"
ENV_TOKEN = "xoxb-env-test-token"
PUBLIC_URL = "https://tares.example.com"

# ── stub Slack: chat.postMessage, with the reply switchable per phase ────────
# Slack answers HTTP 200 with {"ok": false, "error": ...} for nearly everything that goes wrong,
# which is exactly why the sink can't read the status code alone.
CALLS: list = []
MODE = "ok"


class Stub(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        CALLS.append({"path": self.path, "body": body,
                      "auth": self.headers.get("authorization", "")})
        out = ({"ok": True, "channel": body.get("channel"), "ts": "1700000000.000100"}
               if MODE == "ok" else {"ok": False, "error": MODE})
        raw = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *a):
        pass


async def _wait(url, tries=80):
    for _ in range(tries):
        try:
            async with httpx.AsyncClient() as cx:
                if (await cx.get(url, timeout=1)).status_code == 200:
                    return True
        except Exception:
            pass
        await asyncio.sleep(0.25)
    return False


async def _until(fn, tries=60):
    for _ in range(tries):
        if await fn():
            return True
        await asyncio.sleep(0.5)
    return False


def _spawn(env):
    return subprocess.Popen([sys.executable, "-c", "from tares.cli import run_daemon; run_daemon()"],
                            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _stop(proc):
    proc.send_signal(signal.SIGTERM)
    try: proc.wait(timeout=5)
    except Exception: proc.kill()


B = f"http://127.0.0.1:{PORT}"


async def _slack_row(cx):
    for a in (await cx.get(f"{B}/api/agents")).json()["agents"]:
        if a["kind"] == "slack":
            return a
    return None


async def _fire(cx, n=3, tag=""):
    """Push enough events to satisfy `count >= 2 over 1m` for one entity."""
    for i in range(n):
        await cx.post(f"{B}/ingest/evt", json={"service": "checkout", "msg": f"500 {tag}#{i}"})


async def main():
    global MODE
    for p in (DB, DB + ".wal"):
        if os.path.exists(p):
            os.remove(p)

    stub = HTTPServer(("127.0.0.1", int(STUB_PORT)), Stub)
    threading.Thread(target=stub.serve_forever, daemon=True).start()

    base_env = {**os.environ, "TARES_DB": DB, "TARES_CATALOG": SEED, "TARES_PORT": PORT,
                "TARES_OTLP_GRPC_PORT": "off",
                "TARES_SLACK_API_BASE": f"http://127.0.0.1:{STUB_PORT}",
                "TARES_PUBLIC_URL": PUBLIC_URL,
                "TARES_TRIGGER_DEBOUNCE_SECONDS": "0"}
    base_env.pop("TARES_SLACK_BOT_TOKEN", None)     # phase 1 stores one through the API instead
    proc = _spawn(base_env)
    try:
        if not await _wait(f"{B}/health"):
            ck("daemon up", False); return
        async with httpx.AsyncClient(timeout=20) as cx:
            # ── the bot token: write-only, and required before a channel can subscribe ──
            st = (await cx.get(f"{B}/api/settings/slack-bot-token")).json()
            ck("no token configured to start with", st["configured"] is False and st["stored"] is False, str(st))

            r = await cx.post(f"{B}/subscribe", json={"trigger": "incident",
                                                      "url": f"slack://channel/{CHANNEL}"})
            ck("subscribing a channel with no token is rejected (400)", r.status_code == 400, r.text)
            ck("...and says why", "token" in r.text.lower(), r.text)

            r = await cx.put(f"{B}/api/settings/slack-bot-token", json={"token": "https://hooks.slack.com/x"})
            ck("a pasted webhook URL is not accepted as a bot token", r.status_code == 400, r.text)

            r = await cx.put(f"{B}/api/settings/slack-bot-token", json={"token": TOKEN})
            ck("PUT token -> 200", r.status_code == 200, r.text)
            ck("PUT never echoes the token", TOKEN not in r.text, r.text)
            st = (await cx.get(f"{B}/api/settings/slack-bot-token")).json()
            ck("token reported configured from the console", st["configured"] and st["source"] == "console", str(st))
            ck("token value is never returned", TOKEN not in json.dumps(st), str(st))
            caps = (await cx.get(f"{B}/api/capabilities")).json()
            ck("capabilities advertises Slack as configured", caps.get("slack_configured") is True, str(caps))

            # ── subscribing a channel ────────────────────────────────────────
            r = await cx.post(f"{B}/subscribe", json={"trigger": "incident", "url": "slack://channel/not a channel!"})
            ck("a malformed channel is rejected (400)", r.status_code == 400, r.text)
            r = await cx.post(f"{B}/subscribe", json={"trigger": "nope", "url": f"slack://channel/{CHANNEL}"})
            ck("an unknown trigger is still a 404", r.status_code == 404, str(r.status_code))

            r = await cx.post(f"{B}/subscribe", json={"trigger": "incident",
                                                      "url": f"slack://channel/{CHANNEL}"})
            ck("subscribe a channel -> 200", r.status_code == 200, r.text)

            row = await _slack_row(cx)
            ck("the channel is in the roster", row is not None, str(row))
            ck("roster tags it kind=slack", row and row["kind"] == "slack", str(row))
            ck("roster names it by channel, not by raw URL",
               row and row["name"] == f"#{CHANNEL}" and "slack://" not in row["endpoint"], str(row))
            ck("roster shows it woken by the trigger", row and "incident" in row["triggers"], str(row))

            # ── it delivers ──────────────────────────────────────────────────
            CALLS.clear()
            await _fire(cx, tag="ok ")
            ck("a firing posts to Slack", await _until(lambda: asyncio.sleep(0, result=bool(CALLS))),
               "no chat.postMessage received")
            call = CALLS[0] if CALLS else {"body": {}, "auth": "", "path": ""}
            ck("posted to chat.postMessage", call["path"].endswith("/chat.postMessage"), call["path"])
            ck("authenticated with the bot token", call["auth"] == f"Bearer {TOKEN}", call["auth"])
            ck("addressed the subscribed channel", call["body"].get("channel") == CHANNEL, str(call["body"])[:200])
            blocks = json.dumps(call["body"].get("blocks") or [])
            ck("message is Block Kit", bool(call["body"].get("blocks")), str(call["body"])[:200])
            ck("message has a plain-text fallback for notifications",
               "incident" in str(call["body"].get("text", "")), str(call["body"].get("text")))
            ck("blocks name the trigger and the entity",
               "incident" in blocks and "checkout" in blocks, blocks[:300])
            ck("blocks carry a deep link when TARES_PUBLIC_URL is set",
               f"{PUBLIC_URL}/explore?key=checkout" in blocks, blocks[:400])

            async def _counted():
                a = await _slack_row(cx)
                return bool(a) and a.get("delivered_ok_24h", 0) >= 1
            ck("GET /api/agents counts the delivery", await _until(_counted), str(await _slack_row(cx)))

            disp = (await cx.get(f"{B}/api/activity/dispatches")).json()[0]
            detail = (await cx.get(f"{B}/api/activity/dispatches/{disp['dispatch_id']}")).json()
            dv = next((d for d in detail.get("deliveries", []) if d["agent"] == f"#{CHANNEL}"), None)
            ck("the firing's ledger lists the channel as delivered", dv is not None and dv["ok"], str(detail)[:300])

            # ── a revoked token is DEFINITIVE: one attempt, readable reason ──
            for mode, needle in (("invalid_auth", "invalid_auth"), ("channel_not_found", "channel_not_found")):
                before = (await _slack_row(cx)).get("delivered_fail_total", 0)
                MODE = mode
                CALLS.clear()
                await asyncio.sleep(1.2)          # clear the trigger's per-entity cooldown
                await _fire(cx, tag=mode + " ")

                async def _failed():
                    a = await _slack_row(cx)
                    return bool(a) and a.get("delivered_fail_total", 0) > before
                ck(f"{mode}: the delivery is recorded as failed", await _until(_failed), str(await _slack_row(cx)))
                a = await _slack_row(cx)
                ck(f"{mode}: the ledger carries the reason", needle in str(a.get("last_error") or ""),
                   str(a.get("last_error")))
                ck(f"{mode}: the endpoint reads as failing", a.get("unhealthy") is True, str(a))
                # the whole point: 5 attempts of backoff would take ~15s and bury the reason
                ck(f"{mode}: tried exactly once, not five times", len(CALLS) == 1, f"{len(CALLS)} attempts")

            # ── a transient Slack fault DOES retry ───────────────────────────
            MODE = "internal_error"
            CALLS.clear()
            await asyncio.sleep(1.2)
            await _fire(cx, tag="transient ")
            ck("a transient Slack error is retried", await _until(lambda: asyncio.sleep(0, result=len(CALLS) >= 2), tries=20),
               f"{len(CALLS)} attempts")
            MODE = "ok"
    finally:
        _stop(proc)

    # ── the environment beats the stored token ──────────────────────────────
    # An operator's deployment config must never be silently overridden by something typed into the
    # console months earlier — the same rule the Anthropic key follows.
    env2 = {**base_env, "TARES_SLACK_BOT_TOKEN": ENV_TOKEN}
    proc = _spawn(env2)
    try:
        if not await _wait(f"{B}/health"):
            ck("daemon back up", False)
        else:
            async with httpx.AsyncClient(timeout=20) as cx:
                st = (await cx.get(f"{B}/api/settings/slack-bot-token")).json()
                ck("env token wins over the stored one",
                   st["source"] == "env:TARES_SLACK_BOT_TOKEN" and st["env_overrides"] is True, str(st))
                ck("the console is told a stored token exists but is unused", st["stored"] is True, str(st))
                ck("neither token is ever returned",
                   TOKEN not in json.dumps(st) and ENV_TOKEN not in json.dumps(st), str(st))

                CALLS.clear()
                await _fire(cx, tag="env ")
                ck("deliveries use the env token",
                   await _until(lambda: asyncio.sleep(0, result=bool(CALLS)), tries=30)
                   and CALLS[0]["auth"] == f"Bearer {ENV_TOKEN}",
                   str(CALLS[:1])[:200])

                r = await cx.delete(f"{B}/api/settings/slack-bot-token")
                ck("DELETE clears the stored token", r.status_code == 200, r.text)
                st = (await cx.get(f"{B}/api/settings/slack-bot-token")).json()
                ck("still configured afterwards — the env token remains",
                   st["configured"] is True and st["stored"] is False, str(st))
    finally:
        _stop(proc)
        stub.shutdown()

    print(f"\n{P} passed, {F} failed")
    raise SystemExit(1 if F else 0)


asyncio.run(main())

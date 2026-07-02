"""Agent-driven source setup over MCP — exercises the MCP tools against a real navflowd:
list_connectors -> create_source -> (data flows) -> list_sources -> derive -> query.
"""
import asyncio, os, signal, subprocess, sys, time

DB = "/tmp/mcp_setup.duckdb"
PORT = "8796"
for _p in (DB, DB + ".wal"):
    if os.path.exists(_p):
        os.remove(_p)

env = {**os.environ, "NAVFLOW_DB": DB, "NAVFLOW_CATALOG": "/tmp/none.yaml",
       "NAVFLOW_PORT": PORT, "NAVFLOW_OTLP_GRPC_PORT": "off"}
proc = subprocess.Popen([sys.executable, "-c", "from navflow.cli import run_daemon; run_daemon()"],
                        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

# NAVFLOWD_URL must be set before importing the MCP server (it reads it at import time)
os.environ["NAVFLOWD_URL"] = f"http://127.0.0.1:{PORT}"
import httpx
import json as _json

P = F = 0
def ck(l, c, d=""):
    global P, F; P += 1 if c else 0; F += 0 if c else 1
    print(("  ok   " if c else "  FAIL ") + l + ("" if c else f"  {d}"))


async def wait_health():
    for _ in range(80):
        try:
            async with httpx.AsyncClient() as cx:
                if (await cx.get(f"http://127.0.0.1:{PORT}/health", timeout=1)).status_code == 200:
                    return True
        except Exception:
            pass
        await asyncio.sleep(0.25)
    return False


async def main():
    if not await wait_health():
        ck("daemon started", False, "health never came up"); return
    import navflow.mcp_server as m

    conns = _json.loads(await m.list_connectors())
    ck("list_connectors lists webhook + otlp + github", {"webhook", "otlp", "github"} <= set(conns))

    # an agent stands up its own source
    res = _json.loads(await m.create_source(
        "evt", "webhook",
        {"event_type": "log", "text_template": "{msg}",
         "labels": [{"name": "app", "field": "app", "primary": True}]}))
    ck("create_source -> ok", res.get("ok") is True, str(res))

    # data flows in (an external producer posts; not an agent action)
    async with httpx.AsyncClient() as cx:
        for app, msg in [("checkout", "boom"), ("checkout", "boom2"), ("search", "ok")]:
            await cx.post(f"http://127.0.0.1:{PORT}/ingest/evt", json={"app": app, "msg": msg})

    srcs = {s["name"]: s for s in _json.loads(await m.list_sources())}
    ck("list_sources shows the created source ingesting", (srcs.get("evt", {}).get("health") or {}).get("events_total") == 3, str(srcs.get("evt", {}).get("health")))

    desc = _json.loads(await m.catalog_describe("source:evt"))
    ck("catalog_describe shows the app label axis", "app" in desc.get("labels", {}), str(list(desc.get("labels", {}))))

    # the agent derives a view over its new source and reads it back
    _json.loads(await m.derive(["evt"], "app", "evt_view"))
    payload = await m.query("evt_view", where={"app": "checkout"})
    ck("query the agent-created source via MCP", "boom" in payload and "ok" not in payload.split("boom")[0], payload[:120])

    # discovery over MCP (best-effort live github)
    try:
        prop = _json.loads(await m.discover_source("github", {"repo": "octocat/Hello-World"}))
        ck("discover_source(github) returns a proposed_config", "proposed_config" in prop, str(list(prop)))
    except Exception as e:
        print(f"  skip discover_source live ({e})")

    print(f"\n{P} passed, {F} failed")


try:
    asyncio.run(main())
finally:
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()
sys.exit(1 if F else 0)

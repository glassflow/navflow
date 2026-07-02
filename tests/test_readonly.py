"""Read-only / demo mode. Two planes: the control plane (authoring via UI/MCP) is refused; the
data plane (ingest from real push services) stays open. Plus an optional ingest token, and the
MCP write/setup tools aren't registered.
"""
import asyncio, os, signal, subprocess, sys

os.environ["NAVFLOW_READONLY"] = "1"   # set before importing mcp_server (read at import)
import httpx

P = F = 0
def ck(l, c, d=""):
    global P, F; P += 1 if c else 0; F += 0 if c else 1
    print(("  ok   " if c else "  FAIL ") + l + ("" if c else f"  {d}"))

# a catalog with a webhook source, so ingest has a real target
SEED = "/tmp/ro_catalog.yaml"
with open(SEED, "w") as fh:
    fh.write("sources:\n  - name: evt\n    connector: webhook\n    poll: 5s\n"
             "    config:\n      labels: [{name: app, field: app, primary: true}]\n")


async def _wait(url, ok=lambda r: r.status_code == 200):
    for _ in range(80):
        try:
            async with httpx.AsyncClient() as cx:
                if ok(await cx.get(url, timeout=1)):
                    return True
        except Exception:
            pass
        await asyncio.sleep(0.25)
    return False


def _daemon(port, db, extra_env):
    for p in (db, db + ".wal"):
        if os.path.exists(p):
            os.remove(p)
    env = {**os.environ, "NAVFLOW_DB": db, "NAVFLOW_CATALOG": SEED, "NAVFLOW_PORT": port,
           "NAVFLOW_OTLP_GRPC_PORT": "off", **extra_env}
    return subprocess.Popen([sys.executable, "-c", "from navflow.cli import run_daemon; run_daemon()"],
                            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


async def test_mcp_tools_gated():
    import navflow.mcp_server as m
    try:
        tools = {t.name for t in await m.mcp.list_tools()}
    except Exception:
        tools = set(m.mcp._tool_manager._tools)
    reads = {"query", "catalog_list", "catalog_describe", "list_connectors", "list_sources"}
    writes = {"subscribe", "derive", "remember", "discover_source", "discover_docker",
              "test_source", "create_source"}
    ck("read tools present in read-only MCP", reads <= tools, str(reads - tools))
    ck("write/setup tools NOT registered in read-only MCP", not (writes & tools), str(writes & tools))


async def test_two_planes():
    proc = _daemon("8799", "/tmp/ro.duckdb", {"NAVFLOW_READONLY": "1"})
    B = "http://127.0.0.1:8799"
    try:
        if not await _wait(f"{B}/health"):
            ck("daemon up", False); return
        async with httpx.AsyncClient() as cx:
            ck("health advertises read-only", (await cx.get(f"{B}/health")).json().get("readonly") is True)
            ck("GET reads allowed", (await cx.get(f"{B}/api/connectors")).status_code == 200)
            ck("POST /query allowed (read)", (await cx.post(f"{B}/query", json={"view": "x"})).status_code != 403)
            # control plane refused
            for verb, path, body in [
                ("post", "/api/sources", {"name": "x", "connector": "webhook", "config": {}}),
                ("post", "/derive", {"sources": ["evt"], "key_field": "app"}),
                ("post", "/remember", {"key": "k", "content": "c"}),
                ("delete", "/api/sources/evt", None),
                ("post", "/api/sources/discover", {"connector": "github", "config": {}}),
            ]:
                r = await (getattr(cx, verb)(f"{B}{path}", json=body) if body is not None
                           else getattr(cx, verb)(f"{B}{path}"))
                ck(f"control plane: {verb.upper()} {path} -> 403", r.status_code == 403, str(r.status_code))
            # data plane stays open
            ig = await cx.post(f"{B}/ingest/evt", json={"app": "checkout", "msg": "hi"})
            ck("data plane: POST /ingest/evt accepted in read-only", ig.status_code == 202, str(ig.status_code))
            ck("OTLP ingest not blocked by read-only", (await cx.post(f"{B}/v1/logs", json={})).status_code != 403)
    finally:
        proc.send_signal(signal.SIGTERM)
        try: proc.wait(timeout=5)
        except Exception: proc.kill()


async def test_ingest_token():
    proc = _daemon("8800", "/tmp/ro_tok.duckdb", {"NAVFLOW_READONLY": "1", "NAVFLOW_INGEST_TOKEN": "s3cret"})
    B = "http://127.0.0.1:8800"
    try:
        if not await _wait(f"{B}/health"):
            ck("token daemon up", False); return
        async with httpx.AsyncClient() as cx:
            ck("ingest without token -> 401", (await cx.post(f"{B}/ingest/evt", json={"app": "a"})).status_code == 401)
            r = await cx.post(f"{B}/ingest/evt", json={"app": "a"}, headers={"X-NavFlow-Token": "s3cret"})
            ck("ingest with X-NavFlow-Token -> 202", r.status_code == 202, str(r.status_code))
            r = await cx.post(f"{B}/ingest/evt", json={"app": "a"}, headers={"Authorization": "Bearer s3cret"})
            ck("ingest with Bearer token -> 202", r.status_code == 202, str(r.status_code))
            ck("reads still need no token", (await cx.get(f"{B}/health")).status_code == 200)
    finally:
        proc.send_signal(signal.SIGTERM)
        try: proc.wait(timeout=5)
        except Exception: proc.kill()


async def main():
    await test_mcp_tools_gated()
    await test_two_planes()
    await test_ingest_token()
    print(f"\n{P} passed, {F} failed")

asyncio.run(main())
sys.exit(1 if F else 0)

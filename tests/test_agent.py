"""In-app agent — tool surface + the endpoint requires a key (the live LLM loop is tested manually)."""
import asyncio, os

os.environ["NAVFLOW_DB"] = "/tmp/agent_t.duckdb"
os.environ["NAVFLOW_CATALOG"] = "/tmp/none_agent.yaml"
for _p in ("/tmp/agent_t.duckdb", "/tmp/agent_t.duckdb.wal"):
    if os.path.exists(_p):
        os.remove(_p)
import httpx
from navflow import agent

P = F = 0
def ck(l, c, d=""):
    global P, F; P += 1 if c else 0; F += 0 if c else 1
    print(("  ok   " if c else "  FAIL ") + l + ("" if c else f"  {d}"))

names = {t["name"] for t in agent.TOOLS}
ck("tools cover the read surface", {"list_sources", "describe", "source_fields", "entities", "query"} <= names, str(names))
ck("agent can author views (create_view)", "create_view" in names, str(names))
ck("every tool has a schema", all("input_schema" in t for t in agent.TOOLS))
ck("one adaptive system prompt covers understand + debug",
   "UNDERSTAND" in agent.system_prompt() and "DEBUG" in agent.system_prompt())

from navflow.daemon import make_app
async def main():
    app = make_app()
    async with app.router.lifespan_context(app):
        cx = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")
        r = await cx.post("/api/agent/chat", json={"messages": [{"role": "user", "content": "hi"}]})
        ck("endpoint requires an Anthropic key (400)", r.status_code == 400, r.text)
        await cx.aclose()
    print(f"\n{P} passed, {F} failed"); raise SystemExit(1 if F else 0)
asyncio.run(main())

"""End-to-end test for the use-case framework (recipes, instances, ownership, engine, API, YAML).

Run: .venv/bin/python tests/test_usecases.py   (no external services needed)

Uses a tests-only recipe (two webhook sources, a view, a trigger, an agent, an MCP server) so it
exercises every object kind without depending on a real recipe.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB = "/tmp/tares-usecases-test.duckdb"
CATALOG = "/tmp/tares-usecases-test.catalog.yaml"
os.environ["TARES_DB"] = DB
os.environ["TARES_CATALOG"] = CATALOG

import httpx

from tares.usecases import PlannedObject, Recipe, register
from tares.usecases.registry import unregister

PASS = FAIL = 0


def check(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f"  ok   {label}")
    else:
        FAIL += 1; print(f"  FAIL {label}  {detail}")


class DemoRecipe(Recipe):
    key = "test_demo"
    title = "Test demo"
    description = "two webhook sources keyed by app, one view, one trigger, one agent, one mcp server"
    PARAMS = {"apps": {"type": "list", "required": True, "help": "app names"},
              "prefix": {"type": "string", "default": "t"},
              "fail": {"type": "boolean", "default": False, "help": "plan an invalid trigger"}}

    def plan(self, params):
        p = params["prefix"]
        objs = []
        for app in params["apps"]:
            objs.append(PlannedObject("source", f"source:{app}", {
                "name": f"{p}_{app}", "connector": "webhook", "poll": "5s",
                "config": {"event_type": "log", "text_template": "{msg}",
                           "labels": [{"name": "app", "const": app, "primary": True}]}}))
        objs.append(PlannedObject("view", "view", {
            "name": f"{p}_view", "key_field": "app",
            "sources": [f"{p}_{a}" for a in params["apps"]]}))
        cond = {"aggregate": "count", "predicate": "> 0" if not params["fail"] else "nope",
                "window": "5m", "group_by": ["key_value"]}
        objs.append(PlannedObject("trigger", "trigger", {
            "name": f"{p}_trigger", "view": f"{p}_view", "condition": cond,
            "emit": {"kind": "demo"}, "cooldown": "1m"}))
        objs.append(PlannedObject("mcp_server", "mcp", {
            "name": f"{p}_mcp", "url": "https://example.invalid/mcp"}))
        objs.append(PlannedObject("agent", "agent", {
            "name": f"{p}_agent", "trigger": f"{p}_trigger", "prompt": "say hi",
            "mcp_servers": [f"{p}_mcp"], "enabled": False}))
        return objs

    def summary(self, instance, store):
        return {"apps": instance["params"]["apps"]}


register(DemoRecipe())


async def main():
    for p in (DB, DB + ".wal", CATALOG):
        if os.path.exists(p):
            os.remove(p)

    from tares.daemon import make_app
    app = make_app()

    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as cx:

            print("== recipes ==")
            r = await cx.get("/api/usecases/recipes")
            keys = [x["key"] for x in r.json()["recipes"]]
            check("test recipe listed with params", "test_demo" in keys and
                  any("apps" in x["params"] for x in r.json()["recipes"]), r.text)

            print("== create ==")
            r = await cx.post("/api/usecases", json={"recipe": "nope", "params": {}})
            check("unknown recipe -> 400", r.status_code == 400, r.text)
            r = await cx.post("/api/usecases", json={"recipe": "test_demo", "params": {}})
            check("missing required param -> 400", r.status_code == 400, r.text)
            r = await cx.post("/api/usecases", json={
                "recipe": "test_demo", "name": "demo one", "params": {"apps": ["ui", "api"]}})
            check("create -> 201", r.status_code == 201, r.text)
            inst = r.json(); uid = inst["id"]
            kinds = sorted(o["kind"] for o in inst["objects"])
            check("six objects owned", kinds == ["agent", "mcp_server", "source", "source",
                                                 "trigger", "view"], str(kinds))
            check("status active, no error", inst["status"] == "active" and not inst["last_error"])
            r = await cx.post("/api/usecases", json={
                "recipe": "test_demo", "name": "demo one", "params": {"apps": ["x"]}})
            check("duplicate name -> 400", r.status_code == 400, r.text)

            print("== objects are ordinary and carry owned_by ==")
            srcs = {s["name"]: s for s in (await cx.get("/api/sources")).json()}
            check("sources exist and are owned", srcs["t_ui"]["owned_by"] == uid
                  and srcs["t_api"]["owned_by"] == uid and not srcs["t_ui"]["customized"],
                  str({k: (v.get("owned_by"), v.get("customized")) for k, v in srcs.items()}))
            views = {v["name"]: v for v in (await cx.get("/api/views")).json()}
            check("view owned", views["t_view"]["owned_by"] == uid)
            trig = {t["name"]: t for t in (await cx.get("/api/triggers")).json()}
            check("trigger owned", trig["t_trigger"]["owned_by"] == uid)
            ag = {a["name"]: a for a in (await cx.get("/api/agents/builtin")).json()["agents"]}
            check("agent owned and disabled", ag["t_agent"]["owned_by"] == uid
                  and ag["t_agent"]["enabled"] is False)
            mcp = {m["name"]: m for m in (await cx.get("/api/mcp-servers")).json()["servers"]}
            check("mcp server owned", mcp["t_mcp"]["owned_by"] == uid)
            # the source works like any source: ingest lands
            r = await cx.post(f"/ingest/{srcs['t_ui']['ingest_key']}", json={"msg": "hello"})
            check("owned source ingests", r.status_code == 202, r.text)
            r = await cx.get(f"/api/usecases/{uid}/summary")
            check("summary merges recipe summary + log",
                  r.json().get("apps") == ["ui", "api"] and
                  any(l["action"] == "created" for l in r.json()["log"]), r.text[:300])

            print("== customized protection ==")
            body = {**views["t_view"], "sources": ["t_ui"]}
            r = await cx.put("/api/views/t_view", json={"name": "t_view", "key_field": "app",
                                                        "sources": ["t_ui"], "filters": []})
            check("hand edit of an owned view is allowed", r.status_code == 200, r.text)
            v = {v["name"]: v for v in (await cx.get("/api/views")).json()}["t_view"]
            check("edited view flagged customized", v["customized"] is True and v["owned_by"] == uid)

            print("== update: add and remove ==")
            r = await cx.put(f"/api/usecases/{uid}", json={"params": {"apps": ["ui", "web"]}})
            check("update -> 200", r.status_code == 200, r.text)
            rep = r.json()["report"]
            check("report: created web, deleted api, kept view",
                  "source:t_web" in rep["created"] and "source:t_api" in rep["deleted"]
                  and "view:t_view" in rep["kept"], str(rep))
            names = {s["name"] for s in (await cx.get("/api/sources")).json()}
            check("t_api gone, t_web present", "t_api" not in names and "t_web" in names, str(names))
            v = {v["name"]: v for v in (await cx.get("/api/views")).json()}["t_view"]
            check("customized view kept the user's sources", v["sources"] == ["t_ui"], str(v))

            print("== repair ==")
            r = await cx.delete("/api/triggers/t_trigger")
            check("hand delete of an owned trigger is allowed", r.status_code == 200, r.text)
            inst = (await cx.get(f"/api/usecases/{uid}")).json()
            miss = {o["key"]: o["missing"] for o in inst["objects"]}
            check("instance reports the trigger missing", miss.get("trigger") is True, str(miss))
            r = await cx.post(f"/api/usecases/{uid}/repair", json={"key": "trigger"})
            check("repair -> 200", r.status_code == 200, r.text)
            trig = {t["name"] for t in (await cx.get("/api/triggers")).json()}
            check("trigger re-created", "t_trigger" in trig, str(trig))
            r = await cx.post(f"/api/usecases/{uid}/repair", json={"key": "view"})
            v = {v["name"]: v for v in (await cx.get("/api/views")).json()}["t_view"]
            check("repair resets a customized view to the plan",
                  sorted(v["sources"]) == ["t_ui", "t_web"] and v["customized"] is False, str(v))

            print("== pause / resume ==")
            r = await cx.post(f"/api/usecases/{uid}/pause")
            check("pause -> paused", r.json()["status"] == "paused", r.text)
            t = {t["name"]: t for t in (await cx.get("/api/triggers")).json()}["t_trigger"]
            check("owned trigger paused", t["paused"] is True)
            r = await cx.post(f"/api/usecases/{uid}/resume")
            t = {t["name"]: t for t in (await cx.get("/api/triggers")).json()}["t_trigger"]
            check("resume -> active, trigger running",
                  r.json()["status"] == "active" and t["paused"] is False)

            print("== all-or-nothing create ==")
            before = {s["name"] for s in (await cx.get("/api/sources")).json()}
            r = await cx.post("/api/usecases", json={
                "recipe": "test_demo", "name": "broken",
                "params": {"apps": ["z"], "prefix": "b", "fail": True}})
            check("invalid plan -> 400", r.status_code == 400, r.text)
            after = {s["name"] for s in (await cx.get("/api/sources")).json()}
            check("nothing created by the failed create", before == after, str(after - before))
            bad = [u for u in (await cx.get("/api/usecases")).json()["usecases"]
                   if u["name"] == "broken"]
            check("failed instance kept with status error + last_error",
                  bad and bad[0]["status"] == "error" and bad[0]["last_error"], str(bad))
            await cx.delete(f"/api/usecases/{bad[0]['id']}")

            print("== ownership conflict ==")
            r = await cx.post("/api/usecases", json={
                "recipe": "test_demo", "name": "clash", "params": {"apps": ["ui"]}})
            check("a plan may not take another use case's object", r.status_code == 400
                  and "another use case" in r.text, r.text)
            clash = [u for u in (await cx.get("/api/usecases")).json()["usecases"]
                     if u["name"] == "clash"]
            if clash:
                await cx.delete(f"/api/usecases/{clash[0]['id']}")

            print("== export / import round trip ==")
            y = (await cx.get("/api/catalog/export")).text
            check("export has a usecases section with params",
                  "usecases:" in y and "recipe: test_demo" in y and "apps:" in y, y[-400:])
            r = await cx.post("/api/catalog/import", json={"yaml": y, "mode": "merge"})
            check("re-import of the export is idempotent", r.status_code == 200
                  and r.json()["usecases"] == 1, r.text)
            check("still one instance", len((await cx.get("/api/usecases")).json()["usecases"]) == 1)
            r = await cx.post("/api/catalog/import", json={"yaml":
                "usecases:\n  - recipe: test_demo\n    name: yaml one\n    params: {apps: [q], prefix: y}\n"})
            check("import creates a new instance from YAML", r.status_code == 200, r.text)
            ucs = {u["name"]: u for u in (await cx.get("/api/usecases")).json()["usecases"]}
            check("yaml one exists and owns y_q", "yaml one" in ucs and
                  any(o["name"] == "y_q" for o in ucs["yaml one"]["objects"]), str(list(ucs)))

            print("== delete ==")
            r = await cx.delete(f"/api/usecases/{uid}?purge_events=true")
            check("delete -> ok", r.status_code == 200 and r.json()["ok"], r.text)
            names = {s["name"] for s in (await cx.get("/api/sources")).json()}
            check("owned sources removed", not ({"t_ui", "t_web"} & names), str(names))
            trig = {t["name"] for t in (await cx.get("/api/triggers")).json()}
            check("owned trigger removed", "t_trigger" not in trig)
            check("instance gone", (await cx.get(f"/api/usecases/{uid}")).status_code == 404)
            check("unknown id -> 404", (await cx.delete("/api/usecases/uc_nope")).status_code == 404)
            # leave the catalog empty so the next boot seeds from YAML (the store stays open, so the
            # file cannot be removed here)
            await cx.delete(f"/api/usecases/{ucs['yaml one']['id']}")
            check("catalog empty again", (await cx.get("/api/sources")).json() == [])

    print("== YAML seed on an empty catalog ==")
    with open(CATALOG, "w") as f:
        f.write("usecases:\n  - recipe: test_demo\n    name: seeded\n"
                "    params: {apps: [a, b], prefix: s}\n")
    app2 = make_app()
    async with app2.router.lifespan_context(app2):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app2),
                                     base_url="http://test") as cx:
            ucs = (await cx.get("/api/usecases")).json()["usecases"]
            check("seeded instance exists", len(ucs) == 1 and ucs[0]["name"] == "seeded", str(ucs))
            names = {s["name"] for s in (await cx.get("/api/sources")).json()}
            check("seeded objects exist and are owned", {"s_a", "s_b"} <= names, str(names))
    os.remove(CATALOG)
    unregister("test_demo")

    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


asyncio.run(main())

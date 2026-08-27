"""End-to-end test for the project framework (templates, instances, ownership, engine, API, YAML).

Run: .venv/bin/python tests/test_projects.py   (no external services needed)

Uses a tests-only template (two webhook sources, a view, a trigger, an agent, an MCP server) so it
exercises every object kind without depending on a real template.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB = "/tmp/tares-projects-test.duckdb"
CATALOG = "/tmp/tares-projects-test.catalog.yaml"
os.environ["TARES_DB"] = DB
os.environ["TARES_CATALOG"] = CATALOG

import httpx

from tares.projects import PlannedObject, Template, register
from tares.projects.registry import unregister

PASS = FAIL = 0


def check(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f"  ok   {label}")
    else:
        FAIL += 1; print(f"  FAIL {label}  {detail}")


class DemoTemplate(Template):
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


register(DemoTemplate())


async def main():
    for p in (DB, DB + ".wal", CATALOG):
        if os.path.exists(p):
            os.remove(p)

    from tares.daemon import make_app
    app = make_app()

    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as cx:

            print("== templates ==")
            r = await cx.get("/api/projects/templates")
            keys = [x["key"] for x in r.json()["templates"]]
            check("test template listed with params", "test_demo" in keys and
                  any("apps" in x["params"] for x in r.json()["templates"]), r.text)

            print("== create ==")
            r = await cx.post("/api/projects", json={"template": "nope", "params": {}})
            check("unknown template -> 400", r.status_code == 400, r.text)
            r = await cx.post("/api/projects", json={"template": "test_demo", "params": {}})
            check("missing required param -> 400", r.status_code == 400, r.text)
            r = await cx.post("/api/projects", json={
                "template": "test_demo", "name": "demo one", "params": {"apps": ["ui", "api"]}})
            check("create -> 201", r.status_code == 201, r.text)
            inst = r.json(); uid = inst["id"]
            kinds = sorted(o["kind"] for o in inst["objects"])
            check("six objects owned", kinds == ["agent", "mcp_server", "source", "source",
                                                 "trigger", "view"], str(kinds))
            check("status active, no error", inst["status"] == "active" and not inst["last_error"])
            r = await cx.post("/api/projects", json={
                "template": "test_demo", "name": "demo one", "params": {"apps": ["x"]}})
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
            r = await cx.get(f"/api/projects/{uid}/summary")
            check("summary merges template summary + log",
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
            r = await cx.put(f"/api/projects/{uid}", json={"params": {"apps": ["ui", "web"]}})
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
            inst = (await cx.get(f"/api/projects/{uid}")).json()
            miss = {o["key"]: o["missing"] for o in inst["objects"]}
            check("instance reports the trigger missing", miss.get("trigger") is True, str(miss))
            r = await cx.post(f"/api/projects/{uid}/repair", json={"key": "trigger"})
            check("repair -> 200", r.status_code == 200, r.text)
            trig = {t["name"] for t in (await cx.get("/api/triggers")).json()}
            check("trigger re-created", "t_trigger" in trig, str(trig))
            r = await cx.post(f"/api/projects/{uid}/repair", json={"key": "view"})
            v = {v["name"]: v for v in (await cx.get("/api/views")).json()}["t_view"]
            check("repair resets a customized view to the plan",
                  sorted(v["sources"]) == ["t_ui", "t_web"] and v["customized"] is False, str(v))

            print("== pause / resume ==")
            r = await cx.post(f"/api/projects/{uid}/pause")
            check("pause -> paused", r.json()["status"] == "paused", r.text)
            t = {t["name"]: t for t in (await cx.get("/api/triggers")).json()}["t_trigger"]
            check("owned trigger paused", t["paused"] is True)
            r = await cx.post(f"/api/projects/{uid}/resume")
            t = {t["name"]: t for t in (await cx.get("/api/triggers")).json()}["t_trigger"]
            check("resume -> active, trigger running",
                  r.json()["status"] == "active" and t["paused"] is False)

            print("== all-or-nothing create ==")
            before = {s["name"] for s in (await cx.get("/api/sources")).json()}
            r = await cx.post("/api/projects", json={
                "template": "test_demo", "name": "broken",
                "params": {"apps": ["z"], "prefix": "b", "fail": True}})
            check("invalid plan -> 400", r.status_code == 400, r.text)
            after = {s["name"] for s in (await cx.get("/api/sources")).json()}
            check("nothing created by the failed create", before == after, str(after - before))
            bad = [u for u in (await cx.get("/api/projects")).json()["projects"]
                   if u["name"] == "broken"]
            check("failed instance kept with status error + last_error",
                  bad and bad[0]["status"] == "error" and bad[0]["last_error"], str(bad))
            await cx.delete(f"/api/projects/{bad[0]['id']}")

            print("== ownership conflict ==")
            r = await cx.post("/api/projects", json={
                "template": "test_demo", "name": "clash", "params": {"apps": ["ui"]}})
            check("a plan may not take another project's object", r.status_code == 400
                  and "another project" in r.text, r.text)
            clash = [u for u in (await cx.get("/api/projects")).json()["projects"]
                     if u["name"] == "clash"]
            if clash:
                await cx.delete(f"/api/projects/{clash[0]['id']}")

            print("== export / import round trip ==")
            y = (await cx.get("/api/catalog/export")).text
            check("export has a projects section with params",
                  "projects:" in y and "template: test_demo" in y and "apps:" in y, y[-400:])
            r = await cx.post("/api/catalog/import", json={"yaml": y, "mode": "merge"})
            check("re-import of the export is idempotent", r.status_code == 200
                  and r.json()["projects"] == 1, r.text)
            check("still one instance", len((await cx.get("/api/projects")).json()["projects"]) == 1)
            r = await cx.post("/api/catalog/import", json={"yaml":
                "projects:\n  - template: test_demo\n    name: yaml one\n    params: {apps: [q], prefix: y}\n"})
            check("import creates a new instance from YAML", r.status_code == 200, r.text)
            ucs = {u["name"]: u for u in (await cx.get("/api/projects")).json()["projects"]}
            check("yaml one exists and owns y_q", "yaml one" in ucs and
                  any(o["name"] == "y_q" for o in ucs["yaml one"]["objects"]), str(list(ucs)))

            print("== pre-1.14 names still work (aliases, two releases) ==")
            r = await cx.post("/api/catalog/import", json={"yaml":
                "usecases:\n  - recipe: test_demo\n    name: old form\n    params: {apps: [o], prefix: old}\n"})
            check("old-form catalog (usecases: + recipe:) imports", r.status_code == 200
                  and r.json()["projects"] == 1, r.text)
            ucs = {u["name"]: u for u in (await cx.get("/api/projects")).json()["projects"]}
            check("old form created the project under the template", ucs.get("old form", {}).get("template") == "test_demo")
            r = await cx.post("/api/catalog/import", json={"yaml":
                "projects:\n  - template: test_demo\n    name: a\n"
                "usecases:\n  - recipe: test_demo\n    name: b\n"})
            check("a document with both sections is rejected", r.status_code == 400 and "usecases:" in r.text, r.text[:200])
            y = (await cx.get("/api/catalog/export")).text
            check("export writes the new form only", "projects:" in y and "usecases:" not in y and "recipe:" not in y)
            r = await cx.get("/api/usecases/recipes")
            check("GET /api/usecases/recipes -> recipes", r.status_code == 200 and "recipes" in r.json(), r.text[:200])
            r = await cx.get("/api/usecases")
            old_list = r.json().get("usecases") or []
            check("GET /api/usecases -> usecases, each with recipe and recipe_title",
                  r.status_code == 200 and old_list and all(u.get("recipe") == u["template"]
                  and u.get("recipe_title") for u in old_list), r.text[:300])
            r = await cx.post("/api/usecases", json={"recipe": "test_demo", "name": "via alias",
                                                     "params": {"apps": ["z"], "prefix": "al"}})
            check("POST /api/usecases with recipe -> 201", r.status_code == 201 and r.json()["template"] == "test_demo", r.text[:200])
            aid = r.json()["id"]
            check("GET /api/usecases/{id}", (await cx.get(f"/api/usecases/{aid}")).status_code == 200)
            check("GET /api/usecases/{id}/summary", (await cx.get(f"/api/usecases/{aid}/summary")).status_code == 200)
            check("POST /api/usecases/{id}/pause", (await cx.post(f"/api/usecases/{aid}/pause")).json()["status"] == "paused")
            check("POST /api/usecases/{id}/resume", (await cx.post(f"/api/usecases/{aid}/resume")).json()["status"] == "active")
            r = await cx.put(f"/api/usecases/{aid}", json={"params": {"apps": ["z", "y"], "prefix": "al"}})
            check("PUT /api/usecases/{id}", r.status_code == 200 and "al_y" in str(r.json()["report"]["created"]), r.text[:200])
            r = await cx.post(f"/api/usecases/{aid}/repair", json={"key": "view"})
            check("POST /api/usecases/{id}/repair", r.status_code == 200, r.text[:200])
            r = await cx.post(f"/api/usecases/{aid}/actions/nope", json={})
            check("POST /api/usecases/{id}/actions/{name} reaches the handler", r.status_code == 400, r.text[:200])
            r = await cx.post("/api/usecases/recipes/test_demo/detect")
            check("POST /api/usecases/recipes/{key}/detect", r.status_code == 200, r.text[:200])
            check("DELETE /api/usecases/{id}", (await cx.delete(f"/api/usecases/{aid}")).status_code == 200)
            check("aliases are not in the schema",
                  not any(p.startswith("/api/usecases") for p in (await cx.get("/openapi.json")).json()["paths"]))
            await cx.delete(f"/api/projects/{ucs['old form']['id']}")

            print("== delete ==")
            r = await cx.delete(f"/api/projects/{uid}?purge_events=true")
            check("delete -> ok", r.status_code == 200 and r.json()["ok"], r.text)
            names = {s["name"] for s in (await cx.get("/api/sources")).json()}
            check("owned sources removed", not ({"t_ui", "t_web"} & names), str(names))
            trig = {t["name"] for t in (await cx.get("/api/triggers")).json()}
            check("owned trigger removed", "t_trigger" not in trig)
            check("instance gone", (await cx.get(f"/api/projects/{uid}")).status_code == 404)
            check("unknown id -> 404", (await cx.delete("/api/projects/uc_nope")).status_code == 404)
            # leave the catalog empty so the next boot seeds from YAML (the store stays open, so the
            # file cannot be removed here)
            await cx.delete(f"/api/projects/{ucs['yaml one']['id']}")
            check("catalog empty again", (await cx.get("/api/sources")).json() == [])

    print("== YAML seed on an empty catalog ==")
    with open(CATALOG, "w") as f:
        f.write("projects:\n  - template: test_demo\n    name: seeded\n"
                "    params: {apps: [a, b], prefix: s}\n")
    app2 = make_app()
    async with app2.router.lifespan_context(app2):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app2),
                                     base_url="http://test") as cx:
            ucs = (await cx.get("/api/projects")).json()["projects"]
            check("seeded instance exists", len(ucs) == 1 and ucs[0]["name"] == "seeded", str(ucs))
            names = {s["name"] for s in (await cx.get("/api/sources")).json()}
            check("seeded objects exist and are owned", {"s_a", "s_b"} <= names, str(names))
    os.remove(CATALOG)
    unregister("test_demo")

    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


asyncio.run(main())

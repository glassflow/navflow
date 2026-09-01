"""The challenger workflow as a project (TR-197): template shape, adopting the plugin-created
claude_code source, the session_ended trigger firing on a marked session's end line, memory
proposal parsing, the summarize action. No laptop, no Codex, no Anthropic key needed.
Run: .venv/bin/python tests/test_challenger_workflow.py
"""
import asyncio
import json
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB = "/tmp/tares-challenger-test.duckdb"
CATALOG = "/tmp/tares-challenger-test.catalog.yaml"
os.environ["TARES_DB"] = DB
os.environ["TARES_CATALOG"] = CATALOG
os.environ.pop("ANTHROPIC_API_KEY", None)

import httpx

PASS = FAIL = 0


def test_repo_label_migration():
    """A store saved before 1.14 declares the claude_code label `project`; reopening renames it and
    any view on it to `repo` (stored events keep theirs). The same rewrite runs after a catalog import."""
    from tares.store import Store
    print("== repo label migration ==")
    path = DB + ".migration"
    if os.path.exists(path):
        os.remove(path)
    s = Store(path)
    s.upsert_catalog_source("claude_code", "logs", "claude_code", "10s", {"push": True, "labels": [
        {"name": "session", "field": "session", "primary": True},
        {"name": "project", "field": "project"}]})
    s.upsert_catalog_source("cc_plain", "logs", "claude_code", "10s", {})
    s.upsert_catalog_view("byrepo", "project", ["claude_code"], [])
    s.upsert_catalog_view("mixed", "project", ["claude_code", "something_else"],
                          [{"field": "project", "op": "eq", "value": "shop"}])
    s.upsert_catalog_view("mine", "session", ["claude_code"],
                          [{"field": "project", "op": "eq", "value": "shop"}])
    s.upsert_catalog_view("other", "session", ["something_else"],
                          [{"field": "project", "op": "eq", "value": "x"}])
    s.con.close()
    s = Store(path)
    labels = {l["name"]: l for l in next(x for x in s.list_catalog_sources()
                                         if x["name"] == "claude_code")["config"]["labels"]}
    check("saved claude_code source now declares repo", "repo" in labels and "project" not in labels
          and labels["repo"]["field"] == "repo", json.dumps(labels))
    views = {v["name"]: v for v in s.list_catalog_views()}
    check("view filter on the claude_code source renamed", views["mine"]["filters"][0]["field"] == "repo")
    check("unrelated view untouched", views["other"]["filters"][0]["field"] == "project")
    check("view keyed by project now keyed by repo", views["byrepo"]["key_field"] == "repo")
    check("mixed-source view left alone", views["mixed"]["key_field"] == "project"
          and views["mixed"]["filters"][0]["field"] == "project")
    # an old catalog file imported later brings the label back; the daemon reruns the rewrite
    s.upsert_catalog_source("claude_code", "logs", "claude_code", "10s", {"push": True, "labels": [
        {"name": "project", "field": "project"}]})
    s.migrate_claude_code_repo_label()
    labels = {l["name"] for l in next(x for x in s.list_catalog_sources()
                                      if x["name"] == "claude_code")["config"]["labels"]}
    check("rewrite is repeatable after an import", labels == {"repo"}, str(labels))
    s.con.close()
    os.remove(path)


def check(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f"  ok   {label}")
    else:
        FAIL += 1; print(f"  FAIL {label}  {detail}")


def ts(minutes_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def line(sid, typ, ts, **extra):
    o = {"sessionId": sid, "type": typ, "cwd": "/home/me/shop", "gitBranch": "pricing",
         "timestamp": ts, "flow": "challenger", **extra}
    return json.dumps(o)


def clean():
    for p in (DB, DB + ".wal", CATALOG):
        if os.path.exists(p):
            os.remove(p)


async def main(app):

    from tares.projects import get_template
    from tares.projects.base import ProjectError
    from tares.projects.challenger_workflow import (AGENT, ENDS_VIEW, PROMPT, SOURCE, TRIGGER,
                                                    VIEW, parse_proposals)
    r = get_template("challenger_workflow")

    print("== template ==")
    d = r.describe()
    check("not a demo", d["tags"] == [])
    check("setup and the summarize action advertised",
          len(d["setup"]) == 4 and [a["name"] for a in d["actions"]] == ["summarize"])
    check("facts for the card", "you" in d["facts"] and "tares" in d["facts"])
    check("prompt fits the agent limit and has no em dash", len(PROMPT) < 8000 and "—" not in PROMPT)
    check("no em dash in any rendered string", "—" not in json.dumps(d))
    p = r.validate({})
    check("defaults", p == {"slack_channel": "", "model": ""}, json.dumps(p))
    try:
        r.validate({"slack_channel": "general"}); check("bad slack channel rejected", False)
    except ProjectError:
        check("bad slack channel rejected", True)
    plan = r.plan(r.validate({"slack_channel": "C0123456789", "model": "claude-sonnet-4-6"}))
    names = [(o.kind, o.name) for o in plan]
    check("five objects", names == [("source", SOURCE), ("view", VIEW), ("view", ENDS_VIEW),
                                    ("trigger", TRIGGER), ("agent", AGENT)], str(names))
    ends = plan[2].spec
    check("detection view filters on session_end and the challenger flow",
          {(f["field"], f["value"]) for f in ends["filters"]} == {("event_type", "session_end"), ("flow", "challenger")})
    agent = plan[4].spec
    check("agent on the trigger with slack and model applied",
          agent["trigger"] == TRIGGER and agent["slack_channel"] == "C0123456789"
          and agent["model"] == "claude-sonnet-4-6")
    plain = {o.kind: o.spec for o in r.plan(r.validate({}))}
    check("no slack/model keys when unset", "slack_channel" not in plain["agent"] and "model" not in plain["agent"])

    print("== proposals ==")
    finding = ("Summary\nBuilt the pricing page.\n\nMemory proposals\n- The shop repo runs tests with "
               "`make test`, not pytest.\n- Codex flags missing aria labels; add them up front.\n\n"
               "Cost\n12k tokens.")
    check("parses the list under the heading",
          parse_proposals(finding) == ["The shop repo runs tests with `make test`, not pytest.",
                                       "Codex flags missing aria labels; add them up front."],
          str(parse_proposals(finding)))
    check("markdown heading and * bullets work",
          parse_proposals("## Memory proposals:\n* a\n* b\nNext heading\n- c") == ["a", "b"])
    check("no section, no proposals", parse_proposals("Summary\nnothing") == [])
    check("caps at five", len(parse_proposals("Memory proposals\n" + "\n".join(f"- {i}" for i in range(9)))) == 5)

    from tares.daemon import make_app
    # the app is built before the loop, like `tares up` (the runner attaches the loop at startup)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as cx:
            print("== adopt the plugin's source ==")
            # exactly what ship.py does on its first run
            rr = await cx.post("/api/sources", json={"name": SOURCE, "connector": "claude_code",
                                                     "poll": "10s", "config": {"push": True}})
            check("plugin-style source created", rr.status_code in (200, 201), rr.text[:200])
            print("== the first marked line creates the project ==")
            rr = await cx.post(f"/ingest/{SOURCE}", content=json.dumps(
                {"sessionId": "s0", "type": "user", "cwd": "/x", "timestamp": ts(60)}) + "\n",
                headers={"content-type": "application/x-ndjson"})
            check("an unmarked line creates nothing",
                  rr.status_code == 202 and (await cx.get("/api/projects")).json()["projects"] == [])
            rr = await cx.post(f"/ingest/{SOURCE}", content=line("s0", "session_flow", ts(59)) + "\n",
                               headers={"content-type": "application/x-ndjson"})
            ucs = (await cx.get("/api/projects")).json()["projects"]
            check("a flow=challenger line creates the challenger_workflow project",
                  rr.status_code == 202 and len(ucs) == 1 and ucs[0]["template"] == "challenger_workflow", json.dumps(ucs)[:300])
            uid = ucs[0]["id"]
            rr = await cx.post(f"/ingest/{SOURCE}", content=line("s0", "session_flow", ts(58)) + "\n",
                               headers={"content-type": "application/x-ndjson"})
            check("a second marked line does not create another", len((await cx.get("/api/projects")).json()["projects"]) == 1)
            srcs = {s["name"]: s for s in (await cx.get("/api/sources")).json()}
            check("one claude_code source, owned by the project",
                  sum(1 for n in srcs if n == SOURCE) == 1 and srcs[SOURCE]["owned_by"] == uid,
                  json.dumps(srcs.get(SOURCE))[:200])
            agents = (await cx.get("/api/agents/builtin")).json()["agents"]
            a = next(x for x in agents if x["name"] == AGENT)
            check("agent owned and subscribed to the trigger", a["owned_by"] == uid and a["trigger"] == TRIGGER)

            print("== a marked session ends ==")
            body = "\n".join([
                line("s1", "user", ts(30),
                     message={"role": "user", "content": "build a pricing page"}),
                line("s1", "session_flow", ts(29)),
                line("s1", "challenge_commit", ts(10),
                     challenge={"verdict": "PASS", "sha": "abc1234", "finding_count": 0,
                                "blocking_count": 0, "duration_seconds": 30, "findings": []}),
                line("s1", "challenge_plan", ts(8),
                     challenge={"verdict": "FAIL", "plan": "p.md", "finding_count": 5,
                                "blocking_count": 2, "findings": [
                                    {"priority": "P1", "title": "finding " + str(i) + " " + "x" * 150,
                                     "waived": False} for i in range(5)]}),
                line("s1", "session_end", ts(1)),
            ]) + "\n"
            rr = await cx.post(f"/ingest/{SOURCE}", content=body,
                               headers={"content-type": "application/x-ndjson"})
            check("session lines ingested", rr.status_code == 202 and rr.json()["ingested"] == 5, rr.text[:200])
            # an unmarked session that ends must not fire
            rr = await cx.post(f"/ingest/{SOURCE}", content=json.dumps(
                {"sessionId": "s2", "type": "session_end", "cwd": "/x", "timestamp": ts(1)}) + "\n",
                headers={"content-type": "application/x-ndjson"})
            check("unmarked session end ingested", rr.status_code == 202)

            rr = await cx.post("/query", json={"view": ENDS_VIEW, "key": "s1", "window": "24h"})
            check("detection view shows only the end line of s1",
                  rr.status_code == 200 and rr.text.count("session_end") >= 1 and "pricing page" not in rr.text, rr.text[:300])
            rr = await cx.post("/query", json={"view": VIEW, "key": "s1", "window": "24h"})
            check("session view has the transcript and the challenge",
                  "pricing page" in rr.text and "Challenger reviewed commit abc1234" in rr.text, rr.text[:400])

            from tares.triggers import eval_triggers
            st = app.state
            await eval_triggers(st.store, st.runtime.catalog, st.runtime.dispatcher, None)
            await asyncio.sleep(0.5)
            check("trigger fired for the marked session", st.store.last_fired(TRIGGER, "s1") is not None)
            check("trigger did not fire for the unmarked session", st.store.last_fired(TRIGGER, "s2") is None)

            print("== summary and action ==")
            s = (await cx.get(f"/api/projects/{uid}/summary")).json()
            check("summary names the objects and counts summarized sessions",
                  s["names"]["agent"] == AGENT and "runs" in s
                  and (s.get("cards") or [{}])[0].get("label") == "sessions summarized",
                  json.dumps(s)[:300])
            sess = {x["session"]: x for x in s["sessions"]}
            check("summary lists the marked sessions only", set(sess) == {"s0", "s1"}, json.dumps(s["sessions"])[:400])
            s1 = sess.get("s1") or {}
            check("session names the repo (cwd basename) under `repo`", "repo" in s1 and "project" not in s1,
                  json.dumps(s1)[:200])
            lbls = [json.loads(r[0] or "{}") for r in app.state.store.con.execute(
                "SELECT labels FROM events WHERE source = ?", [SOURCE]).fetchall()]
            check("events carry a repo label, not project",
                  any(l.get("repo") == "shop" for l in lbls) and not any("project" in l for l in lbls),
                  json.dumps(lbls)[:300])
            plan_ev = next((t for t in s1.get("thread", []) if t["event_type"] == "challenge_plan"), {})
            check("a plan review's thread entry carries every finding in full",
                  len(plan_ev.get("findings") or []) == 5
                  and all(len(f["title"]) > 150 for f in plan_ev["findings"]), json.dumps(plan_ev)[:300])
            check("the challenge text is not chopped at 500 characters",
                  len(plan_ev.get("text") or "") > 500 and "finding 4" in plan_ev["text"], str(len(plan_ev.get("text") or "")))
            check("session carries the commit verdict and thread",
                  s1.get("commits") and s1["commits"][0]["verdict"] == "PASS" and s1.get("ended")
                  and [t["event_type"] for t in s1["thread"]] == ["session_flow", "challenge_commit", "challenge_plan", "session_end"],
                  json.dumps(s1)[:400])
            rr = await cx.post(f"/api/projects/{uid}/actions/summarize", json={})
            check("summarize without a session -> 400", rr.status_code == 400, rr.text[:200])
            rr = await cx.post(f"/api/projects/{uid}/actions/summarize", json={"session": "s1"})
            check("summarize s1 starts a run from the action thread",
                  rr.status_code == 200 and rr.json().get("run_id", "").startswith("run_"), rr.text[:200])
            await asyncio.sleep(0.5)
            runs = (await cx.get(f"/api/projects/{uid}/summary")).json()["runs"]
            check("the run is recorded on the project page (no key, so it did not conclude)",
                  any(r["session"] == "s1" for r in runs), json.dumps(runs)[:300])

            print("== proposal decisions live on the memory source ==")
            from tares.projects.challenger_workflow import proposal_decisions
            await cx.post("/remember", json={"key": "shop", "content": "use make test", "memory_type": "decision"})
            await cx.post("/remember", json={"key": "shop", "content": "21 tests", "memory_type": "rejected_proposal"})
            d = proposal_decisions(app.state.store)
            check("accept -> accepted, reject -> rejected, keyed by repo",
                  d.get(("shop", "use make test")) == "accepted" and d.get(("shop", "21 tests")) == "rejected", str(d))

            print("== delete ==")
            rr = await cx.delete(f"/api/projects/{uid}")
            check("delete -> 200", rr.status_code == 200, rr.text[:200])
            names = {v["name"] for v in (await cx.get("/api/views")).json()}
            check("views gone", not ({VIEW, ENDS_VIEW} & names), str(names))

    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    from tares.daemon import make_app
    clean()
    test_repo_label_migration()
    asyncio.run(main(make_app()))

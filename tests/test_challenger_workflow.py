"""The challenger workflow as a use case (TR-197): recipe shape, adopting the plugin-created
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


async def main():
    for p in (DB, DB + ".wal", CATALOG):
        if os.path.exists(p):
            os.remove(p)

    from tares.usecases import get_recipe
    from tares.usecases.base import UsecaseError
    from tares.usecases.challenger_workflow import (AGENT, ENDS_VIEW, PROMPT, SOURCE, TRIGGER,
                                                    VIEW, parse_proposals)
    r = get_recipe("challenger_workflow")

    print("== recipe ==")
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
    except UsecaseError:
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
    app = make_app()
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as cx:
            print("== adopt the plugin's source ==")
            # exactly what ship.py does on its first run
            rr = await cx.post("/api/sources", json={"name": SOURCE, "connector": "claude_code",
                                                     "poll": "10s", "config": {"push": True}})
            check("plugin-style source created", rr.status_code in (200, 201), rr.text[:200])
            rr = await cx.post("/api/usecases", json={"recipe": "challenger_workflow",
                                                     "name": "Challenger workflow", "params": {}})
            check("create -> 201", rr.status_code == 201, rr.text[:300])
            uid = rr.json()["id"]
            srcs = {s["name"]: s for s in (await cx.get("/api/sources")).json()}
            check("one claude_code source, owned by the use case",
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
                line("s1", "session_end", ts(1)),
            ]) + "\n"
            rr = await cx.post(f"/ingest/{SOURCE}", content=body,
                               headers={"content-type": "application/x-ndjson"})
            check("session lines ingested", rr.status_code == 202 and rr.json()["ingested"] == 4, rr.text[:200])
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
            s = (await cx.get(f"/api/usecases/{uid}/summary")).json()
            check("summary counts events and names the objects",
                  s["events"] == 5 and s["names"]["agent"] == AGENT and "runs" in s, json.dumps(s)[:300])
            rr = await cx.post(f"/api/usecases/{uid}/actions/summarize", json={})
            check("summarize without a session -> 400", rr.status_code == 400, rr.text[:200])
            rr = await cx.post(f"/api/usecases/{uid}/actions/summarize", json={"session": "s1"})
            check("summarize s1 starts a run from the action thread",
                  rr.status_code == 200 and rr.json().get("run_id", "").startswith("run_"), rr.text[:200])
            await asyncio.sleep(0.5)
            runs = (await cx.get(f"/api/usecases/{uid}/summary")).json()["runs"]
            check("the run is recorded on the use case page (no key, so it did not conclude)",
                  any(r["session"] == "s1" for r in runs), json.dumps(runs)[:300])

            print("== delete ==")
            rr = await cx.delete(f"/api/usecases/{uid}")
            check("delete -> 200", rr.status_code == 200, rr.text[:200])
            names = {v["name"] for v in (await cx.get("/api/views")).json()}
            check("views gone", not ({VIEW, ENDS_VIEW} & names), str(names))

    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    asyncio.run(main())

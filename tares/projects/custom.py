"""The `custom` template: a project assembled by hand from objects that already exist.

There is no planned version of anything. The plan is the explicit object list; create adopts
the objects (ownership badge), edit adds or releases them, delete releases them. Nothing is ever
created or deleted on behalf of a custom project, so Repair and customized do not apply."""
from __future__ import annotations

from datetime import datetime

from .base import KINDS, PlannedObject, ProjectError, Template
from .registry import register


def _iso(ts) -> str | None:
    return ts.isoformat() if isinstance(ts, datetime) else (str(ts) if ts else None)


class CustomTemplate(Template):
    key = "custom"
    title = "From existing objects"
    description = ("A project assembled from sources, views, triggers, agents and MCP servers "
                   "that already exist. Nothing is created; removing an object from the project "
                   "leaves it in place.")
    PARAMS = {"objects": {"type": "list", "required": True,
                          "help": "the objects, each {kind, name}; kind is source, view, "
                                  "trigger, agent or mcp_server"}}
    hidden = True   # the console offers it next to the templates, not as one of them

    def validate(self, params: dict) -> dict:
        out = super().validate(params)
        raw = out.get("objects")
        if not isinstance(raw, list):
            raise ProjectError("custom: objects must be a list of {kind, name}")
        seen, objects = set(), []
        for o in raw:
            if not isinstance(o, dict) or not o.get("kind") or not o.get("name"):
                raise ProjectError(f"custom: each object needs a kind and a name, got {o!r}")
            kind, name = str(o["kind"]), str(o["name"]).strip()
            if kind not in KINDS:
                raise ProjectError(f"custom: unknown object kind {kind!r} "
                                   f"(one of {', '.join(KINDS)})")
            if (kind, name) in seen:
                continue
            seen.add((kind, name))
            objects.append({"kind": kind, "name": name})
        if not objects:
            raise ProjectError("custom: a project needs at least one object")
        out["objects"] = objects
        return out

    def plan(self, params: dict) -> list[PlannedObject]:
        return [PlannedObject(o["kind"], f"{o['kind']}:{o['name']}", {"name": o["name"]})
                for o in params["objects"]]

    def summary(self, instance: dict, store) -> dict:
        """Runs of its agents, when its triggers last fired."""
        objects = instance.get("objects") or []
        runs, total, ok = [], 0, 0
        for o in objects:
            if o["kind"] != "agent":
                continue
            n, n_ok = store.count_agent_runs(o["name"])
            total += n
            ok += n_ok
            for r in store.list_agent_runs(o["name"], limit=20):
                runs.append({"id": r.get("id"), "started_at": _iso(r.get("started_at")),
                             "key": r.get("key"), "agent": o["name"], "status": r.get("status"),
                             "rounds": r.get("rounds"), "max_rounds": r.get("max_rounds"),
                             "finding": r.get("finding"), "error": r.get("error")})
        runs.sort(key=lambda r: r["started_at"] or "", reverse=True)
        runs = runs[:20]
        triggers = []
        for o in objects:
            if o["kind"] != "trigger":
                continue
            triggers.append({"name": o["name"], "last_fired": _iso(store.last_fired_any(o["name"]))})
        fired = [t["last_fired"] for t in triggers if t["last_fired"]]
        return {"runs": runs, "triggers": triggers, "runs_total": total, "runs_ok": ok,
                "trigger_last_fired": max(fired) if fired else None}


register(CustomTemplate())

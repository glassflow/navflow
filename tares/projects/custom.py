"""The `custom` template: a project assembled by hand from objects that already exist.

There is no planned version of anything. The plan is the explicit object list; create adopts
the objects (ownership badge), edit adds or releases them, delete releases them. Nothing is ever
created or deleted on behalf of a custom project, so Repair and customized do not apply."""
from __future__ import annotations

from .base import KINDS, PlannedObject, ProjectError, Template
from .registry import register


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

register(CustomTemplate())

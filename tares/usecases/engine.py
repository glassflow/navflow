"""The engine turns a recipe's plan into real objects and keeps them in step with the params.

Every write goes through the catalog importer (`config.import_catalog_dict`), so a use case's
objects get exactly the validation, secret handling and runtime start a catalog import gets. What
the engine adds is ownership (`owned_by` on the object rows, `usecase_objects` mapping plan keys to
names), a diff on update, all-or-nothing create, pause/resume, delete and repair.
"""
from __future__ import annotations

import traceback
import uuid

from ..config import CatalogError, agent_url, import_catalog_dict
from .base import PlannedObject, UsecaseError
from .registry import get_recipe, list_recipes as _list_recipes

# delete order: dependents first (an agent references a trigger, a trigger a view, a view sources;
# an agent may reference an mcp server)
_DELETE_ORDER = ("agent", "trigger", "view", "source", "mcp_server")
_SECTION = {"source": "sources", "view": "views", "trigger": "triggers",
            "agent": "agents", "mcp_server": "mcp_servers"}


class Engine:
    def __init__(self, store, reload=None, runtime=None):
        """`reload`: called after every catalog change (the runtime's reload_catalog); None while
        the daemon is still booting, since the runtime builds its catalog from the DB afterwards.
        `runtime`: handed to a recipe's after_create hook (bootstrap runs); None at boot."""
        self.store = store
        self._reload = reload
        self.runtime = runtime

    # ── read side ────────────────────────────────────────────────────────────
    def list_recipes(self) -> list[dict]:
        return [r.describe() for r in _list_recipes()]

    def _existing_names(self) -> dict[str, dict[str, dict]]:
        s = self.store
        return {"source": {x["name"]: x for x in s.list_catalog_sources()},
                "view": {x["name"]: x for x in s.list_catalog_views()},
                "trigger": {x["name"]: x for x in s.list_catalog_triggers()},
                "agent": {x["name"]: x for x in s.list_catalog_agents()},
                "mcp_server": {x["name"]: x for x in s.list_mcp_servers()}}

    def get(self, uid: str) -> dict | None:
        inst = self.store.get_usecase(uid)
        if inst is None:
            return None
        existing = self._existing_names()
        objects = []
        for o in self.store.list_usecase_objects(uid):
            row = existing[o["kind"]].get(o["name"])
            objects.append({**o, "missing": row is None,
                            "customized": bool(row and row.get("customized")) or o["customized"]})
        recipe = _safe_recipe(inst["recipe"])
        return {**inst, "recipe_title": recipe.title if recipe else inst["recipe"],
                "objects": objects}

    def list(self) -> list[dict]:
        return [self.get(u["id"]) for u in self.store.list_usecases()]

    def summary(self, uid: str) -> dict:
        inst = self.get(uid)
        if inst is None:
            raise KeyError(f"unknown use case {uid!r}")
        recipe = _safe_recipe(inst["recipe"])
        extra = {}
        if recipe is not None:
            try:
                extra = recipe.summary(inst, self.store) or {}
            except Exception as e:   # a summary must never take the page down
                extra = {"summary_error": f"{type(e).__name__}: {e}"}
        # the instance's own fields win: a recipe summary adds detail, it never replaces
        # id/objects/status/log that the pages depend on
        base = {**inst, "log": self.store.list_usecase_log(uid)}
        return {**{k: v for k, v in extra.items() if k not in base}, **base}

    # ── write side ───────────────────────────────────────────────────────────
    def create(self, recipe_key: str, params: dict, name: str | None = None) -> dict:
        recipe = get_recipe(recipe_key)
        params = recipe.validate(params)
        recipe.preflight(params, self.store)
        name = (name or "").strip() or f"{recipe.title or recipe.key}"
        if self.store.get_usecase_by_name(name) is not None:
            raise UsecaseError(f"a use case named {name!r} already exists")
        plan = recipe.plan(params)
        uid = "uc_" + uuid.uuid4().hex[:10]
        self.store.create_usecase(uid, recipe.key, name, params, status="active")
        self.store.log_usecase(uid, "create", f"{len(plan)} objects planned")
        before = self._existing_names()
        try:
            self._check_ownership(uid, plan, before)
            self._apply(uid, plan)
        except Exception as e:
            # all or nothing: remove what this create added (never what already existed), record
            # the failure on the instance so the UI can show it, then re-raise.
            created = [o for o in plan if o.name not in before[o.kind]]
            self._delete_objects(created, purge_events=False)
            self.store.update_usecase(uid, status="error", last_error=_errtext(e))
            self.store.log_usecase(uid, "create_failed", _errtext(e))
            self._do_reload()
            raise
        self._do_reload()
        self.store.log_usecase(uid, "created", ", ".join(f"{o.kind}:{o.name}" for o in plan))
        inst = self.get(uid)
        try:
            recipe.after_create(inst, self.store, self.runtime)
        except Exception as e:   # the objects exist; a failed bootstrap is a note, not a rollback
            self.store.log_usecase(uid, "bootstrap_failed", _errtext(e))
        return self.get(uid)

    def update(self, uid: str, params: dict) -> dict:
        inst = self._require(uid)
        recipe = get_recipe(inst["recipe"])
        params = recipe.validate(params)
        recipe.preflight(params, self.store)
        plan = recipe.plan(params)
        existing = {(o["kind"], o["key"]): o for o in self.store.list_usecase_objects(uid)}
        current = self._existing_names()
        report = {"created": [], "updated": [], "kept": [], "deleted": []}
        to_apply: list[PlannedObject] = []
        for o in plan:
            prev = existing.get((o.kind, o.key))
            if prev is None:
                report["created"].append(f"{o.kind}:{o.name}")
                to_apply.append(o)
                continue
            row = current[o.kind].get(prev["name"])
            if row is not None and (row.get("customized") or prev["customized"]):
                report["kept"].append(f"{o.kind}:{prev['name']}")
                continue
            if row is not None and prev["name"] != o.name:
                # the plan renamed this object: drop the old name, the new one is created below
                self._delete_objects([PlannedObject(o.kind, o.key, {"name": prev["name"]})],
                                     purge_events=False)
            report["updated" if row is not None else "created"].append(f"{o.kind}:{o.name}")
            to_apply.append(o)
        planned_keys = {(o.kind, o.key) for o in plan}
        removed = [PlannedObject(k, key, {"name": o["name"]})
                   for (k, key), o in existing.items() if (k, key) not in planned_keys]
        self._check_ownership(uid, to_apply, current)
        self._delete_objects(removed, purge_events=False)
        for r in removed:
            self.store.delete_usecase_object(uid, r.kind, r.key)
            report["deleted"].append(f"{r.kind}:{r.name}")
        try:
            self._apply(uid, to_apply)
        except Exception as e:
            self.store.update_usecase(uid, status="error", last_error=_errtext(e))
            self.store.log_usecase(uid, "update_failed", _errtext(e))
            self._do_reload()
            raise
        self.store.update_usecase(uid, params=params, last_error=None,
                                  status="active" if inst["status"] == "error" else None)
        self._do_reload()
        self.store.log_usecase(uid, "updated", "; ".join(
            f"{k}: {', '.join(v)}" for k, v in report.items() if v) or "no changes")
        return {**self.get(uid), "report": report}

    def pause(self, uid: str) -> dict:
        inst = self._require(uid)
        for o in self.store.list_usecase_objects(uid):
            if o["kind"] == "trigger":
                self.store.set_trigger_paused(o["name"], True)
            elif o["kind"] == "agent":
                self.store.remove_subscription_by_url(agent_url(o["name"]))
        self.store.update_usecase(uid, status="paused")
        self.store.log_usecase(uid, "paused", "triggers paused, agents unsubscribed; sources keep ingesting")
        self._do_reload()
        return self.get(uid)

    def resume(self, uid: str) -> dict:
        inst = self._require(uid)
        recipe = get_recipe(inst["recipe"])
        plan = {(o.kind, o.key): o for o in recipe.plan(recipe.validate(inst["params"]))}
        for o in self.store.list_usecase_objects(uid):
            if o["kind"] == "trigger":
                self.store.set_trigger_paused(o["name"], False)
            elif o["kind"] == "agent":
                spec = plan.get(("agent", o["key"]))
                agent = self.store.get_catalog_agent(o["name"])
                if agent and spec is not None and spec.spec.get("enabled", False):
                    url = agent_url(o["name"])
                    if not self.store.subscription_by_url(url):
                        self.store.add_subscription("sub_" + uuid.uuid4().hex[:8],
                                                    agent["trigger"], url, created_by="tares")
        self.store.update_usecase(uid, status="active")
        self.store.log_usecase(uid, "resumed")
        self._do_reload()
        return self.get(uid)

    def delete(self, uid: str, purge_events: bool = False) -> dict:
        self._require(uid)
        objs = [PlannedObject(o["kind"], o["key"], {"name": o["name"]})
                for o in self.store.list_usecase_objects(uid)]
        purged = self._delete_objects(objs, purge_events=purge_events)
        self.store.delete_usecase(uid)
        self._do_reload()
        return {"ok": True, "deleted": [f"{o.kind}:{o.name}" for o in objs],
                "purged_events": purged}

    def action(self, uid: str, name: str, args: dict | None = None) -> dict:
        """Run one of the recipe's ACTIONS on an instance and log it."""
        inst = self._require(uid)
        recipe = get_recipe(inst["recipe"])
        if not any(a.get("name") == name for a in recipe.ACTIONS):
            raise UsecaseError(f"{recipe.key}: no action {name!r}")
        result = recipe.run_action(inst, name, dict(args or {}), self.store, self.runtime) or {}
        self.store.log_usecase(uid, f"action:{name}", str(result.get("message", "")) if result else "")
        return {"ok": True, "action": name, **result}

    def repair(self, uid: str, key: str) -> dict:
        """Re-apply one planned object from the current params: re-creates a hand-deleted object,
        or resets a customized one back to the plan (ownership is re-claimed either way)."""
        inst = self._require(uid)
        recipe = get_recipe(inst["recipe"])
        plan = recipe.plan(recipe.validate(inst["params"]))
        target = next((o for o in plan if o.key == key or f"{o.kind}:{o.key}" == key), None)
        if target is None:
            raise UsecaseError(f"no planned object with key {key!r}")
        prev = next((o for o in self.store.list_usecase_objects(uid)
                     if o["kind"] == target.kind and o["key"] == target.key), None)
        if prev and prev["name"] != target.name:
            self._delete_objects([PlannedObject(target.kind, target.key, {"name": prev["name"]})],
                                 purge_events=False)
        self._check_ownership(uid, [target], self._existing_names())
        self._apply(uid, [target])
        self._do_reload()
        self.store.log_usecase(uid, "repaired", f"{target.kind}:{target.name}")
        return self.get(uid)

    # ── internals ────────────────────────────────────────────────────────────
    def _require(self, uid: str) -> dict:
        inst = self.store.get_usecase(uid)
        if inst is None:
            raise KeyError(f"unknown use case {uid!r}")
        return inst

    def _check_ownership(self, uid: str, plan: list[PlannedObject], existing: dict) -> None:
        """A plan may adopt an unowned object of the same name (upsert), never one that belongs to
        another use case."""
        for o in plan:
            row = existing[o.kind].get(o.name)
            if row is not None and row.get("owned_by") and row["owned_by"] != uid:
                raise UsecaseError(
                    f"{o.kind} {o.name!r} belongs to another use case ({row['owned_by']})")

    def _apply(self, uid: str, plan: list[PlannedObject]) -> None:
        if not plan:
            return
        doc: dict = {}
        for o in plan:
            doc.setdefault(_SECTION[o.kind], []).append(dict(o.spec))
        try:
            import_catalog_dict(self.store, doc)   # validates the whole doc, then writes
        except CatalogError as e:
            raise UsecaseError(str(e)) from e
        for o in plan:
            self.store.set_owned_by(o.kind, o.name, uid)
            self.store.upsert_usecase_object(uid, o.kind, o.key, o.name)

    def _delete_objects(self, objs: list[PlannedObject], purge_events: bool) -> int:
        purged = 0
        s = self.store
        for kind in _DELETE_ORDER:
            for o in objs:
                if o.kind != kind:
                    continue
                if kind == "agent":
                    s.remove_subscription_by_url(agent_url(o.name))
                    s.delete_catalog_agent(o.name)
                elif kind == "trigger":
                    s.delete_catalog_trigger(o.name)
                elif kind == "view":
                    s.delete_catalog_view(o.name)
                elif kind == "source":
                    s.delete_catalog_source(o.name)
                    if purge_events:
                        purged += s.purge_events(o.name)
                elif kind == "mcp_server":
                    s.delete_mcp_server(o.name)
        return purged

    def _do_reload(self) -> None:
        if self._reload is not None:
            self._reload()


def _safe_recipe(key: str):
    try:
        return get_recipe(key)
    except UsecaseError:
        return None


def _errtext(e: Exception) -> str:
    text = str(e) or repr(e)
    if not isinstance(e, (UsecaseError, CatalogError, KeyError, ValueError)):
        text = f"{type(e).__name__}: {text}\n{traceback.format_exc()[-1500:]}"
    return text

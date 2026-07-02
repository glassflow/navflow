"""Trigger evaluation — runs in navflowd after each ingest tick.

Collapsed form of the design doc's Trigger Engine: instead of a stream consumer with windowed
state in JetStream KV, we evaluate each condition as a SQL aggregate over the DuckDB window. On a
match (not in cooldown) we render the view and dispatch it. Expand path: move the window in-memory
and evaluate on the in-flight batch to decouple latency from the poll interval.
"""
from __future__ import annotations

import operator
from datetime import timezone

from .config import Catalog
from .envelope import now_utc
from .views import parse_window, resolve_query

_OPS = {">=": operator.ge, "<=": operator.le, "==": operator.eq, ">": operator.gt, "<": operator.lt}


def _predicate(value: float, pred: str) -> bool:
    pred = pred.strip()
    for sym in (">=", "<=", "==", ">", "<"):
        if pred.startswith(sym):
            return _OPS[sym](value, float(pred[len(sym):].strip()))
    raise ValueError(f"unparseable predicate: {pred!r}")


def _aware(dt):
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def eval_triggers(store, catalog: Catalog, dispatcher, affected_sources=None) -> list:
    """Evaluate every trigger whose view touches an affected source. Returns [(trigger, key)] fired."""
    fired = []
    for trig in catalog.triggers:
        view = catalog.views[trig.view]
        if affected_sources and not (set(view.sources) & set(affected_sources)):
            continue

        c = trig.condition
        group_by = c.group_by or ["key_value"]
        legacy = group_by == ["key_value"]
        since = now_utc() - parse_window(c.window)
        per_group = store.aggregate(view.sources, c.field, c.aggregate, since,
                                    filters=view.filters, group_by=group_by)

        for grp, value in per_group.items():
            try:
                hit = _predicate(value, c.predicate)
            except ValueError:
                hit = False
            if not hit:
                continue

            # `grp` is a tuple (one element per group_by label). The group identifies the entity
            # that fired: legacy key_value grouping selects context by key; label grouping selects
            # by a {label: value} `where`. The cooldown / dispatch key is a stable string.
            if legacy:
                fire_key, where = grp[0], None
            else:
                where = dict(zip(group_by, grp))
                fire_key = ", ".join(f"{k}={v}" for k, v in where.items())

            last = store.last_fired(trig.name, fire_key)
            if last and (now_utc() - _aware(last)).total_seconds() < trig.cooldown_seconds:
                continue

            # Detection uses the (narrow) condition window; the attached context is wider so the
            # woken agent gets the correlating deploy/config, not just the spike that tripped it.
            ctx_window = trig.emit.get("context_window", "15m")
            payload = resolve_query(store, catalog, trig.view,
                                    key=(fire_key if legacy else None),
                                    window=ctx_window, where=where)
            await dispatcher.fire(trig, fire_key, payload)
            store.set_fired(trig.name, fire_key, now_utc())
            fired.append((trig.name, fire_key))

    return fired

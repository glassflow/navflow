"""View resolution — query(view, key, window) -> the rendered, time-ordered timeline payload.

This is the read path the agent sees. The rendered format matches the cookbook dummy exactly, so
the agent path is byte-identical; only the backing (DuckDB scan vs in-process pull) differs.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from .config import Catalog, parse_duration
from .envelope import now_utc


def parse_window(window: str) -> timedelta:
    return timedelta(seconds=parse_duration(window))


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def render_view(view_name: str, selector: str, window: str, rows) -> str:
    now = now_utc()
    out = [f"=== {view_name} · {selector} · window={window} · ONE NavFlow read ===", ""]
    for event_time, source, text in rows:
        ago = int(max((now - _aware(event_time)).total_seconds(), 0))
        for line in (text or "").splitlines() or [""]:
            out.append(f"[T-{ago}s] [{source}] {line}")
    if not rows:
        out.append("(no events for this selector in the window)")
    return "\n".join(out)


def _selector(key, where) -> str:
    if where:
        return ", ".join(f"{k}={v}" for k, v in where.items())
    return f"key={key}" if key is not None else "all"


def resolve_query_full(store, catalog: Catalog, view_name: str, key=None, window: str = "15m",
                       where: dict | None = None) -> tuple[str, int]:
    """(rendered payload, row count) — the count feeds the query activity log. The entity is
    selected by `key` (legacy key_value) and/or `where` ({label: value} on any named label)."""
    view = catalog.views[view_name]
    since = now_utc() - parse_window(window)
    rows = store.read_view_window(view.sources, key, since, filters=view.filters, where=where)
    return render_view(view_name, _selector(key, where), window, rows), len(rows)


def resolve_query(store, catalog: Catalog, view_name: str, key=None, window: str = "15m",
                  where: dict | None = None) -> str:
    return resolve_query_full(store, catalog, view_name, key, window, where)[0]


def resolve_read(store, catalog: Catalog, where: dict, window: str = "15m") -> tuple[str, int, list]:
    """Raw label-native read across ALL sources — no view. `where` is a {label: value} conjunction
    (strict AND). Reading every source is self-pruning: a source that doesn't stamp one of the
    selector's labels yields NULL for it and drops out, so the result is exactly the strict-AND
    match. Returns (rendered payload, row count, sources that actually contributed rows)."""
    since = now_utc() - parse_window(window)
    rows = store.read_view_window(sorted(catalog.sources), None, since, filters=None, where=where)
    payload = render_view("read", _selector(None, where), window, rows)
    contributing = sorted({r[1] for r in rows})
    return payload, len(rows), contributing

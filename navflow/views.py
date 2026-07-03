"""View resolution — query(view, key, window) -> the rendered, time-ordered timeline payload.

This is the read path the agent sees. The rendered format matches the cookbook dummy exactly, so
the agent path is byte-identical; only the backing (DuckDB scan vs in-process pull) differs.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from .config import Catalog, parse_duration
from .envelope import now_utc


def parse_window(window: str) -> timedelta:
    return timedelta(seconds=parse_duration(window))


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _labels(raw) -> dict:
    if isinstance(raw, dict):
        return raw
    if raw:
        try:
            v = json.loads(raw)
            return v if isinstance(v, dict) else {}
        except (TypeError, ValueError):
            return {}
    return {}


def _render(rows, include_payload: bool = False) -> tuple[list, list]:
    """From read_view_window rows → (payload lines, structured rows). The labels the connector
    extracted (endpoint, status, …) are appended to each line and returned structured, so a read is
    self-describing: the dimensions you filtered/sliced by are visible on every row, for the human
    timeline and the agent payload alike. When `include_payload` is set, each row is a 5-tuple whose
    trailing element is the raw stored record; it's parsed and attached as `raw` so agents can read
    the full lossless event, not just the summary `text`."""
    now = now_utc()
    lines, structured = [], []
    for row in rows:
        event_time, source, text, labels = row[0], row[1], row[2], row[3]
        ago = int(max((now - _aware(event_time)).total_seconds(), 0))
        lbls = _labels(labels)
        suffix = ("  ·  " + "  ".join(f"{k}={v}" for k, v in lbls.items())) if lbls else ""
        sub = (text or "").splitlines() or [""]
        for i, line in enumerate(sub):
            lines.append(f"[T-{ago}s] [{source}] {line}" + (suffix if i == 0 else ""))
        entry = {"offset": f"T-{ago}s", "source": source, "text": (text or ""), "labels": lbls}
        if include_payload:
            raw = row[4]
            try:
                entry["raw"] = json.loads(raw) if isinstance(raw, (str, bytes, bytearray)) else raw
            except (ValueError, TypeError):
                entry["raw"] = raw   # stored non-JSON payload — pass through as-is
        structured.append(entry)
    return lines, structured


def _wrap(view_name: str, selector: str, window: str, lines: list, empty: bool) -> str:
    out = [f"=== {view_name} · {selector} · window={window} · ONE NavFlow read ===", "", *lines]
    if empty:
        out.append("(no events for this selector in the window)")
    return "\n".join(out)


def render_view(view_name: str, selector: str, window: str, rows) -> str:
    lines, _ = _render(rows)
    return _wrap(view_name, selector, window, lines, not rows)


def _selector(key, where) -> str:
    if where:
        return ", ".join(f"{k}={v}" for k, v in where.items())
    return f"key={key}" if key is not None else "all"


def resolve_query_full(store, catalog: Catalog, view_name: str, key=None, window: str = "15m",
                       where: dict | None = None, include_payload: bool = False) -> tuple[str, int, list]:
    """(rendered payload, row count, structured rows) — the count feeds the query activity log; the
    rows carry per-event labels for the console. Entity selected by `key` and/or `where`.
    `include_payload` adds the raw lossless record as `raw` on each structured row."""
    view = catalog.views[view_name]
    since = now_utc() - parse_window(window)
    rows = store.read_view_window(view.sources, key, since, filters=view.filters, where=where,
                                  include_payload=include_payload)
    lines, structured = _render(rows, include_payload)
    return _wrap(view_name, _selector(key, where), window, lines, not rows), len(rows), structured


def resolve_query(store, catalog: Catalog, view_name: str, key=None, window: str = "15m",
                  where: dict | None = None) -> str:
    return resolve_query_full(store, catalog, view_name, key, window, where)[0]


def resolve_read(store, catalog: Catalog, where: dict, window: str = "15m",
                 include_payload: bool = False) -> tuple[str, int, list, list]:
    """Raw label-native read across ALL sources — no view. `where` is a {label: value} conjunction
    (strict AND). Reading every source is self-pruning: a source that doesn't stamp one of the
    selector's labels yields NULL for it and drops out, so the result is exactly the strict-AND
    match. Returns (rendered payload, row count, contributing sources, structured rows).
    `include_payload` adds the raw lossless record as `raw` on each structured row."""
    since = now_utc() - parse_window(window)
    rows = store.read_view_window(sorted(catalog.sources), None, since, filters=None, where=where,
                                  include_payload=include_payload)
    lines, structured = _render(rows, include_payload)
    payload = _wrap("read", _selector(None, where), window, lines, not rows)
    contributing = sorted({r[1] for r in rows})
    return payload, len(rows), contributing, structured

"""DuckDB store — the collapsed Bronze+Silver. One events table; lossless via the JSON payload.

navflowd is the sole owner of this connection (DuckDB is single-writer). All reads and writes go
through here; the MCP server never touches the DB directly.
"""
from __future__ import annotations

import json
import re
import secrets
import threading
from datetime import datetime

import duckdb

from .envelope import Envelope, now_utc

_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
  source       TEXT,
  source_type  TEXT,
  key_value    TEXT,
  event_type   TEXT,
  text         TEXT,
  fields       JSON,
  payload      JSON,
  event_time   TIMESTAMPTZ,
  ingest_time  TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS cursors (
  source TEXT PRIMARY KEY,
  cursor TEXT
);
CREATE TABLE IF NOT EXISTS trigger_state (
  trigger    TEXT,
  key_value  TEXT,
  last_fired TIMESTAMPTZ,
  PRIMARY KEY (trigger, key_value)
);
CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id TEXT PRIMARY KEY,
  trigger         TEXT,
  url             TEXT,
  created_at      TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS catalog_sources (
  name       TEXT PRIMARY KEY,
  type       TEXT,
  connector  TEXT,
  poll       TEXT,
  config     JSON,
  paused     BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  ingest_key TEXT
);
CREATE TABLE IF NOT EXISTS catalog_views (
  name       TEXT PRIMARY KEY,
  key_field  TEXT,
  sources    JSON,
  filters    JSON,
  created_by TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS catalog_triggers (
  name       TEXT PRIMARY KEY,
  view       TEXT,
  condition  JSON,
  emit       JSON,
  cooldown   TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS query_log (
  id            TEXT PRIMARY KEY,
  view          TEXT,
  key_value     TEXT,
  time_window   TEXT,
  rows_returned INTEGER,
  client        TEXT,
  queried_at    TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS dispatch_log (
  dispatch_id TEXT PRIMARY KEY,
  trigger     TEXT,
  key_value   TEXT,
  kind        TEXT,
  fired_at    TIMESTAMPTZ,
  subscribers INTEGER,
  delivered   INTEGER,
  payload     TEXT
);
"""

# Columns added after the first release; bring pre-existing DBs up to the current schema.
_MIGRATIONS = [
    "ALTER TABLE catalog_views ADD COLUMN IF NOT EXISTS filters JSON",
    "ALTER TABLE catalog_views ADD COLUMN IF NOT EXISTS created_by TEXT",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS labels JSON",
    "ALTER TABLE catalog_sources ADD COLUMN IF NOT EXISTS ingest_key TEXT",
]

_FILTER_COLS = {"event_type", "source", "text", "key_value"}
_FILTER_OPS = {"eq": "=", "neq": "!=", "gt": ">", "lt": "<", "gte": ">=", "lte": "<="}
_FIELD_RE = re.compile(r"^[A-Za-z0-9_]+$")


def _label_expr(name: str) -> str:
    """SQL expression for label `name`: its own column if it's the legacy primary key, else
    read from the labels JSON. Lets a query slice by key_value or any named label uniformly."""
    if not _FIELD_RE.match(name):
        raise ValueError(f"bad label name {name!r}")
    if name == "key_value":
        return "key_value"
    return f"json_extract_string(labels, '$.{name}')"


def _where_sql(where) -> tuple[str, list]:
    """{label: value} -> ('AND ...' equality SQL, params). Matches on key_value or any label."""
    clauses, params = [], []
    for name, value in (where or {}).items():
        clauses.append(f"{_label_expr(name)} = ?")
        params.append(str(value))
    return (" AND " + " AND ".join(clauses)) if clauses else "", params


def _filter_sql(filters) -> tuple[str, list]:
    """View filters -> ('AND ...' SQL fragment, params). Non-envelope fields read fields.<name>;
    numeric ops cast to DOUBLE (TRY_CAST: rows without the field simply don't match)."""
    clauses, params = [], []
    for f in filters or []:
        name, op, value = f["field"], f["op"], f["value"]
        if not _FIELD_RE.match(name):
            raise ValueError(f"bad filter field {name!r}")
        numeric = op in ("gt", "lt", "gte", "lte")
        if name in _FILTER_COLS:
            expr = f"TRY_CAST({name} AS DOUBLE)" if numeric else name
        else:
            expr = f"json_extract_string(fields, '$.{name}')"
            if numeric:
                expr = f"TRY_CAST({expr} AS DOUBLE)"
        if op == "contains":
            clauses.append(f"{expr} ILIKE ?")
            params.append(f"%{value}%")
        elif op in _FILTER_OPS:
            clauses.append(f"{expr} {_FILTER_OPS[op]} ?")
            params.append(float(value) if numeric else str(value))
        else:
            raise ValueError(f"bad filter op {op!r}")
    return (" AND " + " AND ".join(clauses)) if clauses else "", params


class Store:
    def __init__(self, path: str = "navflow.duckdb"):
        # All access is from navflowd's event loop thread; the lock is belt-and-suspenders since
        # FastAPI may run sync work in a threadpool.
        self._lock = threading.Lock()
        self.con = duckdb.connect(path)
        for stmt in _SCHEMA.strip().split(";"):
            if stmt.strip():
                self.con.execute(stmt)
        for stmt in _MIGRATIONS:
            self.con.execute(stmt)

    # ── ingest ──────────────────────────────────────────────────────────────
    def append(self, envelopes: list[Envelope]) -> None:
        if not envelopes:
            return
        # Explicit column list: the `labels` column was added by migration after first release,
        # so positional INSERT order is no longer guaranteed.
        rows = [
            (e.source, e.source_type, e.key_value, e.event_type, e.text,
             json.dumps(e.fields), json.dumps(e.payload), json.dumps(e.labels),
             e.event_time, e.ingest_time)
            for e in envelopes
        ]
        # Insert in bounded chunks. DuckDB's executemany binds rows one at a time, so a single huge
        # batch (e.g. a connector catching up a large backlog) would bind millions of parameters at
        # once and stall the daemon. Chunking caps each bind regardless of how much a caller passes.
        chunk = 2000
        with self._lock:
            for i in range(0, len(rows), chunk):
                self.con.executemany(
                    "INSERT INTO events (source, source_type, key_value, event_type, text, "
                    "fields, payload, labels, event_time, ingest_time) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows[i:i + chunk]
                )

    # ── reads ───────────────────────────────────────────────────────────────
    def read_view_window(self, sources: list[str], key: str | None, since: datetime, cap: int = 12,
                         filters: list | None = None, where: dict | None = None):
        """Rows (event_time, source, text) for an entity across sources, time-ordered.

        The entity is selected by `key` (legacy primary key_value) and/or `where` (a
        {label: value} map matching named labels). Passing key=None with a `where` is the
        label-native read ("everything where env=prod"); passing a key keeps the old behaviour.

        Caps each source to its most-recent `cap` events so a lossless store doesn't return a
        bloated payload (e.g. thousands of identical log lines or every 5s metric sample). Ingest
        stays lossless; this bound is a read-path summary, matching what an SRE actually wants.
        """
        ph = ", ".join(["?"] * len(sources))
        fsql, fparams = _filter_sql(filters)
        wsql, wparams = _where_sql(where)
        ksql, kparams = (" AND key_value = ?", [key]) if key is not None else ("", [])
        with self._lock:
            return self.con.execute(
                f"SELECT event_time, source, text FROM ("
                f"  SELECT event_time, source, text, "
                f"  ROW_NUMBER() OVER (PARTITION BY source ORDER BY event_time DESC) AS rn "
                f"  FROM events WHERE source IN ({ph}) AND event_time >= ?{ksql}{fsql}{wsql}"
                f") WHERE rn <= {int(cap)} ORDER BY event_time",
                [*sources, since, *kparams, *fparams, *wparams],
            ).fetchall()

    def aggregate(self, sources: list[str], field: str | None, agg: str, since: datetime,
                  filters: list | None = None, where: dict | None = None,
                  group_by="key_value") -> dict:
        """{group: value} for an aggregate over `field` in the window, grouped by one or more
        labels. `group_by` is a label name (scalar keys, key_value by default) or a list of
        names (tuple keys — a trigger grouping per (env, app)). NULL group values are dropped
        (a row lacking a grouping label isn't a real entity); NULL field values are ignored by
        the aggregate."""
        names = [group_by] if isinstance(group_by, str) else list(group_by)
        gexprs = [_label_expr(n) for n in names]
        ph = ", ".join(["?"] * len(sources))
        fsql, fparams = _filter_sql(filters)
        wsql, wparams = _where_sql(where)
        valexpr = (f"CAST(json_extract_string(fields, '$.{field}') AS DOUBLE)"
                   if field else "1")
        aggexpr = {
            "count": "COUNT(*)",
            "sum": f"SUM({valexpr})",
            "avg": f"AVG({valexpr})",
            "max": f"MAX({valexpr})",
            "min": f"MIN({valexpr})",
            "any": f"MAX({valexpr})",
        }[agg]
        sel_g = ", ".join(f"{e} AS g{i}" for i, e in enumerate(gexprs))
        grp_g = ", ".join(f"g{i}" for i in range(len(gexprs)))
        having = " AND ".join(f"g{i} IS NOT NULL" for i in range(len(gexprs)))
        with self._lock:
            rows = self.con.execute(
                f"SELECT {sel_g}, {aggexpr} FROM events "
                f"WHERE source IN ({ph}) AND event_time >= ?{fsql}{wsql} "
                f"GROUP BY {grp_g} HAVING {having}",
                [*sources, since, *fparams, *wparams],
            ).fetchall()
        out = {}
        for r in rows:
            gvals, val = r[:len(gexprs)], r[-1]
            key = gvals[0] if isinstance(group_by, str) else tuple(gvals)
            out[key] = val if val is not None else 0.0
        return out

    # ── cursors (incremental connectors) ──────────────────────────────────────
    def get_cursor(self, source: str):
        with self._lock:
            r = self.con.execute("SELECT cursor FROM cursors WHERE source = ?", [source]).fetchone()
        return r[0] if r else None

    def delete_cursor(self, source: str) -> None:
        with self._lock:
            self.con.execute("DELETE FROM cursors WHERE source = ?", [source])

    def set_cursor(self, source: str, cursor: str) -> None:
        with self._lock:
            self.con.execute(
                "INSERT INTO cursors VALUES (?, ?) "
                "ON CONFLICT (source) DO UPDATE SET cursor = excluded.cursor",
                [source, cursor],
            )

    # ── trigger cooldown state ────────────────────────────────────────────────
    def last_fired(self, trigger: str, key: str):
        with self._lock:
            r = self.con.execute(
                "SELECT last_fired FROM trigger_state WHERE trigger = ? AND key_value = ?",
                [trigger, key],
            ).fetchone()
        return r[0] if r else None

    def set_fired(self, trigger: str, key: str, ts: datetime) -> None:
        with self._lock:
            self.con.execute(
                "INSERT INTO trigger_state VALUES (?, ?, ?) "
                "ON CONFLICT (trigger, key_value) DO UPDATE SET last_fired = excluded.last_fired",
                [trigger, key, ts],
            )

    # ── catalog (DB-backed; YAML is import/export) ────────────────────────────
    def catalog_empty(self) -> bool:
        with self._lock:
            n = self.con.execute(
                "SELECT (SELECT COUNT(*) FROM catalog_sources)"
                " + (SELECT COUNT(*) FROM catalog_views)"
                " + (SELECT COUNT(*) FROM catalog_triggers)"
            ).fetchone()[0]
        return n == 0

    def upsert_catalog_source(self, name: str, type_: str, connector: str, poll: str, config: dict,
                              paused: bool = False, ingest_key: str | None = None) -> None:
        ts = now_utc()
        # the ingest_key is the stable, unguessable path segment for push endpoints (/ingest/<key>).
        # Generated once at creation, preserved across updates; backfilled if an older row lacks one.
        ik = ingest_key or f"{connector}-{secrets.token_hex(4)}"
        with self._lock:
            self.con.execute(
                "INSERT INTO catalog_sources "
                "(name, type, connector, poll, config, paused, created_at, updated_at, ingest_key) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT (name) DO UPDATE SET type = excluded.type, "
                "connector = excluded.connector, poll = excluded.poll, config = excluded.config, "
                "paused = excluded.paused, updated_at = excluded.updated_at, "
                "ingest_key = COALESCE(catalog_sources.ingest_key, excluded.ingest_key)",
                [name, type_, connector, poll, json.dumps(config), paused, ts, ts, ik],
            )

    def list_catalog_sources(self) -> list[dict]:
        with self._lock:
            rows = self.con.execute(
                "SELECT name, type, connector, poll, config, paused, created_at, updated_at, ingest_key "
                "FROM catalog_sources ORDER BY name"
            ).fetchall()
        return [
            {"name": r[0], "type": r[1], "connector": r[2], "poll": r[3],
             "config": json.loads(r[4]), "paused": bool(r[5]),
             "created_at": r[6], "updated_at": r[7], "ingest_key": r[8]}
            for r in rows
        ]

    def delete_catalog_source(self, name: str) -> None:
        with self._lock:
            self.con.execute("DELETE FROM catalog_sources WHERE name = ?", [name])

    def set_source_paused(self, name: str, paused: bool) -> None:
        with self._lock:
            self.con.execute(
                "UPDATE catalog_sources SET paused = ?, updated_at = ? WHERE name = ?",
                [paused, now_utc(), name],
            )

    def upsert_catalog_view(self, name: str, key_field: str, sources: list,
                            filters: list | None = None, created_by: str = "human") -> None:
        # Explicit column list: migrated DBs have filters/created_by appended after created_at.
        ts = now_utc()
        with self._lock:
            self.con.execute(
                "INSERT INTO catalog_views (name, key_field, sources, filters, created_by, "
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT (name) DO UPDATE SET key_field = excluded.key_field, "
                "sources = excluded.sources, filters = excluded.filters, "
                "created_by = excluded.created_by, updated_at = excluded.updated_at",
                [name, key_field, json.dumps(sources), json.dumps(filters or []),
                 created_by, ts, ts],
            )

    def list_catalog_views(self) -> list[dict]:
        with self._lock:
            rows = self.con.execute(
                "SELECT name, key_field, sources, filters, created_by "
                "FROM catalog_views ORDER BY name"
            ).fetchall()
        return [
            {"name": r[0], "key_field": r[1], "sources": json.loads(r[2]),
             "filters": json.loads(r[3]) if r[3] else [],
             "created_by": r[4] or "human"}
            for r in rows
        ]

    def delete_catalog_view(self, name: str) -> None:
        with self._lock:
            self.con.execute("DELETE FROM catalog_views WHERE name = ?", [name])

    def upsert_catalog_trigger(self, name: str, view: str, condition: dict,
                               emit: dict, cooldown: str) -> None:
        ts = now_utc()
        with self._lock:
            self.con.execute(
                "INSERT INTO catalog_triggers VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT (name) DO UPDATE SET view = excluded.view, "
                "condition = excluded.condition, emit = excluded.emit, "
                "cooldown = excluded.cooldown, updated_at = excluded.updated_at",
                [name, view, json.dumps(condition), json.dumps(emit), cooldown, ts, ts],
            )

    def list_catalog_triggers(self) -> list[dict]:
        with self._lock:
            rows = self.con.execute(
                "SELECT name, view, condition, emit, cooldown FROM catalog_triggers ORDER BY name"
            ).fetchall()
        return [
            {"name": r[0], "view": r[1], "condition": json.loads(r[2]),
             "emit": json.loads(r[3]), "cooldown": r[4]}
            for r in rows
        ]

    def delete_catalog_trigger(self, name: str) -> None:
        with self._lock:
            self.con.execute("DELETE FROM catalog_triggers WHERE name = ?", [name])

    def clear_catalog(self) -> None:
        with self._lock:
            self.con.execute("DELETE FROM catalog_sources")
            self.con.execute("DELETE FROM catalog_views")
            self.con.execute("DELETE FROM catalog_triggers")

    # ── activity logs (agent-facing observability) ────────────────────────────
    def log_query(self, qid: str, view: str, key: str, window: str,
                  rows_returned: int, client: str) -> None:
        with self._lock:
            self.con.execute(
                "INSERT INTO query_log VALUES (?, ?, ?, ?, ?, ?, ?)",
                [qid, view, key, window, rows_returned, client, now_utc()],
            )

    def list_queries(self, limit: int = 100) -> list[dict]:
        with self._lock:
            rows = self.con.execute(
                "SELECT id, view, key_value, time_window, rows_returned, client, queried_at "
                "FROM query_log ORDER BY queried_at DESC LIMIT ?", [int(limit)],
            ).fetchall()
        return [
            {"id": r[0], "view": r[1], "key": r[2], "window": r[3],
             "rows_returned": r[4], "client": r[5], "queried_at": r[6]}
            for r in rows
        ]

    def log_dispatch(self, dispatch_id: str, trigger: str, key: str, kind: str,
                     subscribers: int, delivered: int, payload: str) -> None:
        with self._lock:
            self.con.execute(
                "INSERT INTO dispatch_log VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [dispatch_id, trigger, key, kind, now_utc(), subscribers, delivered, payload],
            )

    def list_dispatches(self, limit: int = 100) -> list[dict]:
        with self._lock:
            rows = self.con.execute(
                "SELECT dispatch_id, trigger, key_value, kind, fired_at, subscribers, delivered, payload "
                "FROM dispatch_log ORDER BY fired_at DESC LIMIT ?", [int(limit)],
            ).fetchall()
        return [
            {"dispatch_id": r[0], "trigger": r[1], "key": r[2], "kind": r[3],
             "fired_at": r[4], "subscribers": r[5], "delivered": r[6], "payload": r[7]}
            for r in rows
        ]

    # ── event inspection (UI) ─────────────────────────────────────────────────
    def event_stats(self) -> list[dict]:
        """Per-source totals + last ingest, for source health cards."""
        with self._lock:
            rows = self.con.execute(
                "SELECT source, COUNT(*), MAX(ingest_time) FROM events GROUP BY source"
            ).fetchall()
        return [{"source": r[0], "events": r[1], "last_ingest": r[2]} for r in rows]

    def recent_events(self, source: str | None = None, limit: int = 50) -> list[dict]:
        where = "WHERE source = ?" if source else ""
        params = ([source] if source else []) + [int(limit)]
        with self._lock:
            rows = self.con.execute(
                f"SELECT source, key_value, event_type, text, event_time, ingest_time "
                f"FROM events {where} ORDER BY ingest_time DESC LIMIT ?", params,
            ).fetchall()
        return [
            {"source": r[0], "key": r[1], "event_type": r[2], "text": r[3],
             "event_time": r[4], "ingest_time": r[5]}
            for r in rows
        ]

    def recent_payloads(self, source: str, limit: int = 500) -> list[dict]:
        """The lossless payloads of a source's most recent events (for field profiling)."""
        with self._lock:
            rows = self.con.execute(
                "SELECT payload FROM events WHERE source = ? ORDER BY ingest_time DESC LIMIT ?",
                [source, int(limit)]).fetchall()
        out = []
        for (pj,) in rows:
            try:
                out.append(json.loads(pj) if pj else {})
            except (TypeError, ValueError):
                pass
        return out

    def source_schema(self, source: str, sample: int = 200) -> dict:
        """Inferred shape of a source's events, sampled from the most recent `sample` rows:
        the event types seen and the typed fields (with the type of the latest value)."""
        with self._lock:
            rows = self.con.execute(
                "SELECT event_type, fields FROM events WHERE source = ? "
                "ORDER BY ingest_time DESC LIMIT ?", [source, int(sample)],
            ).fetchall()
        event_types, fields = set(), {}
        for etype, fjson in rows:
            event_types.add(etype)
            for k, v in (json.loads(fjson) or {}).items():
                fields.setdefault(k, "number" if isinstance(v, (int, float)) else "string")
        return {"event_types": sorted(event_types), "fields": fields,
                "sampled_events": len(rows)}

    def view_usage(self) -> dict:
        """{view: {queries, last_used_at}} from the query log — feeds usage-driven deprecation."""
        with self._lock:
            rows = self.con.execute(
                "SELECT view, COUNT(*), MAX(queried_at) FROM query_log GROUP BY view"
            ).fetchall()
        return {r[0]: {"queries": r[1], "last_used_at": r[2]} for r in rows}

    def backfill_labels(self, source: str, specs: list, context_fn=None) -> int:
        """Recompute a source's stored events' labels from their lossless payload using `specs`.
        This is what makes labels retroactive: a label declared today is computed over data
        ingested before it existed (the value was always in the payload, just unnamed).

        NOTE: not currently wired. Source edits are going-forward only (new events get the new
        specs; existing events are untouched). This is the building block for a planned explicit,
        chunked, cancellable background relabel job — it must not run inline on an edit, since on a
        large source it rewrites millions of rows.

        `context_fn` reconstructs the connector's per-event label context from the stored payload
        (the connector's `label_context`); without it the payload is used as-is, which would drop
        SYNTHESIZED labels (e.g. Vercel's `project`, derived from projectName)."""
        from .config import extract_labels
        with self._lock:
            rows = self.con.execute(
                "SELECT rowid, payload FROM events WHERE source = ?", [source]).fetchall()
        # Compute the new labels for every row OUTSIDE the lock: JSON parsing and the connector's
        # label_context can be heavy, and we must not hold the single DB writer for the whole scan.
        updates = []
        for rid, pj in rows:
            try:
                payload = json.loads(pj) if pj else {}
            except (TypeError, ValueError):
                payload = {}
            ctx = context_fn(payload) if context_fn else payload
            updates.append((rid, json.dumps(extract_labels(specs, ctx))))
        if not updates:
            return 0
        # Apply as ONE set-based UPDATE via a temp-table join. DuckDB is columnar: a single-row
        # `UPDATE ... WHERE rowid = ?` rewrites a whole row group, so N of them on a large source is
        # quadratic (this once wedged the daemon). Staging the new values and joining once is a
        # single rewrite.
        with self._lock:
            self.con.execute(
                "CREATE OR REPLACE TEMP TABLE _backfill (rowid BIGINT, labels VARCHAR)")
            self.con.executemany("INSERT INTO _backfill VALUES (?, ?)", updates)
            self.con.execute(
                "UPDATE events SET labels = b.labels FROM _backfill b WHERE events.rowid = b.rowid")
            self.con.execute("DROP TABLE _backfill")
        return len(updates)

    def list_entities(self, label: str, sources: list[str] | None = None,
                      limit: int = 200) -> list[dict]:
        """Distinct values of `label` (an entity per value) with event count + last seen, most
        active first. `label` may be 'key_value' or any named label. Optionally scoped to sources."""
        expr = _label_expr(label)
        where = "WHERE " + expr + " IS NOT NULL"
        params: list = []
        if sources:
            where += f" AND source IN ({', '.join(['?'] * len(sources))})"
            params += sources
        with self._lock:
            rows = self.con.execute(
                f"SELECT {expr} AS v, COUNT(*), MAX(ingest_time) FROM events {where} "
                f"GROUP BY v ORDER BY COUNT(*) DESC LIMIT ?", [*params, int(limit)],
            ).fetchall()
        return [{"value": r[0], "events": r[1], "last_ingest": r[2]} for r in rows]

    def purge_events(self, source: str) -> int:
        with self._lock:
            n = self.con.execute(
                "SELECT COUNT(*) FROM events WHERE source = ?", [source]).fetchone()[0]
            self.con.execute("DELETE FROM events WHERE source = ?", [source])
            self.con.execute("DELETE FROM cursors WHERE source = ?", [source])
        return n

    # ── subscriptions ─────────────────────────────────────────────────────────
    def add_subscription(self, sid: str, trigger: str, url: str) -> None:
        with self._lock:
            self.con.execute(
                "INSERT INTO subscriptions VALUES (?, ?, ?, ?) "
                "ON CONFLICT (subscription_id) DO UPDATE SET trigger = excluded.trigger, url = excluded.url",
                [sid, trigger, url, now_utc()],
            )

    def list_subscriptions(self, trigger: str):
        with self._lock:
            return self.con.execute(
                "SELECT subscription_id, trigger, url FROM subscriptions WHERE trigger = ?",
                [trigger],
            ).fetchall()

    def list_all_subscriptions(self) -> list[dict]:
        with self._lock:
            rows = self.con.execute(
                "SELECT subscription_id, trigger, url, created_at FROM subscriptions "
                "ORDER BY created_at DESC"
            ).fetchall()
        return [{"subscription_id": r[0], "trigger": r[1], "url": r[2], "created_at": r[3]}
                for r in rows]

    def remove_subscription(self, sid: str) -> None:
        with self._lock:
            self.con.execute("DELETE FROM subscriptions WHERE subscription_id = ?", [sid])

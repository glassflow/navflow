"""Postgres connector — polls a table incrementally and emits one Envelope per new/changed row.

This is your application's source-of-truth data, not derived telemetry: the orders, users, jobs,
and tenants your agent actually reasons about. It lands in the same correlated timeline as the
metrics, logs and deploys, so "what happened to tenant=acme" includes the row that changed.

Mode is the honest MVP collapse of CDC: each poll runs `SELECT * FROM <table> WHERE <cursor_column>
> <last> ORDER BY <cursor_column> LIMIT <limit>`, advancing a cursor over a monotonic column —
an autoincrement id (cursor_type=int) or an updated_at timestamp (cursor_type=timestamp). Logical
replication is the expand path. Mutable rows are captured on each update only if you cursor by
updated_at; an int id cursor is append-only (inserts).

Keyed by `key_column` (e.g. tenant_id) — that column's value becomes the primary label, so rows
auto-shard per entity. Declare more `labels` to facet by status/region/etc. The driver (asyncpg)
is an optional extra: `pip install navflow[postgres]`.

Secret note: a `dsn` carries the password and would export to YAML — prefer leaving `dsn` empty and
setting PG_DSN (or DATABASE_URL) in the daemon's environment (kept out of the catalog).
"""
from __future__ import annotations

import os
import re
from datetime import datetime

from ..config import CatalogError
from ..envelope import Envelope, now_utc
from .base import Connector

# table/column names are interpolated into SQL (identifiers can't be bound as params), so they must
# be safe identifiers — schema-qualified table allows one dot, a column is a bare name.
_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_TABLE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$")


def _dsn(config: dict) -> str:
    dsn = config.get("dsn") or os.getenv("PG_DSN") or os.getenv("DATABASE_URL")
    if not dsn:
        raise CatalogError("no Postgres DSN — set config `dsn` or the PG_DSN / DATABASE_URL env var")
    return dsn


def _ident(name: str, what: str, pat=_IDENT) -> str:
    if not name or not pat.match(name):
        raise CatalogError(f"{what} {name!r} is not a valid Postgres identifier")
    return name


def _cursor_param(cursor: str, cursor_type: str | None):
    """The stored cursor (a string) back to the column's native type for binding."""
    if cursor_type == "timestamp":
        try:
            return datetime.fromisoformat(cursor)
        except ValueError:
            return cursor
    try:
        return int(cursor)
    except (TypeError, ValueError):
        return cursor


def _connect(dsn: str):
    try:
        import asyncpg
    except ImportError:
        raise CatalogError("the postgres connector needs asyncpg — pip install navflow[postgres]")
    return asyncpg.connect(dsn)


class PostgresConnector(Connector):
    CONFIG_SCHEMA = {
        "table": {"type": "string", "required": True, "discover_input": True,
                  "help": "table to poll, e.g. orders or public.orders"},
        "dsn": {"type": "string", "secret": True, "discover_input": True,
                "help": "postgresql://user:pass@host:port/db — must be reachable from the NavFlow "
                        "host (local installs can leave this empty and set PG_DSN on the daemon)"},
        "cursor_column": {"type": "string", "required": True,
                          "help": "column that only ever grows, used to fetch just the new rows on "
                                  "each poll: an autoincrement id (captures inserts only) or "
                                  "updated_at (also captures row updates) — Discover picks this "
                                  "for you"},
        "cursor_type": {"type": "string", "default": "int",
                        "help": "int (autoincrement id) or timestamp (updated_at)"},
        "key_column": {"type": "string",
                       "help": "column whose value is the entity key, e.g. tenant_id (the primary "
                               "label). Declare it as a primary label to name the axis."},
        "time_column": {"type": "string",
                        "help": "timestamp column for event_time (default: the cursor column if it "
                                "is a timestamp, else ingest time)"},
        "limit": {"type": "number", "default": 200, "help": "rows to fetch per poll"},
    }

    async def poll(self) -> list[Envelope]:
        c = self.cfg.config
        table = _ident(c["table"], "table", _TABLE)
        cursor_col = _ident(c["cursor_column"], "cursor_column")
        limit = int(c.get("limit", 200))

        cursor = self.store.get_cursor(self.cfg.name)
        # bind the cursor as its native type (asyncpg infers $1 from the column) — not as a string
        where = f"WHERE {cursor_col} > $1 " if cursor is not None else ""
        sql = f"SELECT * FROM {table} {where}ORDER BY {cursor_col} ASC LIMIT {limit}"
        params = [_cursor_param(cursor, c.get("cursor_type"))] if cursor is not None else []

        conn = await _connect(_dsn(c))
        try:
            rows = await conn.fetch(sql, *params)
        finally:
            await conn.close()
        if not rows:
            return []

        self.store.set_cursor(self.cfg.name, str(rows[-1][cursor_col]))
        return [self._row_envelope(dict(r), table) for r in rows]

    def _row_envelope(self, row: dict, table: str) -> Envelope:
        c = self.cfg.config
        jrow = _jsonable(row)  # Decimal->float, datetime->iso (lossless + JSON-safe)
        ctx = {k: ("" if v is None else str(v)) for k, v in jrow.items()}  # row IS the label context
        key_col = c.get("key_column")
        labels, key = self.keyed(ctx, fallback=ctx.get(key_col or "", "") or table.split(".")[-1])

        # numeric columns become trigger-usable fields; the whole row stays in payload (lossless)
        fields = {k: v for k, v in jrow.items()
                  if isinstance(v, (int, float)) and not isinstance(v, bool)}

        return Envelope(
            source=self.cfg.name, source_type=self.cfg.type, key_value=key,
            event_type=table.split(".")[-1],  # one source = one table; the table names the event
            text=self._text(row, c, key),
            event_time=self._event_time(row, c),
            fields=fields, payload=jrow, labels=labels,
        )

    @staticmethod
    def _text(row: dict, c: dict, key: str) -> str:
        tmpl = c.get("text_template")
        if tmpl:
            try:
                return tmpl.format(**row)[:300]
            except (KeyError, IndexError, ValueError):
                pass
        # a compact, identifying line: key + a couple of low-noise columns if present
        head = " ".join(f"{k}={row[k]}" for k in ("status", "state", "type", "name")
                        if k in row and row[k] is not None)
        return (f"{key} {head}".strip() or _compact(row))[:300]

    def _event_time(self, row: dict, c: dict) -> datetime:
        col = c.get("time_column") or (c["cursor_column"] if c.get("cursor_type") == "timestamp" else None)
        val = row.get(col) if col else None
        if isinstance(val, datetime):
            return val
        if isinstance(val, str):
            try:
                return datetime.fromisoformat(val.replace("Z", "+00:00"))
            except ValueError:
                pass
        return now_utc()

    @classmethod
    async def discover(cls, config: dict) -> dict:
        """Introspect a table: pick a cursor column (updated_at > id), guess the entity key
        (a *_id column), infer cursor_type from the column's data type, and propose labels."""
        table = _ident(config.get("table") or "", "table", _TABLE)
        schema, name = (table.split(".") + [None])[:2] if "." in table else (None, table)
        name = name or table
        conn = await _connect(_dsn(config))
        try:
            cols = await conn.fetch(
                "SELECT column_name, data_type FROM information_schema.columns "
                "WHERE table_name = $1 AND ($2::text IS NULL OR table_schema = $2) "
                "ORDER BY ordinal_position", name, schema)
        finally:
            await conn.close()
        if not cols:
            raise ValueError(f"table {table!r} not found (or no columns visible)")

        by_name = {r["column_name"]: r["data_type"] for r in cols}
        cursor_col, cursor_type = _pick_cursor(by_name)
        key_col = _pick_key(by_name)
        labels = ([{"name": key_col, "field": key_col, "primary": True}] if key_col else [])
        # add a low-cardinality status-ish dimension if the table has one
        for dim in ("status", "state", "type", "environment", "region"):
            if dim in by_name:
                labels.append({"name": dim, "field": dim})
                break

        proposed = {"table": table, "cursor_column": cursor_col, "cursor_type": cursor_type}
        if key_col:
            proposed["key_column"] = key_col
        if labels:
            proposed["labels"] = labels
        return {
            "connector": "postgres",
            "summary": f"{table} · {len(cols)} columns · cursor {cursor_col} ({cursor_type})"
                       + (f" · keyed by {key_col}" if key_col else " · no entity column found"),
            "columns": [{"name": r["column_name"], "type": r["data_type"]} for r in cols],
            "proposed_config": proposed,
        }


_TS_TYPES = ("timestamp with time zone", "timestamp without time zone", "timestamp", "date")
_INT_TYPES = ("integer", "bigint", "smallint")


def _pick_cursor(cols: dict) -> tuple[str, str]:
    for ts in ("updated_at", "modified_at", "updated", "last_modified"):
        if ts in cols and cols[ts] in _TS_TYPES:
            return ts, "timestamp"
    for idc in ("id", "pk"):
        if idc in cols and cols[idc] in _INT_TYPES:
            return idc, "int"
    # else: first timestamp, then first int, then first column (best-effort)
    for name, typ in cols.items():
        if typ in _TS_TYPES:
            return name, "timestamp"
    for name, typ in cols.items():
        if typ in _INT_TYPES:
            return name, "int"
    first = next(iter(cols))
    return first, "int"


def _pick_key(cols: dict) -> str | None:
    for pref in ("tenant_id", "account_id", "customer_id", "org_id", "user_id", "project_id"):
        if pref in cols:
            return pref
    for name in cols:
        if name.endswith("_id"):
            return name
    return None


def _jsonable(row: dict) -> dict:
    return {k: (v.isoformat() if isinstance(v, datetime) else _scalar(v)) for k, v in row.items()}


def _scalar(v):
    from decimal import Decimal
    if isinstance(v, Decimal):
        f = float(v)
        return int(f) if f.is_integer() else f
    if isinstance(v, (dict, list, str, int, float, bool)) or v is None:
        return v
    return str(v)


def _compact(row: dict) -> str:
    import json
    return json.dumps(_jsonable(row), default=str)


# text_template is an optional config key the connector honours but doesn't require in the schema-
# generated form; declare it so it round-trips when set via YAML/API.
PostgresConnector.CONFIG_SCHEMA["text_template"] = {
    "type": "string", "advanced": True,
    "help": "optional str.format template over the row, e.g. '{tenant_id}: {status} ${amount}'",
}

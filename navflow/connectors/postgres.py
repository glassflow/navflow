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
ships with navflow.

Secret note: the `dsn` carries the password. It's a per-source parameter (config only — no env
fallback), stored as a secret: redacted in API responses and omitted from catalog exports by default.
"""
from __future__ import annotations

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
    # The connection URL is a per-source parameter (you may have several Postgres sources), so it
    # comes only from the source's config — there is no daemon-level env fallback.
    dsn = config.get("dsn")
    if not dsn:
        raise CatalogError("no Postgres DSN — set the source's `dsn` connection URL")
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
        raise CatalogError("the postgres connector needs asyncpg (it ships with navflow — reinstall if missing)")
    # bounded connect: an unreachable host (firewalled DB, wrong IP) should fail in seconds with a
    # clear error, not sit on asyncpg's 60s default while the console appears hung
    return asyncpg.connect(dsn, timeout=10)


def _db_and_table(config: dict) -> tuple[str, str]:
    """The synthetic `database` and `table` label fields for a Postgres source. Derived from config
    (not from a column), so they're always available to label/key on and reproduce on relabel with
    no DB round-trip. `table` is the bare table name (matches event_type); `database` is parsed from
    the DSN path (empty when the DSN omits it — Postgres then defaults to the user's db)."""
    tname = str(config.get("table") or "").split(".")[-1]
    db = ""
    dsn = config.get("dsn") or ""
    try:
        from urllib.parse import urlsplit
        db = urlsplit(dsn).path.lstrip("/").split("?", 1)[0]
    except Exception:
        db = ""
    return db, tname


def _select_clause(config: dict, cursor_column: str) -> str:
    """The SELECT list. Empty `columns` config -> '*' (all columns). Otherwise the listed columns,
    ALWAYS including the cursor/key/time columns the connector reads from each row (else the cursor
    can't advance and the key/time can't be resolved). Every name is validated as a safe identifier
    (it's interpolated into SQL)."""
    raw = str(config.get("columns") or "").strip()
    if not raw:
        return "*"
    cols, seen = [], set()
    for name in [*raw.split(","), cursor_column, config.get("key_column"), config.get("time_column")]:
        if not name or not str(name).strip():
            continue
        ident = _ident(str(name).strip(), "column")
        if ident not in seen:
            seen.add(ident)
            cols.append(ident)
    return ", ".join(cols)


class PostgresConnector(Connector):
    CONFIG_SCHEMA = {
        "dsn": {"type": "string", "secret": True, "required": True, "discover_input": True,
                "help": "postgresql://user:pass@host:port/dbname — this source's connection URL (the "
                        "path after the slash picks the database; omitted, Postgres defaults to a db "
                        "named after the user). Must be reachable from the NavFlow host. Stored as a "
                        "secret: redacted in the API and omitted from catalog exports."},
        # NOT discover_input: you don't fill the table in before discovering — Discover (which only
        # needs the DSN) lists the tables and you pick one. So the form shows Discover right after
        # the DSN, and the table field below it.
        "table": {"type": "string", "required": True,
                  "help": "table to poll, e.g. orders or public.orders — leave empty and Discover "
                          "lists the tables it can see"},
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
        "columns": {"type": "string",
                    "help": "comma-separated columns to pull, e.g. id,status,amount — empty pulls "
                            "every column (SELECT *). The cursor/key/time columns are always "
                            "included so the source still works. `database` and `table` are also "
                            "available as fields (from config) regardless of what you select."},
        "limit": {"type": "number", "default": 200, "help": "rows to fetch per poll"},
    }

    async def poll(self) -> list[Envelope]:
        c = self.cfg.config
        table = _ident(c["table"], "table", _TABLE)
        cursor_col = _ident(c["cursor_column"], "cursor_column")
        limit = int(c.get("limit", 200))

        select = _select_clause(c, c["cursor_column"])
        cursor = self.store.get_cursor(self.cfg.name)
        # bind the cursor as its native type (asyncpg infers $1 from the column) — not as a string
        where = f"WHERE {cursor_col} > $1 " if cursor is not None else ""
        sql = f"SELECT {select} FROM {table} {where}ORDER BY {cursor_col} ASC LIMIT {limit}"
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

    def label_context(self, payload: dict | None) -> dict:
        """Row columns PLUS the synthetic `database`/`table` fields (from config), so both can be
        labeled/keyed and reproduce on relabel. A real column of the same name wins (setdefault)."""
        ctx = dict(payload or {})
        db, tname = _db_and_table(self.cfg.config)
        ctx.setdefault("database", db)
        ctx.setdefault("table", tname)
        return ctx

    def _row_envelope(self, row: dict, table: str) -> Envelope:
        c = self.cfg.config
        jrow = _jsonable(row)  # Decimal->float, datetime->iso (lossless + JSON-safe)
        ctx = {k: ("" if v is None else str(v)) for k, v in jrow.items()}  # row IS the label context
        db, tname = _db_and_table(c)
        ctx.setdefault("database", db)   # synthetic fields — a real column of the same name wins
        ctx.setdefault("table", tname)
        key_col = c.get("key_column")
        labels, key = self.keyed(ctx, fallback=ctx.get(key_col or "", "") or table.split(".")[-1])

        return Envelope(
            source=self.cfg.name, source_type=self.cfg.type, key_value=key,
            event_type=table.split(".")[-1],  # one source = one table; the table names the event
            text=self._text(row, c, key),
            event_time=self._event_time(row, c),
            payload=jrow, labels=labels,
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
        """Two-stage introspection. Without a table: list the tables the DSN can see, for the user
        to pick. With a table: pick a cursor column (updated_at > id), guess the entity key
        (a *_id column), infer cursor_type from the column's data type, and propose labels."""
        if not config.get("table"):
            conn = await _connect(_dsn(config))
            try:
                db = await conn.fetchval("SELECT current_database()")
                rows = await conn.fetch(
                    "SELECT table_schema, table_name FROM information_schema.tables "
                    "WHERE table_type = 'BASE TABLE' "
                    "AND table_schema NOT IN ('pg_catalog', 'information_schema') "
                    "ORDER BY table_schema, table_name")
            finally:
                await conn.close()
            if not rows:
                raise ValueError(f"connected to database {db!r}, but no tables are visible — "
                                 "wrong database in the DSN (the path after the slash), or the "
                                 "user lacks privileges")
            tables = [r["table_name"] if r["table_schema"] == "public"
                      else f"{r['table_schema']}.{r['table_name']}" for r in rows]
            return {"connector": "postgres", "tables": tables,
                    "summary": f"connected to database {db!r} — {len(tables)} tables; "
                               "pick one to introspect (another database needs its own "
                               "source with its DSN)"}
        table = _ident(config["table"], "table", _TABLE)
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

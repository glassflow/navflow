"""Postgres connector — discover + incremental poll against a live Postgres.

Skips cleanly if no Postgres is reachable (set PG_TEST_DSN, or rely on the cookbook default).
Run with the platform stack up: postgresql://demo:demo@127.0.0.1:5432/demo
"""
import asyncio, os, sys

from tares.config import SourceCfg, CatalogError
from tares.connectors.postgres import PostgresConnector, _pick_cursor, _pick_key

DSN = os.getenv("PG_TEST_DSN", "postgresql://demo:demo@127.0.0.1:5432/demo")

P = F = 0
def ck(l, c, d=""):
    global P, F; P += 1 if c else 0; F += 0 if c else 1
    print(("  ok   " if c else "  FAIL ") + l + ("" if c else f"  {d}"))


class FakeStore:
    def __init__(self): self.cur = {}
    def get_cursor(self, n): return self.cur.get(n)
    def set_cursor(self, n, v): self.cur[n] = v


def cfg(config):
    return SourceCfg(name="pg", type="event_stream", connector="postgres",
                     poll_seconds=5, config=config)


async def reachable():
    try:
        import asyncpg
        c = await asyncpg.connect(DSN); await c.close(); return True
    except Exception as e:
        print(f"SKIP test_postgres: no Postgres at {DSN} ({type(e).__name__})"); return False


def test_pickers():
    cc, ct = _pick_cursor({"id": "integer", "tenant_id": "text", "updated_at": "timestamp with time zone"})
    ck("pick cursor prefers updated_at (timestamp)", (cc, ct) == ("updated_at", "timestamp"), f"{cc},{ct}")
    cc, ct = _pick_cursor({"id": "bigint", "name": "text"})
    ck("pick cursor falls back to id (int)", (cc, ct) == ("id", "int"), f"{cc},{ct}")
    ck("pick key prefers tenant_id", _pick_key({"id": "bigint", "tenant_id": "text"}) == "tenant_id")
    ck("pick key None when no *_id", _pick_key({"id": "bigint", "name": "text"}) is None)


async def test_sql_safety():
    bad = PostgresConnector(cfg({"table": "orders; DROP TABLE x", "cursor_column": "id"}), FakeStore())
    try:
        await bad.poll()
        ck("rejects injection in table name", False, "no error raised")
    except CatalogError:
        ck("rejects injection in table name", True)


async def main():
    test_pickers()
    await test_sql_safety()
    if not await reachable():
        print(f"\n{P} passed, {F} failed (live tests skipped)"); return

    # discover orders -> updated_at cursor, tenant_id key, status label
    prop = await PostgresConnector.discover({"dsn": DSN, "table": "orders"})
    pc = prop["proposed_config"]
    ck("discover orders -> cursor updated_at", pc["cursor_column"] == "updated_at", str(pc))
    ck("discover proposes no separate key_column (key is a primary label)", "key_column" not in pc, str(pc))
    ck("discover orders -> primary label tenant_id + status facet",
       pc["labels"][0] == {"name": "tenant_id", "field": "tenant_id", "primary": True}
       and any(l["name"] == "status" for l in pc["labels"]), str(pc.get("labels")))

    # discover users -> int id cursor, no entity column
    up = (await PostgresConnector.discover({"dsn": DSN, "table": "users"}))["proposed_config"]
    ck("discover users -> cursor id", up["cursor_column"] == "id", str(up))
    ck("discover users -> no entity column", "key_column" not in up, str(up))

    # poll orders incrementally, keyed by tenant_id, status faceted
    store = FakeStore()
    conn = PostgresConnector(cfg({
        "dsn": DSN, "table": "orders", "cursor_column": "id",
        "labels": [{"name": "tenant_id", "field": "tenant_id", "primary": True},
                   {"name": "status", "field": "status"}],
    }), store)
    evs = await conn.poll()
    ck("first poll returns all rows", len(evs) >= 5, str(len(evs)))
    e0 = evs[0]
    ck("row keyed by tenant_id value", e0.key_value in ("acme", "globex"), e0.key_value)
    ck("labels faceted (tenant_id + status)", set(e0.labels) == {"tenant_id", "status"}, str(e0.labels))
    ck("all columns preserved in payload (id, amount)", "id" in e0.payload and "amount" in e0.payload, str(e0.payload))
    ck("event_type is the table name", e0.event_type == "orders", e0.event_type)
    ck("payload is lossless + json-able", e0.payload.get("tenant_id") == e0.key_value, str(e0.payload)[:80])

    empty = await conn.poll()
    ck("second poll is empty (cursor advanced)", empty == [], str(len(empty)))

    # a new row flows through on the next poll
    import asyncpg
    c = await asyncpg.connect(DSN)
    await c.execute("INSERT INTO orders (tenant_id, status, amount) VALUES ('initech', 'created', 5.0)")
    await c.close()
    nxt = await conn.poll()
    ck("new row picked up incrementally", len(nxt) == 1 and nxt[0].key_value == "initech", str([e.key_value for e in nxt]))

    # timestamp cursor path: poll, advance (cursor stored as iso string), second poll empty
    tstore = FakeStore()
    tconn = PostgresConnector(cfg({
        "dsn": DSN, "table": "orders", "cursor_column": "updated_at",
    }), tstore)
    t1 = await tconn.poll()
    ck("timestamp-cursor first poll returns rows", len(t1) >= 6, str(len(t1)))
    ck("timestamp-cursor event_time from updated_at", t1[0].event_time.year >= 2025, str(t1[0].event_time))
    t2 = await tconn.poll()
    ck("timestamp-cursor second poll empty (iso round-trip)", t2 == [], str(len(t2)))

    print(f"\n{P} passed, {F} failed")


asyncio.run(main())
sys.exit(1 if F else 0)

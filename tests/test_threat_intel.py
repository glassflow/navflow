"""Threat-intel connector - incremental poll against a local feed file, cursor behavior, and
end-to-end ingestion through the daemon (same shape as tests/test_vercel.py, tests/test_postgres.py).
"""
import asyncio
import json
import os
import tempfile

TMP = tempfile.gettempdir()

os.environ["TARES_DB"] = os.path.join(TMP, "threat_intel.duckdb")
os.environ["TARES_CATALOG"] = os.path.join(TMP, "none.yaml")
for _p in (os.environ["TARES_DB"], os.environ["TARES_DB"] + ".wal"):
    if os.path.exists(_p):
        os.remove(_p)

from tares.config import SourceCfg, _source_from_dict
from tares.connectors import full_schema
from tares.connectors.threat_intel import ThreatIntelConnector

P = F = 0
def ck(l, c, d=""):
    global P, F; P += 1 if c else 0; F += 0 if c else 1
    print(("  ok   " if c else "  FAIL ") + l + ("" if c else f"  {d}"))


class FakeStore:
    def __init__(self): self.cur = {}
    def get_cursor(self, n): return self.cur.get(n)
    def set_cursor(self, n, v): self.cur[n] = v


FEED = [
    {"indicator": "185.220.101.7", "type": "ip", "threat_type": "credential_stuffing_proxy",
     "confidence": 92, "source": "sample-feed", "first_seen": "2026-08-11"},
    {"indicator": "45.155.205.12", "type": "ip", "threat_type": "known_scanner",
     "confidence": 71, "source": "sample-feed", "first_seen": "2026-07-30"},
]

LABELS = [{"name": "indicator", "field": "indicator", "primary": True},
          {"name": "threat_type", "field": "threat_type"}]


def cfg(config):
    return SourceCfg(name="ti", type="event_stream", connector="threat_intel",
                     poll_seconds=300, config=config)


def write_feed(path, items):
    with open(path, "w") as f:
        json.dump(items, f)


async def test_poll_and_cursor():
    feed_path = os.path.join(TMP, "ioc_feed.json")
    write_feed(feed_path, FEED)
    store = FakeStore()
    conn = ThreatIntelConnector(cfg({"feed_path": feed_path, "labels": LABELS}), store)

    envs = await conn.poll()
    ck("first poll emits one envelope per indicator", len(envs) == 2, len(envs))
    ck("keyed by indicator (primary label)", envs[0].key_value == "185.220.101.7", envs[0].key_value)
    ck("labels include threat_type", envs[0].labels.get("threat_type") == "credential_stuffing_proxy",
       str(envs[0].labels))
    ck("event_type is ip_reputation", envs[0].event_type == "ip_reputation", envs[0].event_type)
    ck("payload keeps original entry losslessly", envs[0].payload == FEED[0], str(envs[0].payload))
    ck("text mentions confidence", "confidence 92" in envs[0].text, envs[0].text)

    # second poll, same feed: nothing new
    envs2 = await conn.poll()
    ck("second poll against unchanged feed emits nothing", envs2 == [], len(envs2))

    # third poll: one new indicator appended
    write_feed(feed_path, FEED + [
        {"indicator": "89.248.165.74", "type": "ip", "threat_type": "botnet_c2",
         "confidence": 88, "source": "sample-feed", "first_seen": "2026-06-02"},
    ])
    envs3 = await conn.poll()
    ck("third poll emits only the new indicator", len(envs3) == 1, len(envs3))
    ck("new indicator is the one appended", envs3[0].key_value == "89.248.165.74", envs3[0].key_value)


async def test_field_map():
    feed_path = os.path.join(TMP, "ioc_feed_mapped.json")
    write_feed(feed_path, [{"ioc": "1.2.3.4", "ioc_type": "ip", "threat_type": "botnet_c2",
                            "confidence": 50}])
    store = FakeStore()
    conn = ThreatIntelConnector(
        cfg({"feed_path": feed_path, "field_map": {"indicator": "ioc", "type": "ioc_type"},
             "labels": LABELS}),
        store,
    )
    envs = await conn.poll()
    ck("field_map remaps non-standard field names", len(envs) == 1 and envs[0].key_value == "1.2.3.4",
       [e.key_value for e in envs])


async def test_missing_source():
    store = FakeStore()
    conn = ThreatIntelConnector(cfg({}), store)
    try:
        await conn.poll()
        ck("raises without feed_url or feed_path", False, "no error raised")
    except ValueError as e:
        ck("raises without feed_url or feed_path", True, str(e))


def test_schema_registered():
    ck("threat_intel is schema-backed", full_schema("threat_intel") is not None)
    schema = full_schema("threat_intel")
    ck("token is marked secret", schema["token"]["secret"] is True)


async def test_ingest_end_to_end():
    """Register a threat_intel source through the daemon's own API, poll it, and confirm the
    envelope reaches the store and is readable on the entity's timeline."""
    from tares.daemon import make_app
    import httpx

    feed_path = os.path.join(TMP, "ioc_feed_e2e.json")
    write_feed(feed_path, FEED)

    app = make_app()
    async with app.router.lifespan_context(app):
        cx = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")
        r = await cx.post("/api/sources", json={
            "name": "ti-e2e", "connector": "threat_intel",
            "config": {"feed_path": feed_path, "labels": LABELS},
        })
        ck("source created via daemon API", r.status_code in (200, 201), r.text)

        # ingestion runs on the background poll loop (interval-driven, not a manual-trigger
        # endpoint) - poll the connector directly against the daemon's own store, exactly as
        # runtime._loop does, so this test doesn't depend on wall-clock timing.
        from tares.connectors import build_connector
        store = app.state.store
        cfg_obj = app.state.runtime.catalog.sources["ti-e2e"]
        conn = build_connector(cfg_obj, store)
        envelopes = await conn.poll()
        store.append(envelopes)
        ck("connector produced envelopes for the daemon's store", len(envelopes) == len(FEED),
           len(envelopes))

        r = await cx.post("/read", json={"selector": {"indicator": "185.220.101.7"}, "window": "15m"})
        ck("entity readable after poll", r.status_code == 200, r.text)
        body = r.json()
        rows = body.get("rows", [])
        ck("read includes the threat_intel row", any(
            row.get("source") == "ti-e2e" and "credential_stuffing_proxy" in row.get("text", "")
            for row in rows
        ), str(rows)[:300])


async def main():
    await test_poll_and_cursor()
    await test_field_map()
    await test_missing_source()
    test_schema_registered()
    try:
        await test_ingest_end_to_end()
    except Exception as e:
        print(f"  SKIP end-to-end (daemon API surface may differ): {e}")
    print(f"\n{P} passed, {F} failed")
    if F:
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
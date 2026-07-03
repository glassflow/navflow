"""Runtime — the daemon's live state: the DB-backed catalog plus one poll task per source.

This replaces the static start-everything-at-boot loop: sources are started, stopped, paused and
reconfigured at runtime as the catalog changes (no restart). Health (last poll, last error, counts)
is tracked in memory; per-source event totals come from the events table.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from .config import Catalog, SourceCfg, catalog_from_db
from .connectors import REGISTRY, SPECS, build_connector
from .envelope import now_utc
from .triggers import eval_triggers


@dataclass
class SourceHealth:
    status: str = "starting"        # starting | ok | error | paused | push
    last_poll_at: object = None
    last_ok_at: object = None
    last_error: str | None = None
    consecutive_errors: int = 0
    polls: int = 0
    events_since_start: int = 0


@dataclass
class SourceRuntime:
    cfg: SourceCfg
    task: asyncio.Task | None = None
    health: SourceHealth = field(default_factory=SourceHealth)


class Runtime:
    def __init__(self, store, dispatcher):
        self.store = store
        self.dispatcher = dispatcher
        self.catalog: Catalog = catalog_from_db(store)
        self.sources: dict[str, SourceRuntime] = {}

    # ── lifecycle ─────────────────────────────────────────────────────────────
    def start_all(self) -> None:
        for cfg in self.catalog.sources.values():
            self._start(cfg)

    def shutdown(self) -> None:
        for rt in self.sources.values():
            if rt.task:
                rt.task.cancel()
        self.sources.clear()

    def _start(self, cfg: SourceCfg) -> None:
        rt = SourceRuntime(cfg=cfg)
        if cfg.paused:
            rt.health.status = "paused"
        elif SPECS.get(cfg.connector, {}).get("mode") == "push":
            rt.health.status = "push"   # no poll loop; envelopes arrive via /ingest
        else:
            rt.task = asyncio.create_task(self._loop(rt))
        self.sources[cfg.name] = rt

    def _stop(self, name: str) -> None:
        rt = self.sources.pop(name, None)
        if rt and rt.task:
            rt.task.cancel()

    async def _loop(self, rt: SourceRuntime) -> None:
        conn = build_connector(rt.cfg, self.store)
        while True:
            h = rt.health
            h.last_poll_at = now_utc()
            h.polls += 1
            try:
                envelopes = await conn.poll()
                self.store.append(envelopes)
                h.events_since_start += len(envelopes)
                h.last_ok_at = now_utc()
                h.last_error, h.consecutive_errors, h.status = None, 0, "ok"
                if envelopes:
                    await eval_triggers(self.store, self.catalog, self.dispatcher,
                                        affected_sources={rt.cfg.name})
            except Exception as e:  # never let one source kill the loop
                h.last_error = str(e)
                h.consecutive_errors += 1
                h.status = "error"
                print(f"[connector {rt.cfg.name}] error: {e}")
            await asyncio.sleep(rt.cfg.poll_seconds)

    # ── catalog mutations (already persisted to the store by the caller) ─────
    def reload_catalog(self) -> None:
        """Re-read views/triggers (and source defs) from the store; restart changed sources."""
        new = catalog_from_db(self.store)
        old_sources = self.catalog.sources
        self.catalog = new

        for name in set(old_sources) - set(new.sources):
            self._stop(name)
        for name, cfg in new.sources.items():
            if name not in self.sources:
                self._start(cfg)
            elif old_sources.get(name) != cfg:
                self._stop(name)
                self._start(cfg)

    # ── push ingestion (webhook / memory / otlp sources) ──────────────────────
    def _push_cfg(self, token: str):
        # /ingest/<token>: match the stable ingest_key first, then the source name (back-compat for
        # name-based URLs and YAML sources without a key).
        cfg = next((c for c in self.catalog.sources.values()
                    if c.ingest_key and c.ingest_key == token), None)
        if cfg is None:
            cfg = self.catalog.sources.get(token)
        if cfg is None:
            raise KeyError(f"unknown source {token!r}")
        # push sources, plus poll connectors that opt into accepting pushes too (claude_code can be
        # tailed locally *or* fed by its Claude Code plugin via /ingest).
        is_push = SPECS.get(cfg.connector, {}).get("mode") == "push"
        accepts_push = getattr(REGISTRY.get(cfg.connector), "ACCEPTS_PUSH", False)
        if not (is_push or accepts_push):
            raise ValueError(f"source {cfg.name!r} is not a push source")
        if cfg.paused:
            raise ValueError(f"source {cfg.name!r} is paused")
        return cfg

    async def _store_envelopes(self, source_name: str, envelopes: list) -> int:
        """Append envelopes, update health, fire triggers — the common ingest tail."""
        self.store.append(envelopes)
        rt = self.sources.get(source_name)
        if rt:
            rt.health.events_since_start += len(envelopes)
            rt.health.last_ok_at = now_utc()
        if envelopes:
            await eval_triggers(self.store, self.catalog, self.dispatcher,
                                affected_sources={source_name})
        return len(envelopes)

    def _ensure_push_wins(self, cfg) -> None:
        """Push wins: the first pushed event to a poll-mode source that also accepts pushes
        (claude_code — tailable locally *or* fed by its Claude Code plugin) flips it to push mode,
        so the daemon stops tailing files the plugin is now feeding. Without this, a source created
        as a local tail (e.g. via the console's Connect card) and *also* fed by the plugin ingests
        every event twice. Persisted + reloaded so the running poller actually stops. No-op for
        native push connectors (no poll() to conflict with) and for sources already in push mode."""
        if SPECS.get(cfg.connector, {}).get("mode") == "push" or cfg.config.get("push"):
            return
        self.store.upsert_catalog_source(cfg.name, cfg.type, cfg.connector, cfg.poll,
                                         {**cfg.config, "push": True},
                                         paused=cfg.paused, ingest_key=cfg.ingest_key)
        self.reload_catalog()

    async def ingest(self, token: str, payload) -> int:
        cfg = self._push_cfg(token)   # token may be the ingest_key or the source name
        self._ensure_push_wins(cfg)   # first push flips a tail source to push mode (no double-ingest)
        conn = build_connector(cfg, self.store)
        return await self._store_envelopes(cfg.name, conn.map_payload(payload))

    async def ingest_otlp(self, source_name: str, signal: str, body) -> int:
        cfg = self._push_cfg(source_name)
        if cfg.connector != "otlp":
            raise ValueError(f"source {cfg.name!r} is not an OTLP source")
        conn = build_connector(cfg, self.store)
        return await self._store_envelopes(cfg.name, conn.map_otlp(signal, body))

    # ── health/introspection ──────────────────────────────────────────────────
    def health_snapshot(self) -> dict:
        """{source: health dict} merged with persisted event totals."""
        totals = {s["source"]: s for s in self.store.event_stats()}
        out = {}
        for name, rt in self.sources.items():
            h = rt.health
            t = totals.get(name, {})
            out[name] = {
                "status": h.status,
                "last_poll_at": h.last_poll_at,
                "last_ok_at": h.last_ok_at,
                "last_error": h.last_error,
                "consecutive_errors": h.consecutive_errors,
                "polls": h.polls,
                "events_since_start": h.events_since_start,
                "events_total": t.get("events", 0),
                "last_ingest": t.get("last_ingest"),
            }
        return out

    async def test_source(self, cfg: SourceCfg) -> dict:
        """One poll with the given config; cursor is restored so the real loop misses nothing."""
        if SPECS.get(cfg.connector, {}).get("mode") == "push":
            return {"ok": True, "events": 0,
                    "note": f"push source: POST JSON to /ingest/{cfg.name} to ingest"}
        saved_cursor = self.store.get_cursor(cfg.name)
        try:
            conn = build_connector(cfg, self.store)
            envelopes = await asyncio.wait_for(conn.poll(), timeout=15)
            sample = [e.text for e in envelopes[:3]]
            return {"ok": True, "events": len(envelopes), "sample": sample}
        except Exception as e:
            return {"ok": False, "error": str(e)}
        finally:
            if saved_cursor is not None:
                self.store.set_cursor(cfg.name, saved_cursor)
            else:
                self.store.delete_cursor(cfg.name)

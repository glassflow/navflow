"""Agent memory connector — push ingestion of the agent's own observations, closing the loop:
what the agent writes back becomes a NavFlow source like any other, joinable into the same
correlated reads (design doc journey step 7).

Payloads arrive via POST /remember (or POST /ingest/{source}) shaped:
  { key: "api-server", content: "p99 spikes correlate with deploys of payments",
    memory_type: "observation",         # observation | aggregation | decision | custom
    fields: {confidence: 0.8} }         # optional, numeric values become trigger-usable

Collapsed from the design doc's bi-temporal silver_memory table (§6.3.5): append-only, no
valid_at/invalid_at revision semantics — the honest DuckDB form.

config:
  key: agent                  # fallback entity key when the payload has none
"""
from __future__ import annotations

from ..envelope import Envelope, now_utc
from .base import Connector

_MEMORY_TYPES = {"observation", "aggregation", "decision"}


class MemoryConnector(Connector):
    CONFIG_SCHEMA = {
        "key": {"type": "string",
                "help": "fallback entity key when a memory's payload has none (default: agent)"},
    }

    async def poll(self) -> list[Envelope]:
        return []  # push-only: envelopes arrive via map_payload

    def map_payload(self, payload) -> list[Envelope]:
        items = payload if isinstance(payload, list) else [payload]
        return [self._map_one(item) for item in items]

    def _map_one(self, item) -> Envelope:
        if not isinstance(item, dict):
            item = {"content": str(item)}

        content = str(item.get("content", "")).strip()
        if not content:
            raise ValueError("memory payload needs a non-empty 'content'")

        fallback = str(item.get("key") or self.cfg.config.get("key", "agent"))
        labels, key = self.keyed(item, fallback=fallback)
        memory_type = str(item.get("memory_type", "observation"))
        if memory_type not in _MEMORY_TYPES:
            memory_type = f"custom:{memory_type}"

        extra = item.get("fields") or {}
        fields = {k: v for k, v in extra.items()
                  if isinstance(v, (int, float)) and not isinstance(v, bool)}

        return Envelope(
            source=self.cfg.name, source_type=self.cfg.type, key_value=key,
            event_type=memory_type, text=content, event_time=now_utc(),
            fields=fields, payload=item, labels=labels,
        )

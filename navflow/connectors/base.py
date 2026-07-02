"""Connector contract — each source is a poll loop that returns Envelopes."""
from __future__ import annotations

from abc import ABC, abstractmethod

from ..config import SourceCfg, extract_labels
from ..envelope import Envelope

# Config keys every connector accepts, merged after each connector's own CONFIG_SCHEMA so they
# sort last in the canonical form. `labels` is the universal correlation-axis declaration.
UNIVERSAL_CONFIG = {
    "labels": {"type": "labels", "default": [],
               "help": "named correlation axes (const | field) each event carries"},
}


class Connector(ABC):
    def __init__(self, cfg: SourceCfg, store):
        self.cfg = cfg
        self.store = store  # for cursor get/set on incremental sources

    def labels_for(self, context: dict | None = None) -> dict:
        """Named labels for one event, from this source's `labels` config and a per-event
        context dict (payload, series labels, parsed log groups). Empty if none declared."""
        return extract_labels(self.cfg.config.get("labels", []), context or {})

    def label_context(self, payload: dict | None) -> dict:
        """The per-event context labels are extracted from, reconstructed from a stored payload.
        Default: the payload itself (labels map verbatim payload fields). Connectors that *synthesize*
        or rename label fields (e.g. Vercel derives `project` from projectName/projectId) must override
        this with the SAME logic they use at ingest, so retroactive relabel (backfill) reproduces the
        synthesized labels instead of dropping them."""
        return payload or {}

    def _primary_label(self) -> str | None:
        """Name of the label explicitly marked `primary` (the entity key), or None. We do NOT
        auto-pick the first label — a source with labels but no marked primary keeps keying by its
        legacy key config (backward compatible); only an explicit primary takes over."""
        for spec in self.cfg.config.get("labels", []) or []:
            if spec.get("primary"):
                return spec.get("name")
        return None

    def keyed(self, context: dict | None = None, fallback: str = "unknown") -> tuple[dict, str]:
        """(labels, key_value) for one event. The key is the value of the primary label — a key
        is just the label you've marked primary. Falls back to `fallback` (the connector's legacy
        key config) when no labels are declared, so existing sources keep working unchanged."""
        labels = self.labels_for(context)
        primary = self._primary_label()
        key = labels.get(primary) if primary else None
        return labels, key or fallback

    @abstractmethod
    async def poll(self) -> list[Envelope]:
        """Fetch since the last poll; return new Envelopes (possibly empty)."""
        raise NotImplementedError

    @classmethod
    async def discover(cls, config: dict) -> dict | None:
        """Introspect the upstream and propose a source config (key, labels, what to ingest).
        Deterministic — no LLM. Returns None for connectors that can't introspect."""
        return None

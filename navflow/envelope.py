"""The Envelope — the one record shape that travels through the system.

A connector produces Envelopes; the store persists them; views render them; triggers evaluate over
them. Collapsed from the design doc's Bronze record + Silver event into a single shape: the typed
fields give structure, the `payload` keeps the original (lossless).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class Envelope:
    source: str            # logical source name, e.g. "metrics", "deploys"
    source_type: str       # event_stream | application_log | ...
    key_value: str         # the primary/default label value, e.g. "api-server" (legacy single key)
    event_type: str        # "deploy" | "5xx_rate" | "error_log" | ...
    text: str              # the rendered line an agent reads
    event_time: datetime   # source_time if known, else ingest_time
    fields: dict = field(default_factory=dict)    # typed extract (used by triggers)
    payload: dict = field(default_factory=dict)   # the original, lossless
    # Named correlation axes for this event, e.g. {"env": "prod", "app": "ui"}. The store
    # can query/group by any of them. `key_value` is the default label; connectors populate
    # `labels` when a source declares more than one. Empty for legacy single-key sources.
    labels: dict = field(default_factory=dict)
    ingest_time: datetime = field(default_factory=now_utc)

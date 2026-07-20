"""Static connector — one-time raw-text import.

For data points that aren't worth a live poll: a config value, a deploy line, a synthesized alert.
Emits the configured records once (cursor-guarded), then nothing. This is how the Anthropic-stack
cookbook surfaces config/deploys/alerts (file-based + simulated), per the agreed approach: import
them as one-time raw text rather than building file-watching connectors.
"""
from __future__ import annotations

from datetime import timedelta

from ..envelope import Envelope, now_utc
from .base import Connector


class StaticConnector(Connector):
    CONFIG_SCHEMA = {
        "records": {"type": "object", "required": True,
                    "help": "list of {text, event_type?, ago_seconds?, key?, fields?} records, imported once"},
        "key": {"type": "string",
                "help": "default entity key for records that don't set their own"},
    }

    async def poll(self):
        if self.store.get_cursor(self.cfg.name) == "done":
            return []
        self.store.set_cursor(self.cfg.name, "done")
        default_key = self.cfg.config.get("key", "api-server")
        out = []
        for rec in self.cfg.config.get("records", []):
            ago = float(rec.get("ago_seconds", 0))
            out.append(Envelope(
                source=self.cfg.name, source_type=self.cfg.type,
                key_value=rec.get("key", default_key),
                event_type=rec.get("event_type", "static"),
                text=rec["text"], event_time=now_utc() - timedelta(seconds=ago),
                payload={"text": rec["text"]},
                labels=self.labels_for(rec),
            ))
        return out

"""Config connector — polls the api-server config snapshot. Emits only when it changes (hash dedupe).

Hands over the raw config as-is; the agent decides what looks wrong (no drift flagging here).
"""
from __future__ import annotations

import hashlib
import json

import httpx

from ..envelope import Envelope, now_utc
from .base import Connector


class ConfigConnector(Connector):
    CONFIG_SCHEMA = {
        "url": {"type": "string", "required": True,
                "help": "config endpoint, e.g. http://localhost:8080/admin/config"},
        "key": {"type": "string", "advanced": True,
                "help": "legacy fixed key — prefer a primary label"},
    }

    async def poll(self):
        url = self.cfg.config["url"]
        key_fallback = self.cfg.config.get("key", "api-server")
        try:
            async with httpx.AsyncClient(timeout=10) as cx:
                cfg = (await cx.get(url)).json()
        except Exception:
            return []

        digest = hashlib.sha1(json.dumps(cfg, sort_keys=True).encode()).hexdigest()
        if self.store.get_cursor(self.cfg.name) == digest:
            return []
        self.store.set_cursor(self.cfg.name, digest)

        text = "api-server config: " + ", ".join(f"{k}={v}" for k, v in cfg.items())
        labels, key = self.keyed(cfg, fallback=key_fallback)
        return [Envelope(
            source=self.cfg.name, source_type=self.cfg.type, key_value=key,
            event_type="config", text=text, event_time=now_utc(), fields=cfg, payload=cfg,
            labels=labels,
        )]

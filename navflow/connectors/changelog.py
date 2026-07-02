"""Changelog connector — polls the api-server deploy log. Cursor = last-seen timestamp.

Emits one deploy Envelope per new entry. The rendered text deliberately omits the internal lever
(commit + author + message only), so the agent has to correlate the deploy with the symptoms
rather than read the answer off a config diff. The lever is kept in `fields` for internal use.
"""
from __future__ import annotations

from datetime import datetime, timezone

import httpx

from ..envelope import Envelope
from .base import Connector


class ChangelogConnector(Connector):
    CONFIG_SCHEMA = {
        "url": {"type": "string", "required": True,
                "help": "changelog endpoint, e.g. http://localhost:8080/admin/changelog"},
        "limit": {"type": "number", "help": "max entries to fetch per poll"},
        "key": {"type": "string", "advanced": True,
                "help": "legacy fixed key — prefer a primary label"},
    }

    async def poll(self):
        url = self.cfg.config["url"]
        key_fallback = self.cfg.config.get("key", "api-server")
        try:
            async with httpx.AsyncClient(timeout=10) as cx:
                changes = (await cx.get(url)).json().get("changes", [])
        except Exception:
            return []

        cur = self.store.get_cursor(self.cfg.name)
        last = float(cur) if cur else 0.0
        new_last = last
        out = []
        for c in changes:
            ts = float(c.get("ts", 0))
            new_last = max(new_last, ts)
            if ts <= last or c.get("lever") == "reset":
                continue
            event_time = datetime.fromtimestamp(ts, tz=timezone.utc)
            text = (f"deploy {c.get('commit', '')} by {c.get('author', '?')} "
                    f"— '{c.get('message', '')}'")
            labels, key = self.keyed(c, fallback=key_fallback)
            out.append(Envelope(
                source=self.cfg.name, source_type=self.cfg.type, key_value=key,
                event_type="deploy", text=text, event_time=event_time,
                fields={"lever": c.get("lever")}, payload=c, labels=labels,
            ))
        if new_last > last:
            self.store.set_cursor(self.cfg.name, str(new_last))
        lim = self.cfg.config.get("limit")
        if lim:
            out = out[-int(lim):]  # e.g. limit:1 -> only the most-recent deploy (current incident)
        return out

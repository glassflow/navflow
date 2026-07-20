"""Alerts connector — synthesizes a FIRING alert from the Prometheus 5xx ratio.

In real NavFlow, alerts would be their own source (e.g. an Alertmanager webhook). For the cookbook
they're synthesized at ingest, matching the dummy's behavior.
"""
from __future__ import annotations

import httpx

from ..envelope import Envelope, now_utc
from .base import Connector

_BAD = ("NaN", "+Inf", "-Inf")


class AlertsConnector(Connector):
    CONFIG_SCHEMA = {
        "url": {"type": "string", "required": True, "help": "Prometheus base URL"},
        "ratio_promql": {"type": "string", "required": True,
                         "help": "PromQL expression returning the ratio to watch"},
        "threshold": {"type": "number", "default": 5,
                      "help": "fire when the ratio exceeds this value"},
        "key": {"type": "string", "advanced": True,
                "help": "legacy fixed key — prefer a primary label"},
    }

    async def poll(self):
        url = self.cfg.config["url"].rstrip("/") + "/api/v1/query"
        expr = self.cfg.config["ratio_promql"]
        key_fallback = self.cfg.config.get("key", "api-server")
        threshold = float(self.cfg.config.get("threshold", 5))
        try:
            async with httpx.AsyncClient(timeout=10) as cx:
                res = (await cx.get(url, params={"query": expr})).json().get("data", {}).get("result", [])
        except Exception:
            return []
        if not res:
            return []
        raw = res[0].get("value", [None, None])[1]
        if raw in _BAD or raw is None:
            return []
        ratio = float(raw)
        if ratio <= threshold:
            return []
        labels, key = self.keyed({"ratio": ratio}, fallback=key_fallback)
        text = f"FIRING (critical): HighErrorRate {ratio:.0f}% on {key}"
        return [Envelope(
            source=self.cfg.name, source_type=self.cfg.type, key_value=key,
            event_type="alert", text=text, event_time=now_utc(),
            payload={"ratio": ratio}, labels=labels,
        )]

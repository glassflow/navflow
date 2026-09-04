"""Threat-intel feed connector - polls a JSON indicator feed (the normalized shape a MISP, OTX, or
AbuseIPDB export flattens to: indicator, type, threat_type, confidence, source, first_seen) and
emits one Envelope per indicator, keyed by the indicator value itself (an IP, domain, or hash).

Point this at the same feed a SOC already consumes and it lands on the SAME timeline as everything
else keyed by that indicator - a webhook source logging auth attempts by IP, a Postgres table of
account activity by user, whatever else is already flowing in. An agent reading `read(ip)` then
sees "5 failed logins in the last minute" and "this IP is a known credential-stuffing proxy,
confidence 92" as one correlated read, instead of separately calling an auth-log tool and a
threat-intel lookup tool.

config:
  feed_url: https://example.com/iocs.json   # a JSON array of indicator objects, or
  feed_path: /etc/tares/iocs.json            # a local file (self-hosted feeds, no network dependency)
  token: <bearer token>                      # optional; sent as `Authorization: Bearer <token>`
  field_map:                                 # optional; only if the feed doesn't use the field
    indicator: ioc                            # names below already (indicator/type/threat_type/
    type: ioc_type                            # confidence/source/first_seen)
"""
from __future__ import annotations

import json
from pathlib import Path

import httpx

from ..envelope import Envelope, now_utc
from .base import Connector

DEFAULT_FIELDS = ("indicator", "type", "threat_type", "confidence", "source", "first_seen")


def _mapped(item: dict, field_map: dict) -> dict:
    """Normalize one feed entry to the standard field names, honoring an optional field_map."""
    out = {}
    for field in DEFAULT_FIELDS:
        source_field = field_map.get(field, field)
        out[field] = item.get(source_field)
    return out


class ThreatIntelConnector(Connector):
    CONFIG_SCHEMA = {
        "feed_url": {"type": "string", "discover_input": True,
                     "help": "URL returning a JSON array of indicator objects. Set this or "
                             "feed_path, not both"},
        "feed_path": {"type": "string", "discover_input": True,
                      "help": "local file path to a JSON array of indicator objects; for "
                              "self-hosted feeds with no network round-trip"},
        "token": {"type": "string", "secret": True,
                  "help": "bearer token for feed_url, if the feed requires auth"},
        "field_map": {"type": "json", "advanced": True,
                      "help": "rename source fields to the standard shape, e.g. "
                              '{"indicator": "ioc", "type": "ioc_type"} - only needed when the '
                              "feed doesn't already use indicator/type/threat_type/confidence/"
                              "source/first_seen"},
    }

    PROVIDES = [
        {"name": "indicator", "primary": True, "help": "the IOC value itself - an IP, domain, or hash"},
        {"name": "indicator_type", "help": "ip | domain | hash | url"},
        {"name": "threat_type", "help": "e.g. credential_stuffing_proxy, botnet_c2, known_scanner"},
    ]

    async def _fetch(self) -> list[dict]:
        c = self.cfg.config
        if c.get("feed_path"):
            return json.loads(Path(c["feed_path"]).read_text())
        if not c.get("feed_url"):
            raise ValueError("set feed_url or feed_path")
        headers = {"Authorization": f"Bearer {c['token']}"} if c.get("token") else {}
        async with httpx.AsyncClient(timeout=15) as cx:
            try:
                r = await cx.get(c["feed_url"], headers=headers)
            except Exception as e:
                raise ValueError(f"could not reach feed_url: {e}")
            if r.status_code != 200:
                raise ValueError(f"feed returned {r.status_code}")
            return r.json()

    async def poll(self) -> list[Envelope]:
        c = self.cfg.config
        field_map = c.get("field_map") or {}
        raw = await self._fetch()
        if not isinstance(raw, list):
            raise ValueError("feed must be a JSON array of indicator objects")

        cursor = self.store.get_cursor(self.cfg.name)
        seen = set(cursor.split("\n")) if cursor else set()

        new_items, all_indicators = [], []
        for item in raw:
            if not isinstance(item, dict):
                continue
            norm = _mapped(item, field_map)
            indicator = norm.get("indicator")
            if not indicator:
                continue
            all_indicators.append(str(indicator))
            if str(indicator) not in seen:
                new_items.append((norm, item))

        if all_indicators:
            self.store.set_cursor(self.cfg.name, "\n".join(sorted(set(all_indicators) | seen)))

        return [self._envelope(norm, raw_item) for norm, raw_item in new_items]

    def label_context(self, payload: dict | None) -> dict:
        payload = payload or {}
        return {
            "indicator": payload.get("indicator"),
            "indicator_type": payload.get("type"),
            "threat_type": payload.get("threat_type"),
        }

    def _envelope(self, norm: dict, raw_item: dict) -> Envelope:
        labels, key = self.keyed(norm, fallback=str(norm.get("indicator")))
        confidence = norm.get("confidence")
        threat_type = norm.get("threat_type") or "unknown"
        text = (
            f"{norm.get('indicator')} flagged as {threat_type}"
            + (f" (confidence {confidence})" if confidence is not None else "")
            + f" - source: {norm.get('source') or 'feed'}"
            + (f", first seen {norm['first_seen']}" if norm.get("first_seen") else "")
        )
        return Envelope(
            source=self.cfg.name, source_type=self.cfg.type, key_value=key,
            event_type="ip_reputation", text=text[:300], event_time=now_utc(),
            payload=raw_item, labels=labels,
        )

    @classmethod
    async def discover(cls, config: dict) -> dict | None:
        source = config.get("feed_url") or config.get("feed_path")
        if not source:
            raise ValueError("enter feed_url or feed_path first, then Discover")
        if config.get("feed_path"):
            try:
                raw = json.loads(Path(config["feed_path"]).read_text())
            except Exception as e:
                raise ValueError(f"could not read feed_path: {e}")
        else:
            headers = {"Authorization": f"Bearer {config['token']}"} if config.get("token") else {}
            async with httpx.AsyncClient(timeout=15) as cx:
                try:
                    r = await cx.get(config["feed_url"], headers=headers)
                except Exception as e:
                    raise ValueError(f"could not reach feed_url: {e}")
                if r.status_code != 200:
                    raise ValueError(f"feed returned {r.status_code}")
                raw = r.json()
        if not isinstance(raw, list) or not raw:
            raise ValueError("feed must be a non-empty JSON array of indicator objects")
        sample = raw[0] if isinstance(raw[0], dict) else {}
        threat_types = sorted({str(i.get("threat_type")) for i in raw
                               if isinstance(i, dict) and i.get("threat_type")})
        return {
            "connector": "threat_intel",
            "summary": f"{len(raw)} indicator(s)"
                       + (f" · threat types: {', '.join(threat_types[:6])}" if threat_types else ""),
            "sample_fields": sorted(sample.keys()),
            "proposed_config": {
                **({"feed_url": config["feed_url"]} if config.get("feed_url") else {}),
                **({"feed_path": config["feed_path"]} if config.get("feed_path") else {}),
                "labels": [
                    {"name": "indicator", "field": "indicator", "primary": True},
                    {"name": "indicator_type", "field": "indicator_type"},
                    {"name": "threat_type", "field": "threat_type"},
                ],
            },
        }

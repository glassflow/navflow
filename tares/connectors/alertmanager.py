"""Alertmanager webhook connector — a push receiver for the alerts Alertmanager routes.

Point an Alertmanager `webhook_configs.url` at this source's /ingest/<token> endpoint. Alertmanager
POSTs a batch (`{alerts: [...], ...}`); we fan out the `alerts` array into one event each — no
polling, no PromQL. Alertmanager has already evaluated, grouped, deduped and (with send_resolved)
tracks firing→resolved, so we just record what it pushes.

Complements `prometheus_alerts` (which polls Prometheus's own /api/v1/alerts): use this when you want
Alertmanager's grouping / silencing / resolved semantics and real-time delivery. Needs its own
connector (not the generic webhook) because Alertmanager's payload is a nested object with an
`alerts` array, and each alert's labels are one level down under `labels`.
"""
from __future__ import annotations

from datetime import datetime, timezone

from ..envelope import Envelope, now_utc
from .base import Connector

# labels that make a good entity key, best first — used when no primary label is declared.
_KEY_PRIORITY = ("namespace", "service", "job", "instance", "pod", "app")


def _parse_time(s):
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return now_utc()


class AlertmanagerConnector(Connector):
    CONFIG_SCHEMA = {
        "key_label": {"type": "string", "advanced": True,
                      "help": "alert label to key on (default: namespace/service if present)"},
    }

    async def poll(self):
        return []  # push-only: alerts arrive via map_payload from POST /ingest/{source}

    def map_payload(self, payload) -> list[Envelope]:
        # Alertmanager webhook v4: an object with an `alerts` array. Tolerate a bare alert or a
        # top-level list too, so a hand-crafted test POST still works.
        if isinstance(payload, dict) and isinstance(payload.get("alerts"), list):
            alerts = payload["alerts"]
        elif isinstance(payload, list):
            alerts = payload
        elif isinstance(payload, dict):
            alerts = [payload]
        else:
            alerts = []
        return [self._map_alert(a) for a in alerts if isinstance(a, dict)]

    def _map_alert(self, a: dict) -> Envelope:
        raw = {k: str(v) for k, v in (a.get("labels") or {}).items()}
        anns = a.get("annotations") or {}
        status = str(a.get("status") or "firing")
        alertname = raw.get("alertname", "alert")
        summary = anns.get("summary") or anns.get("description") or alertname
        ts = a.get("endsAt") if status == "resolved" else a.get("startsAt")
        payload = {"labels": raw, "annotations": dict(anns), "status": status,
                   "startsAt": a.get("startsAt"), "endsAt": a.get("endsAt"),
                   "fingerprint": a.get("fingerprint"), "generatorURL": a.get("generatorURL")}
        # every alert label becomes a real Tares label (+ status); alertname is the event_type.
        # Any labels the source declares (const / rename) merge on top; a declared primary wins the key.
        declared, primary_key = self.keyed(self.label_context(payload), fallback="")
        labels = {k: v for k, v in raw.items() if k != "alertname"}
        labels["status"] = status
        labels.update(declared)
        key = primary_key or self._pick_key(labels)
        return Envelope(
            source=self.cfg.name, source_type=self.cfg.type, key_value=key,
            event_type=alertname, text=f"{status.upper()}: {alertname} — {summary}",
            event_time=_parse_time(ts), payload=payload, labels=labels,
        )

    def _pick_key(self, labels: dict) -> str:
        key_label = self.cfg.config.get("key_label")
        if key_label and labels.get(key_label):
            return labels[key_label]
        for l in _KEY_PRIORITY:
            if labels.get(l):
                return labels[l]
        return next((v for k, v in labels.items() if k != "status"), "unknown")

    def label_context(self, payload: dict | None) -> dict:
        """Alert labels are the correlation axes — expose them bare (field: namespace, as the Fields
        view shows them) plus a synthetic `status`. Used at ingest AND on relabel, so both reproduce
        identical labels."""
        p = payload or {}
        labels = p.get("labels") if isinstance(p.get("labels"), dict) else {}
        return {**(labels or {}), "status": p.get("status")}

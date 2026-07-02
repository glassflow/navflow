"""Vercel logs connector — a push receiver for Vercel log drains. Configure a Vercel log drain
(JSON format) to POST to `POST /ingest/<this source>`; each delivery is a batch of log entries.

One source ingests every project the drain carries; entry fields become labels (`project` is the
primary key, with `environment` and `source` as extra axes), so logs auto-shard per project — point
a project's drain here and its logs land in that project/service's timeline.

Vercel entries vary by origin: `source` ∈ lambda | build | edge | static | external. Request logs
carry a `proxy` block (method/path/statusCode) and often no `message`, so the line is synthesized.
(Signature verification of the `x-vercel-signature` header is a production hardening TODO.)
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from ..envelope import Envelope, now_utc
from .base import Connector


class VercelConnector(Connector):
    # push; declare labels (the form pre-fills project/environment/source). No required config.
    CONFIG_SCHEMA: dict = {}

    # The normalized fields this connector synthesizes from the (messy) Vercel payload — these are
    # the fields you can build labels/keys from (NOT raw payload fields). Surfaced to the form so the
    # structure is visible and selectable instead of guessed.
    PROVIDES = [
        {"name": "project", "primary": True, "help": "Vercel project (projectName, else projectId)"},
        {"name": "environment", "help": "production | preview"},
        {"name": "source", "help": "lambda | build | edge | static | external | redirect"},
        {"name": "path", "help": "request path"},
        {"name": "host", "help": "request host"},
        {"name": "deployment", "help": "deployment id"},
        {"name": "branch", "help": "git branch"},
    ]

    async def poll(self) -> list[Envelope]:
        return []  # push-only: entries arrive via map_payload from POST /ingest/{source}

    def map_payload(self, payload) -> list[Envelope]:
        items = payload if isinstance(payload, list) else [payload]
        return [self._map_one(e) for e in items if isinstance(e, dict)]

    def label_context(self, e: dict | None) -> dict:
        # a clean, unified label context (Vercel field names vary; flatten the useful axes). `project`
        # is SYNTHESIZED — the raw logs have no `project` field — so this must be shared by ingest and
        # backfill, else relabeling from the raw payload would drop the project label. Values are left
        # None when genuinely absent (not faked to "unknown"), so field coverage is honest.
        e = e or {}
        proxy = e.get("proxy") or {}
        return {"project": e.get("projectName") or e.get("projectId"),
                "environment": e.get("environment"), "source": e.get("source"),
                "deployment": e.get("deploymentId"), "host": e.get("host"),
                "branch": e.get("branch"), "path": e.get("path") or proxy.get("path")}

    def _map_one(self, e: dict) -> Envelope:
        ctx = self.label_context(e)
        labels, key = self.keyed(ctx, fallback=ctx.get("project") or "unknown")
        proxy = e.get("proxy") or {}

        msg = (e.get("message") or "").strip()
        if not msg and proxy:    # request logs have no message — synthesize from the proxy block
            msg = f"{proxy.get('method', '')} {proxy.get('path', '')} -> {proxy.get('statusCode', '')}".strip()
        if not msg:
            msg = json.dumps(e, default=str)[:300]

        status = e.get("statusCode")
        if status is None:
            status = proxy.get("statusCode")
        fields = {"statusCode": status} if isinstance(status, (int, float)) and not isinstance(status, bool) else {}

        ts = e.get("timestamp")
        try:
            event_time = datetime.fromtimestamp(int(ts) / 1000, tz=timezone.utc)
        except (TypeError, ValueError):
            event_time = now_utc()

        return Envelope(
            source=self.cfg.name, source_type=self.cfg.type, key_value=key,
            event_type=str(e.get("source") or e.get("type") or "log"),
            text=msg[:300], event_time=event_time, fields=fields, payload=e, labels=labels,
        )

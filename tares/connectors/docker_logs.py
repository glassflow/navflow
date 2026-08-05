"""Docker logs connector — tails a container's logs via `docker [compose] logs --since`.

Ingests **all** lines by default (lossless — Tares stores the truth; reads/triggers decide
what's interesting). Optional filters narrow it:
  match: regex — keep only lines matching it (e.g. "ERROR|WARN")
  drop:  regex — skip lines matching it (e.g. 'HTTP/1.1"' to drop access logs)

Cursor is the last RFC3339 timestamp seen. `--since` is inclusive, so we also skip lines at or
before the cursor to avoid re-ingesting the boundary line on every poll.
"""
from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime

from ..envelope import Envelope, now_utc
from .base import Connector

# leading RFC3339 token, after an optional "service  | " compose prefix
_TS = re.compile(r"^(?:\S+\s*\|\s*)?(\d{4}-\d{2}-\d{2}T\S+)\s+(.*)$")

# Best-effort, format-agnostic signals. These are recognize-if-present heuristics, not a parser
# tied to one log format: a level word, and (only when the classic quoted request is there) the
# HTTP method/status. Unknown lines yield {} and just carry their raw text.
_LEVEL = re.compile(r"\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRIT(?:ICAL)?)\b", re.I)
_HTTP = re.compile(r'"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s[^"]*"\s+(\d{3})')
_LEVEL_CANON = {"WARNING": "WARN", "CRITICAL": "CRIT"}


def derive_fields(msg: str) -> dict:
    """Structure a log line without assuming a format. If it's a JSON object, use its scalar fields
    (schema-agnostic structured logs); otherwise pull a couple of near-universal signals. Never
    raises."""
    s = msg.strip()
    if s[:1] == "{":
        try:
            obj = json.loads(s)
        except ValueError:
            obj = None
        if isinstance(obj, dict):
            return {k: v for k, v in obj.items()
                    if isinstance(v, (str, int, float, bool)) and v != ""}
    out: dict = {}
    if (lvl := _LEVEL.search(s)):
        u = lvl.group(1).upper()
        out["level"] = _LEVEL_CANON.get(u, u)
    if (h := _HTTP.search(s)):
        out["http_method"], out["http_status"] = h.group(1), h.group(2)
    return out


class DockerLogsConnector(Connector):
    CONFIG_SCHEMA = {
        "container": {"type": "string", "required": True,
                      "help": "container (or compose service) name"},
        "compose_file": {"type": "string",
                         "help": "path to docker-compose.yml if the container runs under compose"},
        "match": {"type": "string",
                  "help": "keep only lines matching this regex (default: all lines), e.g. ERROR|WARN"},
        "drop": {"type": "string",
                 "help": "skip lines matching this regex, e.g. 'HTTP/1.1\"' to drop access logs"},
        "key": {"type": "string", "advanced": True,
                "help": "legacy fixed key — prefer a primary label"},
        "label_pattern": {"type": "string", "advanced": True,
                          "help": "regex with named groups → per-line label context"},
    }

    def label_context(self, payload: dict | None) -> dict:
        """Reconstruct a line's context from its stored payload — the same derived fields (level,
        http, JSON keys) plus any label_pattern groups. Powers the field profiler and retroactive
        relabel, so both see the same structure the connector derives at ingest."""
        raw = (payload or {}).get("raw", "")
        m = _TS.match(str(raw).strip())
        msg = m.group(2) if m else str(raw)
        ctx = derive_fields(msg)
        lp = self.cfg.config.get("label_pattern")
        if lp and (lm := re.compile(lp).search(msg)):
            ctx = {**ctx, **lm.groupdict()}
        return ctx

    async def poll(self):
        c = self.cfg.config
        container = c["container"]
        compose = c.get("compose_file")
        key_fallback = c.get("key", "api-server")
        since = self.store.get_cursor(self.cfg.name) or "30s"
        cursor_ts = since if since[:4].isdigit() else None   # a real ts vs the initial "30s"
        match_re = re.compile(c["match"], re.I) if c.get("match") else None
        drop_re = re.compile(c["drop"], re.I) if c.get("drop") else None
        label_re = re.compile(c["label_pattern"]) if c.get("label_pattern") else None

        if compose:
            args = ["docker", "compose", "-f", compose, "logs", "--no-color",
                    "--timestamps", "--since", since, container]
        else:
            args = ["docker", "logs", "--timestamps", "--since", since, container]

        try:
            proc = await asyncio.create_subprocess_exec(
                *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
            )
            raw, _ = await asyncio.wait_for(proc.communicate(), timeout=20)
        except Exception:
            return []

        out = []
        # Cap how many lines one poll ingests. After downtime a flooded container can return a huge
        # `--since` backlog; ingesting it in one batch stalls the daemon. Take at most MAX_PER_POLL and
        # advance the cursor to the last line consumed, so a backlog drains over several polls instead
        # of one monster batch.
        MAX_PER_POLL = 5000
        max_ts = None
        for line in raw.decode(errors="replace").splitlines():
            m = _TS.match(line.strip())
            if not m:
                continue
            ts_token, msg = m.group(1), m.group(2)
            if cursor_ts and ts_token <= cursor_ts:
                continue  # already ingested up to the cursor (--since is inclusive)
            max_ts = ts_token  # advance the cursor only over lines we've actually consumed
            if match_re and not match_re.search(msg):
                continue
            if drop_re and drop_re.search(msg):
                continue
            try:
                event_time = datetime.fromisoformat(ts_token.replace("Z", "+00:00"))
            except ValueError:
                event_time = now_utc()
            derived = derive_fields(msg)
            lm = label_re.search(msg) if label_re else None
            ctx = {**derived, **(lm.groupdict() if lm else {})}
            labels, key = self.keyed(ctx, fallback=key_fallback)
            out.append(Envelope(
                source=self.cfg.name, source_type=self.cfg.type, key_value=key,
                event_type="log", text=msg.strip()[:300], event_time=event_time,
                payload={"raw": line}, labels=labels,
            ))
            if len(out) >= MAX_PER_POLL:
                break  # leave the rest for the next poll; cursor is at this line
        if max_ts:
            self.store.set_cursor(self.cfg.name, max_ts)
        return out

"""Claude Code sessions connector — tails local session transcripts into the data plane.

Claude Code writes one JSONL file per session at ~/.claude/projects/<project-slug>/<sessionId>.jsonl,
appending one structured event per line (user / assistant / tool_use / tool_result / summary, each
with a timestamp, sessionId, cwd, gitBranch, and — for assistant turns — model + token usage).

Because navflowd runs on the same machine as ~/.claude (the local scenario), it just reads these
files directly — no hook, no pusher. Each line becomes an Envelope keyed by `session`, with
project/branch/model labels and token-usage as numeric fields. Sub-agent (sidechain) transcripts
are ingested into the SAME source, tagged `sidechain=true`.

Cursor: a JSON map of {filepath: byte_offset}, so growing files resume where we left off and new
session files get picked up on the next poll. Secrets are redacted before storage (thin PII guard).
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

from ..envelope import Envelope, now_utc
from .base import Connector

# Cap how many events one poll ingests, so the first poll over a big ~/.claude history drains over
# several polls instead of one daemon-stalling batch (same idea as the docker_logs backlog cap).
MAX_PER_POLL = 2000

# Thin PII guard: redact obvious secrets/tokens before anything is stored. Not exhaustive — a real
# ship would add a configurable redaction pass — but it covers the common credential shapes that
# show up in agent transcripts (provider keys, GH/Slack/AWS tokens, JWTs, bearer headers, PEM keys).
_SECRET = re.compile(
    r"sk-ant-[A-Za-z0-9_-]{8,}"
    r"|sk-[A-Za-z0-9]{16,}"
    r"|gh[pousr]_[A-Za-z0-9]{20,}"
    r"|xox[baprs]-[A-Za-z0-9-]{10,}"
    r"|AKIA[0-9A-Z]{12,}"
    r"|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}"
    r"|Bearer\s+[A-Za-z0-9._\-]{12,}"
    r"|-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----"
)


def _redact(s: str) -> str:
    return _SECRET.sub("[REDACTED]", s)


def _redact_obj(o):
    if isinstance(o, str):
        return _redact(o)
    if isinstance(o, list):
        return [_redact_obj(x) for x in o]
    if isinstance(o, dict):
        return {k: _redact_obj(v) for k, v in o.items()}
    return o


def _short(v, n: int = 80) -> str:
    s = v if isinstance(v, str) else json.dumps(v, default=str)
    return s if len(s) <= n else s[:n] + "…"


class ClaudeCodeConnector(Connector):
    CONFIG_SCHEMA = {
        "root": {"type": "string", "default": "~/.claude/projects",
                 "help": "directory holding Claude Code session transcripts (one <session>.jsonl per session)"},
        "redact": {"type": "bool", "default": True,
                   "help": "redact obvious secrets/tokens before storing (PII guard)"},
        "include_thinking": {"type": "bool", "default": False,
                             "help": "include assistant <thinking> blocks in the rendered text"},
        "push": {"type": "bool", "default": False, "advanced": True,
                 "help": "fed by the Claude Code plugin via /ingest (don't tail files locally)"},
    }
    # synthesized correlation axes (surfaced in the source form; set on every event)
    PROVIDES = ["session", "project", "branch", "model", "type", "sidechain"]
    # this connector also accepts pushed events (the Claude Code plugin posts transcript lines to
    # /ingest); the same source can tail locally OR be fed by the plugin (set `push` to skip tailing).
    ACCEPTS_PUSH = True

    async def poll(self) -> list[Envelope]:
        c = self.cfg.config
        if c.get("push"):
            return []   # plugin-fed source: events arrive via map_payload(), nothing to tail
        root = Path(str(c.get("root", "~/.claude/projects"))).expanduser()
        redact = c.get("redact", True)
        include_thinking = c.get("include_thinking", False)
        if not root.is_dir():
            return []

        try:
            cursor = json.loads(self.store.get_cursor(self.cfg.name) or "{}")
        except (ValueError, TypeError):
            cursor = {}

        out: list[Envelope] = []
        # one level deep: <project-slug>/<sessionId>.jsonl (and sidechain agent-*.jsonl alongside)
        for f in sorted(root.glob("*/*.jsonl")):
            key = str(f)
            try:
                size = f.stat().st_size
            except OSError:
                continue
            offset = cursor.get(key, 0)
            if offset > size:        # file was truncated/rotated — re-read from the top
                offset = 0
            if offset >= size:
                continue
            with f.open("rb") as fh:
                fh.seek(offset)
                for raw in fh:
                    if not raw.endswith(b"\n"):
                        break        # partial last line still being written; resume next poll
                    offset += len(raw)
                    line = raw.decode("utf-8", "replace").strip()
                    if not line:
                        continue
                    env = self._to_envelope(line, redact, include_thinking)
                    if env is not None:
                        out.append(env)
                    if len(out) >= MAX_PER_POLL:
                        break
            cursor[key] = offset
            if len(out) >= MAX_PER_POLL:
                break

        self.store.set_cursor(self.cfg.name, json.dumps(cursor))
        return out

    # ── push ingestion (the Claude Code plugin posts transcript lines to /ingest) ──
    def map_payload(self, payload) -> list[Envelope]:
        """Map pushed transcript events → Envelopes. `payload` is a single JSONL object or a list of
        them (the daemon parses a posted NDJSON body into a list). Reuses the same mapping as the
        file tail, so plugin-push and local-tail produce identical events."""
        c = self.cfg.config
        redact = c.get("redact", True)
        include_thinking = c.get("include_thinking", False)
        items = payload if isinstance(payload, list) else [payload]
        out = []
        for o in items:
            if isinstance(o, dict):
                env = self._obj_to_envelope(o, redact, include_thinking)
                if env is not None:
                    out.append(env)
        return out

    # ── mapping: one JSONL line / object → one Envelope ───────────────────────
    def _to_envelope(self, line: str, redact: bool, include_thinking: bool):
        try:
            o = json.loads(line)
        except ValueError:
            return None
        if not isinstance(o, dict):
            return None
        return self._obj_to_envelope(o, redact, include_thinking)

    def _obj_to_envelope(self, o: dict, redact: bool, include_thinking: bool):
        sid = o.get("sessionId")
        if not sid:
            return None  # can't key it to a timeline

        msg = o.get("message") if isinstance(o.get("message"), dict) else {}
        cwd = o.get("cwd")
        labels = {"session": str(sid), "type": str(o.get("type") or "event")}
        if cwd:
            labels["project"] = Path(str(cwd)).name
        if o.get("gitBranch"):
            labels["branch"] = str(o["gitBranch"])
        if msg.get("model"):
            labels["model"] = str(msg["model"])
        labels["sidechain"] = "true" if o.get("isSidechain") else "false"

        text = self._render_text(o, msg, include_thinking)[:500]
        if redact:
            text = _redact(text)

        payload = _redact_obj(o) if redact else o

        env = Envelope(
            source=self.cfg.name,
            source_type=self.cfg.type,
            key_value=str(sid),
            event_type=self._event_type(o, msg),
            text=text,
            event_time=self._ts(o),
            fields=self._usage_fields(msg),
            payload=payload,
            labels=labels,
        )
        return env

    @staticmethod
    def _ts(o: dict) -> datetime:
        ts = o.get("timestamp")
        if isinstance(ts, str):
            try:
                return datetime.fromisoformat(ts.replace("Z", "+00:00"))
            except ValueError:
                pass
        return now_utc()

    @staticmethod
    def _event_type(o: dict, msg: dict) -> str:
        typ = o.get("type") or "event"
        content = msg.get("content")
        if isinstance(content, list):
            kinds = {b.get("type") for b in content if isinstance(b, dict)}
            if "tool_use" in kinds:
                return "tool_use"
            if "tool_result" in kinds:
                return "tool_result"
        return str(typ)

    @staticmethod
    def _usage_fields(msg: dict) -> dict:
        usage = msg.get("usage") if isinstance(msg.get("usage"), dict) else {}
        fields = {}
        for k in ("input_tokens", "output_tokens",
                  "cache_read_input_tokens", "cache_creation_input_tokens"):
            v = usage.get(k)
            if isinstance(v, (int, float)):
                fields[k] = v
        if fields:
            fields["total_tokens"] = sum(fields.values())
        return fields

    @staticmethod
    def _render_text(o: dict, msg: dict, include_thinking: bool) -> str:
        if o.get("type") == "summary" and o.get("summary"):
            return str(o["summary"])
        content = msg.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = []
            for b in content:
                if not isinstance(b, dict):
                    continue
                t = b.get("type")
                if t == "text":
                    parts.append(str(b.get("text", "")))
                elif t == "thinking" and include_thinking:
                    parts.append("[thinking] " + str(b.get("thinking", "")))
                elif t == "tool_use":
                    parts.append(f"→ {b.get('name')}({_short(b.get('input'))})")
                elif t == "tool_result":
                    parts.append("[tool_result] " + _short(b.get("content")))
            return " ".join(p for p in parts if p)
        return str(o.get("type") or "")

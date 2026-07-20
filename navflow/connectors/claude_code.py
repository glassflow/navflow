"""Claude Code sessions connector — receives pushed session transcripts from the NavFlow Claude Code
plugin and maps them into the data plane.

Claude Code writes one structured JSONL event per line (user / assistant / tool_use / tool_result /
summary, each with a timestamp, sessionId, cwd, gitBranch, and — for assistant turns — model + token
usage). The plugin's hook POSTs new transcript lines to /ingest/claude_code (local *or* remote); each
line becomes an Envelope keyed by `session`, with project/branch/model labels and token-usage as
numeric fields. Sub-agent (sidechain) transcripts land in the SAME source, tagged `sidechain=true`.
Secrets are redacted before storage (thin PII guard).

Push-only: install the plugin (claude-plugin/) to feed it. Local file tailing was removed in favor of
the plugin, which covers both local and remote NavFlow with one path.
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

from ..envelope import Envelope, now_utc
from .base import Connector

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
        "redact": {"type": "bool", "default": True,
                   "help": "redact obvious secrets/tokens before storing (PII guard)"},
        "include_thinking": {"type": "bool", "default": False,
                             "help": "include assistant <thinking> blocks in the rendered text"},
        # Set by the plugin when it auto-creates the source; kept for compatibility. This connector
        # is push-only, so poll() is a no-op regardless.
        "push": {"type": "bool", "default": True, "advanced": True,
                 "help": "fed by the Claude Code plugin via /ingest (this connector is push-only)"},
    }
    # synthesized correlation axes (surfaced in the source form; set on every event)
    PROVIDES = [
        {"name": "session", "primary": True, "help": "Claude Code session id (the key)"},
        {"name": "project", "help": "working-directory project name"},
        {"name": "branch", "help": "git branch"},
        {"name": "model", "help": "model on assistant turns"},
        {"name": "type", "help": "message type (user / assistant / tool_use / …)"},
        {"name": "sidechain", "help": "sub-agent (sidechain) message"},
    ]
    # Push-only: the Claude Code plugin POSTs transcript lines to /ingest/claude_code; events are
    # mapped by map_payload(). There is no local file tail.
    ACCEPTS_PUSH = True

    async def poll(self) -> list[Envelope]:
        return []   # push-only: events arrive via map_payload() from the plugin

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

    def label_context(self, o: dict | None) -> dict:
        """Synthesized label axes from a raw transcript object — the SAME mapping ingest uses
        (base-class contract: profiling and retroactive relabel must reproduce ingest labels;
        without this override the field profile showed the raw transcript keys and 0-coverage
        phantoms for session/project/…)."""
        o = o or {}
        msg = o.get("message") if isinstance(o.get("message"), dict) else {}
        cwd = o.get("cwd")
        sid = o.get("sessionId")
        return {"session": str(sid) if sid else None,
                "project": Path(str(cwd)).name if cwd else None,
                "branch": str(o["gitBranch"]) if o.get("gitBranch") else None,
                "model": str(msg["model"]) if msg.get("model") else None,
                "type": str(o.get("type")) if o.get("type") else None,
                "sidechain": "true" if o.get("isSidechain") else "false"}

    # ── mapping: one JSONL object → one Envelope ───────────────────────────────
    def _obj_to_envelope(self, o: dict, redact: bool, include_thinking: bool):
        sid = o.get("sessionId")
        if not sid:
            return None  # can't key it to a timeline

        msg = o.get("message") if isinstance(o.get("message"), dict) else {}
        labels = {k: v for k, v in self.label_context(o).items() if v not in (None, "")}
        labels.setdefault("type", "event")

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

"""Slack — the bot token, the outbound message, and the `/tares` slash command's replies.

Outbound (the dispatch sink): resolve the bot token, format a firing as Block Kit, post it.
Inbound (the slash command): parse `/tares ask …`, bound its cost, and format the answer that
goes back to Slack's `response_url`. Signature verification lives next door in `slack_verify.py`
— it is the security boundary and is kept separately reviewable.

This is the *generic* half of Tares's Slack support: a bot token that an operator configures
(env or console) and one `chat.postMessage` call. Nothing here knows about OAuth or hosted
installs; a self-hosted user gets the full feature by pasting a token.

Deliberately plain `httpx`, no `slack_sdk`: this is one HTTP call, and `Dispatcher` already owns
its client, its timeout and its retry policy. Adding an SDK for it would buy a dependency and a
second, divergent retry loop.

The one thing that needs care is Slack's error taxonomy. `chat.postMessage` answers **HTTP 200
with `{"ok": false, "error": "..."}`** for most failures, so the status code alone cannot decide
whether to retry — a revoked token would otherwise burn all five attempts and land in the ledger
as a timeout rather than as "invalid_auth".
"""
from __future__ import annotations

import os
import re
import time
from collections import deque
from datetime import datetime, timezone

import httpx

API_BASE = os.getenv("TARES_SLACK_API_BASE", "https://slack.com/api").rstrip("/")
SETTING_KEY = "slack_bot_token"
ENV_VAR = "TARES_SLACK_BOT_TOKEN"

# Failures that will still be failures on the fifth attempt. Retrying these wastes ~30s of backoff
# and, worse, buries the real reason: the ledger must say "channel_not_found", not "timeout".
DEFINITIVE_ERRORS = {
    "invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired",
    "no_permission", "missing_scope", "ekm_access_denied", "org_login_required",
    "channel_not_found", "not_in_channel", "is_archived", "restricted_action",
    "restricted_action_read_only_channel", "restricted_action_thread_only_channel",
    "msg_too_long", "no_text", "invalid_blocks", "invalid_blocks_format", "invalid_arguments",
    "team_access_not_granted", "as_user_not_supported",
}

# Section text caps at 3000 chars; leave room for the code fence we wrap the timeline in.
_MAX_SECTION = 2800


def resolve_token(store) -> tuple[str, str]:
    """(token, where-it-came-from). Mirrors `resolve_key` for the Anthropic key: the environment
    wins over the console-stored value, so an operator's deployment config is never silently
    overridden by something typed into a UI months earlier."""
    val = os.getenv(ENV_VAR, "").strip()
    if val:
        return val, f"env:{ENV_VAR}"
    stored = ((store.get_setting(SETTING_KEY) or "") if store is not None else "").strip()
    return (stored, "console") if stored else ("", "")


def public_base() -> str:
    """The instance's reachable address, or "". A link to 127.0.0.1 is worse than no link, so
    nothing is linked until the operator says the instance is reachable (TARES_PUBLIC_URL)."""
    return os.getenv("TARES_PUBLIC_URL", "").strip().rstrip("/")


def deep_link(key: str) -> str:
    """The `<url|label>` suffix appended to an agent's FINDING — the entity is what a finding is
    about, so the entity's timeline is where it should land."""
    base = public_base()
    return f"\n\n<{base}/explore?key={key}|Open {key} in Tares>" if base else ""


def dispatch_link(dispatch_id: str | None) -> str:
    """The `<url|label>` for one firing. A trigger alert is about the firing, not the entity: the
    dispatch page is the thing that answers "what actually fired, and what did it carry" — which is
    the question someone reading the alert in Slack has."""
    base = public_base()
    return f"<{base}/dispatches/{dispatch_id}|Open in Tares>" if base and dispatch_id else ""


# `[T-1734s]` on every event line. Correct, and what an agent wants; unreadable at a glance in a
# chat client. Rewritten in the SLACK COPY ONLY — the payload itself is the agent-facing contract
# (it goes out over MCP verbatim), so it keeps its exact seconds.
_AGE = re.compile(r"\[T-(\d+)s\]")


def _humanize_ages(text: str) -> str:
    def one(m: re.Match) -> str:
        s = int(m.group(1))
        if s < 90:
            return f"[{s}s ago]"
        if s < 5400:
            return f"[{round(s / 60)}m ago]"
        if s < 172800:
            return f"[{round(s / 3600)}h ago]"
        return f"[{round(s / 86400)}d ago]"
    return _AGE.sub(one, text)


def _slack_date(iso: str) -> str:
    """Slack's `<!date^…>` token, which renders in each READER's timezone. A raw ISO string with
    microseconds and a UTC offset is not a timestamp anyone reads in a chat client. Falls back to
    the original string if it can't be parsed — a wrong-looking date beats a broken token."""
    try:
        dt = datetime.fromisoformat(iso.strip().replace("Z", "+00:00"))
    except (TypeError, ValueError, AttributeError):
        return iso
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return f"<!date^{int(dt.timestamp())}^{{date_short_pretty}} at {{time}}|{iso}>"


def _truncate(text: str, limit: int = _MAX_SECTION) -> str:
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def build_message(trigger: str, key: str, payload: str, fired_at: str | None = None,
                  dispatch_id: str | None = None) -> dict:
    """Block Kit body for a fired trigger. `text` is always set as well — Slack uses it for the
    notification and for clients that can't render blocks, so a blocks-only message shows up as an
    empty push notification.

    `unfurl_links`/`unfurl_media` are off. The body carries every label on the event, so a source
    with a `host` or `url` label — web traffic, CDN logs, deploys nearly always have one — made
    Slack fetch that site and staple a preview card to the alert. It roughly doubled the height with
    nothing about the incident, read as though Tares were linking somewhere relevant, and meant
    alerting had the side effect of Slack fetching a customer's URLs.
    """
    headline = f"*{trigger}* fired for *{key}*"
    link = dispatch_link(dispatch_id)
    blocks: list[dict] = [{"type": "section", "text": {"type": "mrkdwn", "text": headline}}]
    body = _humanize_ages((payload or "").strip())
    if body:
        blocks.append({"type": "section", "text": {
            "type": "mrkdwn", "text": "```" + _truncate(body) + "```"}})
    context = f"Tares · {_slack_date(fired_at)}" if fired_at else "Tares"
    if link:
        context += " · " + link
    blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": context}]})
    return {"text": f"{trigger} fired for {key}", "blocks": blocks,
            "unfurl_links": False, "unfurl_media": False}


def classify(status: int, data: dict | None) -> tuple[bool, str | None, bool]:
    """(ok, error, retry) for one `chat.postMessage` response.

    Slack's answers come in three shapes and all three have to be told apart:
      · HTTP 200 + `{"ok": true}`                → delivered
      · HTTP 200 + `{"ok": false, "error": ...}` → the real failure mode. Definitive per
        DEFINITIVE_ERRORS; anything else there (internal_error, service_unavailable) is a
        transient Slack fault and retries, as does `ratelimited`.
      · HTTP 429 / 5xx                           → rate limit or outage, retry. Other 4xx are
        definitive, the same rule `Dispatcher._post` applies to a webhook.
    """
    if status == 429:
        return False, "slack: ratelimited", True
    if status >= 500:
        return False, f"slack: HTTP {status}", True
    if not isinstance(data, dict):
        # A 2xx that isn't JSON means we are not talking to Slack (a proxy, a captive portal).
        return False, f"slack: HTTP {status} (non-JSON response)", False
    if data.get("ok"):
        return True, None, False
    err = str(data.get("error") or "unknown_error")
    if err == "ratelimited":
        return False, "slack: ratelimited", True
    if err in DEFINITIVE_ERRORS or 400 <= status < 500:
        return False, f"slack: {err}{_error_detail(err, data)}", False
    return False, f"slack: {err}", True    # transient Slack-side fault — worth another attempt


_HINTS = {
    "invalid_auth": "the bot token is invalid or revoked",
    "token_revoked": "the bot token has been revoked",
    "account_inactive": "the bot token belongs to a deactivated workspace or app",
    "channel_not_found": "no such channel, or the bot cannot see it",
    "not_in_channel": "invite the bot to the channel first (/invite @Tares)",
    "is_archived": "the channel is archived",
    "missing_scope": "the bot token is missing the chat:write scope",
    "msg_too_long": "the message exceeded Slack's size limit",
}


def _error_detail(err: str, data: dict) -> str:
    hint = _HINTS.get(err)
    if not hint and err == "missing_scope" and data.get("needed"):
        hint = f"needs scope {data['needed']}"
    return f" ({hint})" if hint else ""


# ── the channel picker ────────────────────────────────────────────────────
# The console offers a list instead of a free-text box for the channel ID, which nobody can find
# without leaving the app. One page is 200 channels and a real workspace has more, so this
# paginates — but bounded, because a cursor that never terminates would spin here forever.

_CHANNEL_PAGE = 200
_CHANNEL_MAX_PAGES = 10          # 2000 channels; past that the picker is the wrong UI anyway


async def list_channels(token: str, timeout: float = 10.0
                        ) -> tuple[list[dict], str | None, str | None]:
    """`(channels, reason, detail)` — the channels this bot is a **member of**.

    `users.conversations`, not `conversations.list`. The latter lists every public channel in the
    workspace, including the ones the bot was never invited to: picking one of those produces a
    subscription that fails at its first firing with `not_in_channel`, which is exactly the failure
    the picker exists to prevent. `users.conversations` returns only conversations reachable "via
    membership of the channel" for the presented token, so everything it offers can actually be
    posted to. It also covers private channels, which `conversations.list` cannot return at all.

    Both `public_channel` and `private_channel` are asked for; the app holds `channels:read` and
    `groups:read`. Each channel carries `is_private` so the console can render a lock rather than
    a `#`.

    `reason` is None when the list is trustworthy (an empty list then means the bot has not been
    invited anywhere), otherwise it names why the caller should not believe it: "no_token",
    "missing_scope", "error". Nothing raises: the console renders whatever this returns, and a
    Slack outage must degrade to the free-text box rather than to a stack trace.

    `missing_scope` is called out separately because it is the *expected* failure — a token issued
    before these scopes were requested has it, and the only fix is reconnecting Slack.
    """
    if not (token or "").strip():
        return [], "no_token", None
    headers = {"authorization": f"Bearer {token.strip()}"}
    params = {"types": "public_channel,private_channel", "exclude_archived": "true",
              "limit": str(_CHANNEL_PAGE)}
    out: list[dict] = []
    cursor = ""
    try:
        async with httpx.AsyncClient(timeout=timeout) as cx:
            for _ in range(_CHANNEL_MAX_PAGES):
                q = {**params, **({"cursor": cursor} if cursor else {})}
                r = await cx.get(f"{API_BASE}/users.conversations", params=q, headers=headers)
                try:
                    data = r.json()
                except Exception:
                    data = None
                if r.status_code == 429 or r.status_code >= 500:
                    return [], "error", f"slack: HTTP {r.status_code}"
                if not isinstance(data, dict):
                    return [], "error", f"slack: HTTP {r.status_code} (non-JSON response)"
                if not data.get("ok"):
                    err = str(data.get("error") or "unknown_error")
                    if err == "missing_scope":
                        # Not _error_detail's hint: that one names chat:write, which is the scope
                        # this token almost certainly *does* have. Two scopes are in play here, so
                        # the missing one can be either — take Slack's `needed` when it says, and
                        # only name both when it doesn't.
                        needed = str(data.get("needed") or "").strip() or "channels:read and groups:read"
                        return [], "missing_scope", (
                            f"slack: missing_scope (the bot token is missing {needed}; "
                            "reconnect Slack to grant it)")
                    return [], "error", f"slack: {err}{_error_detail(err, data)}"
                for c in data.get("channels") or []:
                    if isinstance(c, dict) and c.get("id") and c.get("name"):
                        # id, name and is_private only: the console needs nothing else and a
                        # conversation object carries a few hundred bytes of purpose, topic and
                        # membership. `is_private` is absent on some payloads — a channel that
                        # doesn't say it is private isn't.
                        out.append({"id": str(c["id"]), "name": str(c["name"]),
                                    "is_private": bool(c.get("is_private"))})
                cursor = str(((data.get("response_metadata") or {}).get("next_cursor") or "")).strip()
                if not cursor:
                    break
            # Falling out of the loop with a cursor still set means the bound was hit. A partial
            # list is a usable picker; an error here would take the whole feature away.
    except Exception as e:
        return [], "error", ("slack: " + type(e).__name__
                             + (f": {e}" if str(e).strip() else ""))[:200]
    out.sort(key=lambda c: c["name"])
    return out, None, None


# ── inbound: the /tares slash command ─────────────────────────────────────
# Everything below serves `POST /api/slack/events`. It is deliberately pure — parsing, cost
# bounding and message shaping — so the endpoint itself is only plumbing: verify, ACK, answer.

USAGE = ("usage: `/tares ask <question>`; e.g. "
         "`/tares ask what happened to checkout-svc in the last hour?`")

# Cost ceiling, the same shape as `builtin_agents.DAILY_RUN_CAP`: a per-day count with an env
# override, so one enthusiastic channel cannot run up an unbounded model bill. Counted per
# (team, user) rather than per workspace — one person's loop must not lock out their colleagues.
DAILY_ASK_CAP = int(os.getenv("TARES_SLACK_DAILY_CAP", "50"))


class AskCap:
    """A rolling 24h cap per (team, user).

    Held in memory rather than in a table: unlike an agent run there is nothing to show in the
    console for an ask, and a restart resetting the counter is an acceptable cost bound — the
    ceiling exists to stop a runaway loop, not to bill anyone. Same knob shape as DAILY_RUN_CAP.
    """

    def __init__(self, cap: int = DAILY_ASK_CAP, window: float = 86400.0):
        self.cap, self.window, self._seen = cap, window, {}

    def take(self, team: str, user: str, now: float | None = None) -> bool:
        """Record one ask; False when this user is already at the cap (nothing is recorded then)."""
        now = time.time() if now is None else now
        q = self._seen.setdefault((team or "-", user or "-"), deque())
        while q and now - q[0] > self.window:
            q.popleft()
        if len(q) >= self.cap:
            return False
        q.append(now)
        return True


def parse_command(text: str) -> tuple[str, str | None]:
    """`(question, error)` for the `text` of a `/tares` slash command.

    `/tares ask <question>` is the documented form. A bare `/tares <question>` is accepted as
    the same thing — forgetting the subcommand is the overwhelmingly likely mistake, and answering
    it beats a lecture. Empty, or `help`, gets the usage line; nothing gets a stack trace.
    """
    text = (text or "").strip()
    if not text or text.lower() in ("help", "-h", "--help", "?"):
        return "", USAGE
    head, _, rest = text.partition(" ")
    if head.lower() == "ask":
        rest = rest.strip()
        return (rest, None) if rest else ("", f"ask what? {USAGE}")
    return text, None


_MD_LINK = re.compile(r"\[([^\]]+)\]\((https?://[^)\s]+)\)")
_MD_BOLD = re.compile(r"\*\*(.+?)\*\*", re.S)
_MD_HEAD = re.compile(r"^#{1,6}\s*(.+)$", re.M)
# A horizontal rule. Slack has no such thing, so `---` arrives as three literal dashes on a line of
# their own. Excludes anything containing a pipe, which is a table's separator row, not a rule.
_MD_RULE = re.compile(r"^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$", re.M)
_MD_BULLET = re.compile(r"^([ \t]*)[-*][ \t]+(?=\S)", re.M)
# A table row: starts and ends with a pipe. The separator row is the one that is only dashes,
# colons, pipes and spaces — it carries alignment, which monospace output cannot express anyway.
_TBL_ROW = re.compile(r"^[ \t]*\|.*\|[ \t]*$")
_TBL_SEP = re.compile(r"^[ \t]*\|[\s\-:|]+\|[ \t]*$")
# Emphasis and code ticks inside a table cell: a code block renders them literally, so `**ok**`
# would read as asterisks. Stripped rather than converted — inside ``` there is nothing to convert to.
_CELL_NOISE = re.compile(r"(\*\*|__|`)")
_BLANKS = re.compile(r"\n{3,}")


def _cells(row: str) -> list[str]:
    return [_CELL_NOISE.sub("", c).strip() for c in row.strip().strip("|").split("|")]


def _table_to_code(rows: list[str]) -> str:
    """A markdown table as an aligned monospace block.

    Slack renders no tables at all — a pipe table arrives as raw pipes plus a `|---|---|` row, which
    on a three-column answer is most of the message. A code block is the only place Slack keeps
    columns lined up, so the table becomes text that is at least readable as a table.
    """
    grid = [_cells(r) for r in rows if not _TBL_SEP.match(r)]
    if not grid:
        return ""
    width = max(len(r) for r in grid)
    grid = [r + [""] * (width - len(r)) for r in grid]
    cols = [max(len(r[i]) for r in grid) for i in range(width)]
    lines = ["  ".join(c.ljust(cols[i]) for i, c in enumerate(r)).rstrip() for r in grid]
    if len(grid) > 1:                 # keep the header visually separate, without markdown's pipes
        lines.insert(1, "  ".join("-" * cols[i] for i in range(width)).rstrip())
    return "```\n" + "\n".join(lines) + "\n```"


def _extract_tables(text: str) -> tuple[str, list[str]]:
    """Replace each markdown table with a placeholder, returning the rendered blocks separately.

    Done before the emphasis and link substitutions so those never rewrite a table's contents —
    inside a code block their output would be literal asterisks and angle brackets.
    """
    out, tables, run = [], [], []

    def flush():
        # One row and a separator is a table; a single pipe-ish line is prose and stays prose.
        if len(run) >= 2 and any(_TBL_SEP.match(r) for r in run):
            out.append(f"\x00TBL{len(tables)}\x00")
            tables.append(_table_to_code(run))
        else:
            out.extend(run)
        run.clear()

    for line in (text or "").splitlines():
        if _TBL_ROW.match(line):
            run.append(line)
            continue
        flush()
        out.append(line)
    flush()
    return "\n".join(out), tables


def to_mrkdwn(text: str) -> str:
    """Markdown (what the model writes) → Slack mrkdwn (what Slack renders).

    Slack's dialect is close enough to markdown to be misleading: `**bold**` is literal asterisks,
    `[a](b)` is literal brackets, `## heading` is a literal hash, `---` is three dashes, and a pipe
    table is the raw pipes. All of those were showing up verbatim in `/tares ask` answers — the
    assistant is told to use small tables where they help, so the table case is not an edge case.
    """
    text, tables = _extract_tables(text)
    text = _MD_LINK.sub(r"<\2|\1>", text)
    text = _MD_BOLD.sub(r"*\1*", text)
    text = _MD_HEAD.sub(r"*\1*", text)
    text = _MD_RULE.sub("", text)
    text = _MD_BULLET.sub(r"\1•  ", text)
    # A dropped rule leaves the blank line either side of it, so the gap doubles. Collapse any run
    # of blank lines back to one — nothing in Slack needs more than a paragraph break.
    text = _BLANKS.sub("\n\n", text)
    for i, block in enumerate(tables):
        text = text.replace(f"\x00TBL{i}\x00", block)
    return text


def _sections(text: str) -> list[dict]:
    """Split a long answer across section blocks — one section caps at 3000 characters, and an
    over-long block makes Slack reject the whole message (`invalid_blocks`) rather than truncate."""
    out, buf = [], to_mrkdwn(text).strip()
    while buf:
        chunk, buf = buf[:_MAX_SECTION], buf[_MAX_SECTION:]
        if buf:                       # prefer a line boundary so we don't cut mid-sentence
            cut = chunk.rfind("\n")
            if cut > _MAX_SECTION // 2:
                chunk, buf = chunk[:cut], chunk[cut + 1:] + buf
        out.append({"type": "section", "text": {"type": "mrkdwn", "text": chunk}})
    return out or [{"type": "section", "text": {"type": "mrkdwn", "text": "_(no answer)_"}}]


def build_answer(question: str, answer: str, thread_ts: str | None = None,
                 in_channel: bool = True) -> dict:
    """The `response_url` body carrying an answer back to Slack.

    `replace_original` clears the "thinking…" ACK so a channel is left with the answer alone, and
    `text` is always set for the notification and for clients that can't render blocks.
    """
    blocks = [{"type": "context", "elements": [
        {"type": "mrkdwn", "text": f":mag: *{to_mrkdwn(question)[:180]}*"}]}]
    blocks += _sections(answer)
    body = {"response_type": "in_channel" if in_channel else "ephemeral",
            "replace_original": True,
            "text": _truncate(answer.strip() or "(no answer)", 500),
            "blocks": blocks,
            # Same reason as build_message: an answer that mentions one of the user's hostnames
            # should not make Slack go and fetch it.
            "unfurl_links": False, "unfurl_media": False}
    if thread_ts:
        # Invoked inside a thread: the answer belongs in that thread, not adrift in the channel.
        body["thread_ts"] = thread_ts
    return body


def build_error(message: str, thread_ts: str | None = None) -> dict:
    """A failure the user can act on, ephemeral so a broken setup isn't broadcast to the channel.

    Every failure mode goes through here. A slash command that answers with silence is
    indistinguishable from an app that is down, which is the worst outcome of all.
    """
    body = {"response_type": "ephemeral", "replace_original": True,
            "text": message,
            "blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": message}}]}
    if thread_ts:
        body["thread_ts"] = thread_ts
    return body

"""Slack as a dispatch sink — resolve the bot token, format the message, post it.

This is the *generic* half of NavFlow's Slack support: a bot token that an operator configures
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

API_BASE = os.getenv("NAVFLOW_SLACK_API_BASE", "https://slack.com/api").rstrip("/")
SETTING_KEY = "slack_bot_token"
ENV_VAR = "NAVFLOW_SLACK_BOT_TOKEN"

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


def deep_link(key: str) -> str:
    """The `<url|label>` suffix appended to a Slack message, or "" when this instance has no
    reachable address. A link to 127.0.0.1 is worse than no link, so it is only emitted when the
    operator has told us the instance is reachable (NAVFLOW_PUBLIC_URL)."""
    base = os.getenv("NAVFLOW_PUBLIC_URL", "").strip().rstrip("/")
    return f"\n\n<{base}/explore?key={key}|Open {key} in NavFlow>" if base else ""


def _truncate(text: str, limit: int = _MAX_SECTION) -> str:
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def build_message(trigger: str, key: str, payload: str, fired_at: str | None = None) -> dict:
    """Block Kit body for a fired trigger. `text` is always set as well — Slack uses it for the
    notification and for clients that can't render blocks, so a blocks-only message shows up as an
    empty push notification."""
    headline = f"*{trigger}* fired for *{key}*"
    link = deep_link(key)
    blocks: list[dict] = [{"type": "section", "text": {"type": "mrkdwn", "text": headline}}]
    body = (payload or "").strip()
    if body:
        blocks.append({"type": "section", "text": {
            "type": "mrkdwn", "text": "```" + _truncate(body) + "```"}})
    context = f"NavFlow · {fired_at}" if fired_at else "NavFlow"
    if link:
        context += " ·" + link.strip()
    blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": context}]})
    return {"text": f"{trigger} fired for {key}", "blocks": blocks}


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
    "not_in_channel": "invite the bot to the channel first (/invite @NavFlow)",
    "is_archived": "the channel is archived",
    "missing_scope": "the bot token is missing the chat:write scope",
    "msg_too_long": "the message exceeded Slack's size limit",
}


def _error_detail(err: str, data: dict) -> str:
    hint = _HINTS.get(err)
    if not hint and err == "missing_scope" and data.get("needed"):
        hint = f"needs scope {data['needed']}"
    return f" ({hint})" if hint else ""

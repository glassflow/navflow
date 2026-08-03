"""Slack request signing — the *only* thing standing between the public internet and this daemon's
inbound Slack endpoint.

Kept in its own module on purpose: it is the one piece of NavFlow that is pure, security-critical
and directly unit-testable, and it should be readable end to end without the daemon around it
(tests/test_slack_verify.py drives it with known-good, tampered and replayed vectors).

The scheme, per Slack:

    basestring = "v0:" + X-Slack-Request-Timestamp + ":" + <raw request body>
    X-Slack-Signature = "v0=" + hex(HMAC_SHA256(signing_secret, basestring))

Three details decide whether this is real protection or theatre:

1. **Raw bytes.** The HMAC covers the body exactly as sent. Parsing a form or JSON and
   re-serialising it changes bytes (ordering, escaping, `+` vs `%20`) and every signature fails —
   or worse, someone "fixes" that by loosening the check. Callers MUST hand us
   `await request.body()` and parse afterwards.
2. **`hmac.compare_digest`.** A `==` on the hex digest leaks the position of the first wrong byte
   through timing; the digest is attacker-influenced, so that is a real oracle.
3. **The timestamp window.** A signature stays valid forever, so without a freshness bound a
   captured request can be replayed indefinitely. Slack's own guidance is five minutes; a request
   from the future is rejected on the same rule (a clock far enough ahead would otherwise widen the
   window arbitrarily).

There is deliberately no "skip verification" switch. The endpoint's answer when no secret is
configured is 503 — refusing to serve is a safe failure, accepting unverified requests is not.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import time

ENV_VAR = "NAVFLOW_SLACK_SIGNING_SECRET"
SETTING_KEY = "slack_signing_secret"

VERSION = "v0"
MAX_AGE_SECONDS = 300          # Slack's recommended replay window: 5 minutes

TS_HEADER = "x-slack-request-timestamp"
SIG_HEADER = "x-slack-signature"


def resolve_secret(store) -> tuple[str, str]:
    """(secret, where-it-came-from). Same env-wins rule as the bot token and the Anthropic key: an
    operator's deployment config is never silently overridden by something typed into the console
    months earlier."""
    val = os.getenv(ENV_VAR, "").strip()
    if val:
        return val, f"env:{ENV_VAR}"
    stored = ((store.get_setting(SETTING_KEY) or "") if store is not None else "").strip()
    return (stored, "console") if stored else ("", "")


def sign(timestamp: str, raw_body: bytes, signing_secret: str) -> str:
    """The `v0=…` signature Slack would send for this exact body. Used by the verifier and by the
    tests to build known-good vectors — one implementation, so a test can never pass against a
    formula the server doesn't actually use."""
    base = f"{VERSION}:{timestamp}:".encode() + (raw_body or b"")
    digest = hmac.new(signing_secret.encode(), base, hashlib.sha256).hexdigest()
    return f"{VERSION}={digest}"


def check(headers, raw_body: bytes, signing_secret: str, now: float | None = None) -> str | None:
    """None when the request is authentic, otherwise a short reason.

    The reason is for the daemon's log, never for the response body: telling a caller *why* their
    forgery failed helps only the forger. `headers` is any case-insensitive mapping (Starlette's
    `request.headers`) or a plain dict with lowercase keys.
    """
    if not signing_secret:
        # Caller error, not attacker error: the endpoint must 503 before it ever gets here.
        return "no signing secret configured"
    get = headers.get
    ts = (get(TS_HEADER) or get(TS_HEADER.title()) or "").strip()
    sig = (get(SIG_HEADER) or get(SIG_HEADER.title()) or "").strip()
    if not ts or not sig:
        return "missing signature headers"
    try:
        ts_val = float(ts)
    except ValueError:
        return "malformed timestamp"
    age = (time.time() if now is None else now) - ts_val
    if abs(age) > MAX_AGE_SECONDS:
        # Both directions: stale (a replay) and far-future (a skewed or lying clock).
        return f"timestamp outside the {MAX_AGE_SECONDS}s window ({int(age)}s)"
    if not hmac.compare_digest(sign(ts, raw_body, signing_secret), sig):
        return "signature mismatch"
    return None


def verify(headers, raw_body: bytes, signing_secret: str, now: float | None = None) -> bool:
    """True iff this request was signed by the holder of `signing_secret` within the replay
    window. Thin boolean over `check`, which carries the reason for logging."""
    return check(headers, raw_body, signing_secret, now) is None

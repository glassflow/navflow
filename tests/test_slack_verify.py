"""Slack request signing, in isolation.

`slack_verify` is the security boundary for the only route in this daemon that is public to the
auth middleware and accepts a body from the internet, so it is tested directly rather than only
through the endpoint: known-good, tampered, replayed, forged, and every malformed shape an
attacker controls. Nothing here starts a daemon — that is the point, these are vectors.

The signature is computed against the RAW bytes, so the tests keep bytes throughout: a body that
survives a JSON round-trip proves nothing about the case that actually breaks (re-serialisation).
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tares import slack_verify as sv

P = F = 0
def ck(l, c, d=""):
    global P, F; P += 1 if c else 0; F += 0 if c else 1
    print(("  ok   " if c else "  FAIL ") + l + ("" if c else f"  {d}"))


# Slack's own published example signing secret (api.slack.com "Verifying requests from Slack").
# Not a credential — it is the fixture that lets us check our HMAC against the spec rather than
# against itself, so it has to stay verbatim.
SECRET = "8f742231b10e8888abcd99yyyzzz85a5"   # gitleaks:allow
OTHER = "8f742231b10e8888abcd99yyyzzz85a6"   # gitleaks:allow
BODY = (b"token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&user_id=U2147483697"
        b"&command=%2Ftares&text=ask+what+happened+to+checkout-svc"
        b"&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2F1234%2F5678")


def hdrs(ts, sig):
    return {"x-slack-request-timestamp": str(ts), "x-slack-signature": sig}


now = time.time()
ts = str(int(now))
good = sv.sign(ts, BODY, SECRET)

# ── the known-good vector ───────────────────────────────────────────────────
ck("a correctly signed request verifies", sv.verify(hdrs(ts, good), BODY, SECRET, now))
ck("...and reports no reason", sv.check(hdrs(ts, good), BODY, SECRET, now) is None)
ck("the signature is the v0= hex HMAC-SHA256 over v0:{ts}:{body}",
   good.startswith("v0=") and len(good) == 67, good)

# Slack's own published example, so this is checked against the spec and not just against itself.
# (api.slack.com/authentication/verifying-requests-from-slack)
SLACK_TS = "1531420618"
SLACK_BODY = (b"token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow"
              b"&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner"
              b"&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2F"
              b"commands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id="
              b"398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c")
SLACK_SECRET = "8f742231b10e8888abcd99yyyzzz85a5"   # gitleaks:allow — see note above
SLACK_SIG = "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503"
ck("matches Slack's published example vector",
   sv.verify(hdrs(SLACK_TS, SLACK_SIG), SLACK_BODY, SLACK_SECRET, float(SLACK_TS) + 1),
   sv.sign(SLACK_TS, SLACK_BODY, SLACK_SECRET))

# ── tampering: the body is what the signature is FOR ────────────────────────
tampered = BODY.replace(b"checkout-svc", b"payments-svc")
ck("a tampered body is rejected", not sv.verify(hdrs(ts, good), tampered, SECRET, now))
ck("...for the right reason", sv.check(hdrs(ts, good), tampered, SECRET, now) == "signature mismatch")
ck("one flipped byte anywhere in the body is rejected",
   not sv.verify(hdrs(ts, good), BODY + b" ", SECRET, now))
ck("an empty body against a real signature is rejected",
   not sv.verify(hdrs(ts, good), b"", SECRET, now))
ck("re-serialising the body breaks it (why the endpoint must use raw bytes)",
   not sv.verify(hdrs(ts, good), BODY.replace(b"+", b"%20"), SECRET, now))

# ── forgery: a signature made with the wrong secret ─────────────────────────
ck("a signature from another secret is rejected",
   not sv.verify(hdrs(ts, sv.sign(ts, BODY, OTHER)), BODY, SECRET, now))
ck("signing with the wrong secret produces a different signature",
   sv.sign(ts, BODY, OTHER) != good)

# ── replay: a valid signature stays valid forever without the time bound ────
old = str(int(now - sv.MAX_AGE_SECONDS - 1))
ck("a replayed request older than the window is rejected",
   not sv.verify(hdrs(old, sv.sign(old, BODY, SECRET)), BODY, SECRET, now))
ck("...and says the window is why",
   "window" in (sv.check(hdrs(old, sv.sign(old, BODY, SECRET)), BODY, SECRET, now) or ""))
edge = str(int(now - sv.MAX_AGE_SECONDS + 5))
ck("a request just inside the window still verifies",
   sv.verify(hdrs(edge, sv.sign(edge, BODY, SECRET)), BODY, SECRET, now))
future = str(int(now + sv.MAX_AGE_SECONDS + 60))
ck("a far-future timestamp is rejected too (a skewed clock can't widen the window)",
   not sv.verify(hdrs(future, sv.sign(future, BODY, SECRET)), BODY, SECRET, now))
ck("the replay window is Slack's recommended 5 minutes", sv.MAX_AGE_SECONDS == 300)

# ── the timestamp is signed, so it cannot be moved forward ──────────────────
ck("refreshing the timestamp of a captured request invalidates it",
   not sv.verify(hdrs(ts, sv.sign(old, BODY, SECRET)), BODY, SECRET, now))

# ── malformed input is a rejection, never an exception ──────────────────────
for label, h in (("no headers at all", {}),
                 ("no signature", {"x-slack-request-timestamp": ts}),
                 ("no timestamp", {"x-slack-signature": good}),
                 ("a non-numeric timestamp", hdrs("not-a-time", good)),
                 ("an empty signature", hdrs(ts, "")),
                 ("a signature with no v0= prefix", hdrs(ts, good[3:])),
                 ("a truncated signature", hdrs(ts, good[:20])),
                 ("a non-hex signature", hdrs(ts, "v0=" + "z" * 64))):
    try:
        ok = sv.verify(h, BODY, SECRET, now)
    except Exception as e:
        ok, label = True, f"{label} (raised {type(e).__name__})"
    ck(f"rejected: {label}", not ok)

# ── no secret is never a pass ───────────────────────────────────────────────
ck("an empty signing secret rejects even a well-formed request",
   not sv.verify(hdrs(ts, good), BODY, "", now))
ck("...and says the secret is missing",
   sv.check(hdrs(ts, good), BODY, "", now) == "no signing secret configured")

# ── header lookup survives Slack's actual casing ────────────────────────────
ck("headers are matched case-insensitively as sent (X-Slack-Signature)",
   sv.verify({"X-Slack-Request-Timestamp": ts, "X-Slack-Signature": good}, BODY, SECRET, now))

# ── secret resolution: env wins over the stored value ───────────────────────
class FakeStore:
    def __init__(self, v): self.v = v
    def get_setting(self, k): return self.v if k == sv.SETTING_KEY else None


os.environ.pop(sv.ENV_VAR, None)
ck("with nothing configured, no secret resolves", sv.resolve_secret(FakeStore(None)) == ("", ""))
ck("a stored secret resolves as console", sv.resolve_secret(FakeStore("stored")) == ("stored", "console"))
os.environ[sv.ENV_VAR] = "from-env"
ck("the environment beats the stored secret",
   sv.resolve_secret(FakeStore("stored")) == ("from-env", f"env:{sv.ENV_VAR}"))
os.environ[sv.ENV_VAR] = "   "
ck("a blank env var does not shadow the stored secret",
   sv.resolve_secret(FakeStore("stored")) == ("stored", "console"))
os.environ.pop(sv.ENV_VAR, None)

print(f"\n{P} passed, {F} failed")
raise SystemExit(1 if F else 0)

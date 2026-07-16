#!/usr/bin/env python3
"""NavFlow plugin shipper — runs as a Claude Code hook and streams this session into NavFlow.

Every hook receives the session's `transcript_path` (the JSONL Claude Code writes) on stdin. We read
the *new* lines since the last run (tracked by a byte offset in the plugin's persistent data dir) and
POST them as NDJSON to NavFlow's claude_code source at {navflow_url}/ingest/claude_code. The daemon
maps each line into the data plane (same mapping as the local file tail).

The source is created automatically on NavFlow the first time the plugin runs (and re-created if it's
missing), so installing the plugin is the only setup step — no need to provision a source by hand.

Idempotent: the offset only advances after a successful POST. Best-effort: never raises into the
session. Configured entirely via plugin userConfig env vars.
"""
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request


def _truthy(v: str) -> bool:
    return str(v).strip().lower() not in ("0", "false", "off", "no", "")


def _opt(name: str, default: str = "") -> str:
    """userConfig option from the hook env. Claude Code injects CLAUDE_PLUGIN_OPTION_<KEY> with
    the key UPPERCASED (user_config.ingest_token -> CLAUDE_PLUGIN_OPTION_INGEST_TOKEN); check the
    verbatim casing too for robustness across versions."""
    return (os.environ.get(f"CLAUDE_PLUGIN_OPTION_{name.upper()}")
            or os.environ.get(f"CLAUDE_PLUGIN_OPTION_{name}")
            or default)


def _post(url: str, data: bytes, headers: dict):
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    return urllib.request.urlopen(req, timeout=5)


def _auth_only(headers: dict) -> dict:
    h = {"Content-Type": "application/json"}
    if "Authorization" in headers:
        h["Authorization"] = headers["Authorization"]
    return h


def ensure_source(base: str, headers: dict) -> bool:
    """Create the push-mode claude_code source if it doesn't exist. 409 = already there = fine."""
    body = json.dumps({"name": "claude_code", "connector": "claude_code",
                       "poll": "10s", "config": {"push": True}}).encode()
    try:
        _post(base + "/api/sources", body, _auth_only(headers))
        return True
    except urllib.error.HTTPError as e:
        return e.code == 409          # already exists
    except Exception:
        return False


def main() -> None:
    try:
        hook = json.load(sys.stdin)
    except Exception:
        return

    if not _truthy(_opt("stream_sessions", "true")):
        return

    base = (_opt("navflow_url") or "http://127.0.0.1:8787").rstrip("/")
    token = (_opt("ingest_token") or "").strip()
    headers = {"Content-Type": "application/x-ndjson"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    data_dir = os.environ.get("CLAUDE_PLUGIN_DATA") or os.path.expanduser("~/.navflow-plugin")
    os.makedirs(data_dir, exist_ok=True)
    marker = os.path.join(data_dir, "ensured-" + hashlib.sha1(base.encode()).hexdigest()[:12])

    # ensure the source exists (once per NavFlow URL; cheap fast-path via a marker file)
    if not os.path.exists(marker):
        if ensure_source(base, headers):
            open(marker, "w").write("1")

    # SessionStart just provisions the source; there's nothing to ship yet
    if hook.get("hook_event_name") == "SessionStart":
        return

    transcript = hook.get("transcript_path")
    if not transcript or not os.path.isfile(transcript):
        return

    off_dir = os.path.join(data_dir, "offsets")
    os.makedirs(off_dir, exist_ok=True)
    off_file = os.path.join(off_dir, hashlib.sha1(transcript.encode()).hexdigest()[:16] + ".off")
    try:
        offset = int(open(off_file).read().strip())
    except Exception:
        offset = 0

    size = os.path.getsize(transcript)
    if offset > size:      # transcript rotated/truncated — start over
        offset = 0
    if offset >= size:
        return

    with open(transcript, "rb") as f:
        f.seek(offset)
        chunk = f.read()
    last_nl = chunk.rfind(b"\n")      # only ship complete lines
    if last_nl < 0:
        return
    body = chunk[: last_nl + 1]
    new_offset = offset + last_nl + 1

    def ship() -> bool:
        try:
            _post(base + "/ingest/claude_code", body, headers)
            return True
        except urllib.error.HTTPError as e:
            if e.code == 404:          # source went missing — recreate and retry once
                try:
                    os.remove(marker)
                except OSError:
                    pass
                if ensure_source(base, headers):
                    open(marker, "w").write("1")
                    try:
                        _post(base + "/ingest/claude_code", body, headers)
                        return True
                    except Exception:
                        return False
            return False
        except Exception:
            return False

    if ship():
        with open(off_file, "w") as f:
            f.write(str(new_offset))   # advance only on success; failures retry next hook


if __name__ == "__main__":
    main()

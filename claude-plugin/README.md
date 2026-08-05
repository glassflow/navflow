# Tares plugin for Claude Code

One install wires Claude Code to Tares in **both directions**:

- **Read-back (MCP):** registers the `tares` MCP server so the agent can query your data plane
  (the same `tares-mcp` proxy the console hands out).
- **Capture (hooks):** ships this session's transcript into Tares's `claude_code` source as it
  progresses — via a small hook (`scripts/ship.py`) that POSTs new transcript lines to
  `{tares_url}/ingest/claude_code`.

Both wires are configured once on install (`tares_url`, optional auth `access_token`, and a
`stream_sessions` toggle).

## Prerequisites

- `tares-mcp` on PATH (from `pip install tares`) — the MCP read-back proxy.
- `python3` on PATH — runs the shipper hook.
- A Tares daemon reachable at `tares_url`.

**No manual source setup.** The shipper creates the `claude_code` push source on Tares itself the
first time it runs (on `SessionStart`), and re-creates it if it's ever missing. Installing the plugin
is the only step.

## Try it (development)

```bash
claude --plugin-dir ./claude-plugin
```

Then start a session and do some work — new transcript lines flow to Tares on each prompt/tool use
and at session end. Check the console: **Entities** (keyed by `session`), or query the `claude_code`
source.

## Distribute (marketplace)

Put `marketplace.example.json` at a repo's `.claude-plugin/marketplace.json` (pointing at this plugin
dir), then users run:

```bash
/plugin marketplace add <owner>/<repo>
/plugin install tares@<marketplace-name>
```

They're prompted for `tares_url` + token on install; the token is stored in the OS keychain.

## How capture works

Every Claude Code hook receives `transcript_path` on stdin. `ship.py` reads the new bytes since a
per-session offset (kept in `${CLAUDE_PLUGIN_DATA}`), POSTs the complete new lines as NDJSON, and only
advances the offset on success (so failures retry). It runs on `UserPromptSubmit`, `PostToolUse`
(async, non-blocking) and `SessionEnd` (flush). Local *or* remote — it just posts to `tares_url`.

## Notes / caveats (prototype)

- **Push-only source.** The `claude_code` source is fed by this plugin over `/ingest` (`config.push:
  true`, set automatically on first run). Local file tailing was removed — the plugin covers local
  and remote alike. Capture is forward-only (sessions from install onward; no backfill of old files).
- Secrets are redacted **server-side** by the `claude_code` connector before storage (the PII guard).
- `sensitive` config (the token) is passed to hook/MCP processes only as
  `CLAUDE_PLUGIN_OPTION_access_token`; the URL is also available as `${user_config.tares_url}`.

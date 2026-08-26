# Tares troubleshooting

Each entry: the symptom, the cause, the fix. Check the daemon log first: `~/.tares-up.log` (or
wherever step 3 sent it).

**`tares: command not found` after install.** uv's bin dir is not on PATH. `uv tool update-shell`,
open a new shell, or call `~/.local/bin/tares` directly.

**`/health` never returns 200.** The port is taken or the data dir is not writable. Check
`lsof -iTCP:8787 -sTCP:LISTEN` and the log. A different port: `tares up --port 8797` (then use
that port everywhere, including `--taresd` in step 6).

**`POST /api/sources` returns 409.** The name exists. `GET /api/sources` and reuse it, or pick
another name.

**`POST /api/sources` returns 400.** A config key is wrong for that connector. The body of the
response names it. Use only the keys shown in this skill or on
https://docs.glassflow.ai/tares/connectors.

**Source shows `events_total: 0` after 60 seconds.** Read `health.last_error` from
`GET /api/sources/<name>`.
- Prometheus: the URL is not reachable from the daemon's machine, or the PromQL matches no
  series. Test with `curl '<url>/api/v1/query?query=<promql>'`.
- Docker logs: wrong container name, or the container writes nothing. `docker logs <name>
  --tail 5`.
- GitHub: private repo without a token, or an expired token. The token is never returned by the
  API; re-send the source with `PUT /api/sources/<name>` and a fresh `token`.
- OTLP and webhook: nothing has been sent yet. Send one event yourself (step 4) to confirm the
  path, then hand over to the user.

**MCP client cannot connect.** `tares mcp` is not running (`lsof -iTCP:8788`), or it points at the
wrong daemon (`--taresd`). The client must use transport `streamable-http` (or `http`) and the
`/mcp` path.

**`read` returns nothing.** The entity name is wrong or outside the window. The primary label of
the source is the key: `service` for Prometheus, Docker and OTLP sources as configured above,
`repo` for GitHub, `pipeline` for the webhook. Widen the window to `1h`.

**Tares agents log "no key".** Built-in agents and Ask need an Anthropic key. Set
`ANTHROPIC_API_KEY` in the shell that runs `tares up`, or add a key under Settings in the console.
MCP reads need no key.

**Demo stack does not start.** Docker is not running, or ports 8080 and 9090 are taken.
`docker compose ps` and `lsof -iTCP:8080 -sTCP:LISTEN`.

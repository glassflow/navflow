# NavFlow

NavFlow is an open-source, self-hosted data plane for AI agents. It ingests events from your systems — logs, metrics, deploys, Postgres, Vercel, GitHub, OpenTelemetry — stores them losslessly in embedded DuckDB, and serves them through an MCP server: one correlated, time-ordered read of any entity. It also watches — triggers fire on a condition and push the correlated timeline to a subscribed agent.

It runs as two processes — `navflowd` (the daemon) and `navflow-mcp` (the MCP proxy) — writing to a
single DuckDB file. No external database or broker.

**Documentation:** [NavFlow Documentation](https://www.navflow.ai/docs) — quickstart, core concepts, connectors, MCP setup, and deployment guides.

## Install and run

```bash
uv tool install navflow        # or: pipx install navflow
navflow up                     # daemon + console on http://127.0.0.1:8787
```

Docker images and server deployment (TLS, auth) are coveredin the [server deployment guide (Docker, TLS, auth)](https://www.navflow.ai/docs/deployment).

## See it work

The fastest way to have something in the timeline is the bundled [`demo/`](demo/) — a small stack
(api-server, Prometheus, traffic) for NavFlow to ingest from, with fault injection:

```bash
cd demo && docker compose up -d && cd -   # start the stack to ingest from
```

Stop the daemon from the previous step (Ctrl-C), then restart it seeded with the demo catalog —
three sources, a correlated view, and two triggers:

```bash
NAVFLOW_CATALOG=demo/catalog.demo.yaml navflow up
```

(The catalog imports only while your catalog is still empty. Already added a source? Restart on a
fresh data directory instead: `NAVFLOW_CATALOG=demo/catalog.demo.yaml navflow up --data-dir ~/navflow-demo`.)

Open **Explore** and pick `api-server`: request logs, latency and error-rate metrics, and alerts —
three sources merged into one time-ordered timeline. That timeline is exactly what an agent gets,
so connect one next and break the demo on purpose.

Skip the demo? Add one of your own sources instead: **Sources → Add source** in the console — see the [list of supported connectors](https://www.navflow.ai/docs/connectors).

## Connect an agent over MCP

NavFlow serves its read/watch surface as an [MCP server for AI agents](https://www.navflow.ai/docs/agents). Run the MCP
endpoint and point a client (Claude Code, Cursor, Claude Desktop, …) at it:

```bash
# 1) the MCP endpoint — a second process (or use the stdio transport and skip this)
navflow mcp --transport streamable-http --port 8788 --navflowd http://localhost:8787

# 2) connect Claude Code
claude mcp add --transport http navflow http://localhost:8788/mcp
```

Running the demo? Now cause the incident — a 5xx storm — and give it ~30 seconds to be ingested:

```bash
./demo/inject.sh error_spike
```

Then ask your agent:

> Use navflow: what happened to api-server in the last 15 minutes?

The agent calls `read` and gets the incident correlated: the 5xx request logs, the error-rate
spike, and the alert in one time-ordered response — nothing to stitch together across systems.
(The `error_spike` trigger fires too — **Agents → Trigger dispatches**; `./demo/inject.sh clear`
rolls the fault back.) Other clients, stdio transport, and auth are covered in [connecting AI agents over MCP](https://www.navflow.ai/docs/agents).

## What you get: connectors, reads, triggers, MCP tools

- **Connectors** — Prometheus, Docker logs, GitHub, Postgres, Vercel, OpenTelemetry (OTLP), a generic
  webhook, agent memory, and Claude Code sessions. Add and configure sources at runtime; a **Discover**
  step proposes config for connectors that can introspect. → [Connector setup docs](https://www.navflow.ai/docs/connectors)
- **Reads** — `read(selector, window)` returns any entity's correlated timeline across *all* sources
  with no view required; `query(view, …)` reads through a saved, narrowed view; agents `subscribe` to
  be pushed the timeline when a trigger fires. → [reads, views, and triggers explained](https://www.navflow.ai/docs/concepts)
- **Console** — Sources (health + setup), **Explore** (pick an entity, read its timeline, human or
  agent view), Views & Triggers, Agents (connect a client and watch its reads and dispatches), and
  **Ask** (an in-console assistant over your data, summonable with ⌘K).
- **MCP tools** — `read`, `query`, `subscribe`, `catalog_list` / `catalog_describe`, `derive` (an
  agent authors its own view), `remember` (write observations back), and source-setup tools.
  → [MCP tools reference](https://www.navflow.ai/docs/agents)

## Architecture

Two processes share one DuckDB file. `navflowd` owns the store and runs ingest + trigger evaluation
continuously; `navflow-mcp` is a thin stdio proxy the agent spawns, reaching the daemon over HTTP.

```
  upstream ──poll/push──▶ navflowd ──▶ DuckDB ──▶ trigger eval ──fire──▶ webhook ──▶ subscribed agent
                             ▲
                      read / query / subscribe (HTTP)
                             │
                   navflow-mcp (MCP proxy) ◀── the agent
```

DuckDB is single-writer, which is why the daemon owns the DB and everything else goes through its
HTTP API. More in [Concepts](https://www.navflow.ai/docs/concepts).

## Feedback

Bug reports and ideas are very welcome via
[GitHub issues](https://github.com/glassflow/navflow/issues) or `ashish@glassflow.dev`.
**No telemetry** — NavFlow collects and sends no usage data.

## License

[MIT](LICENSE).

# NavFlow

NavFlow is an open-source, self-hosted data plane for AI agents. It ingests events like logs, metrics, deploys, Postgres, Vercel, GitHub, OpenTelemetry from your systems and stores them losslessly in embedded DuckDB, and serves them through an MCP server: one correlated, time-ordered read of any entity. It also watches changes in those events and has triggers that fire on a condition. It can push the correlated timeline to a subscribed agent or the agents can read the correlated view of the data via MCP.

It runs as two processes: `navflowd` (the daemon) and `navflow-mcp` (the MCP proxy) both writing to a
single DuckDB file. No external database or broker are needed to get navflow up and running.

**Documentation:** [NavFlow Documentation](https://www.navflow.ai/docs) where you can find quickstart, core concepts, connectors, MCP setup, and deployment guides.

## Install and run

```bash
uv tool install navflow        # or: pipx install navflow
navflow up                     # daemon + console on http://127.0.0.1:8787
```

Docker images and server deployment (TLS, auth) are coveredin the [server deployment guide (Docker, TLS, auth)](https://www.navflow.ai/docs/deployment).

## See it work

The fastest way to have something in the timeline is the bundled [`demo/`](demo/). It has a small stack
(api-server, Prometheus, traffic) for NavFlow to ingest from, with fault injection:

```bash
cd demo && docker compose up -d && cd -   # start the stack to ingest from
```

Stop the daemon from the previous step (Ctrl-C), then restart it seeded with the demo catalog with
three sources, a correlated view, and two triggers:

```bash
NAVFLOW_CATALOG=demo/catalog.demo.yaml navflow up
```

(The catalog imports only while your catalog is still empty. Already added a source? Restart on a
fresh data directory instead: `NAVFLOW_CATALOG=demo/catalog.demo.yaml navflow up --data-dir ~/navflow-demo`.)

Open **Explore** and pick `api-server`: request logs, latency and error-rate metrics, and alerts —
three sources merged into one time-ordered timeline. That timeline is exactly what an agent gets,
so connect one next and break the demo on purpose.

Skip the demo? Add one of your own sources instead: **Sources → Add source** in the console. You can see the [list of supported connectors](https://www.navflow.ai/docs/connectors).

## Connect an agent over MCP

NavFlow serves its read/watch surface as an [MCP server for AI agents](https://www.navflow.ai/docs/agents). Run the MCP
endpoint and point a client (Claude Code, Cursor, Claude Desktop, …) at it:

```bash
# 1) the MCP endpoint - a second process (or use the stdio transport and skip this)
navflow mcp --transport streamable-http --port 8788 --navflowd http://localhost:8787

# 2) connect Claude Code
claude mcp add --transport http navflow http://localhost:8788/mcp
```

Running the demo? Now cause the incident, a 5xx storm, and give it ~30 seconds to be ingested:

```bash
./demo/inject.sh error_spike
```

Then ask your agent:

> Use navflow: what happened to api-server in the last 15 minutes?

The agent calls `read` and gets the incident correlated: the `HighErrorRate` alert Prometheus fired,
the 5xx request logs, and the error-rate spike in one time-ordered response. It has nothing to stitch
together across systems. (The `incident` trigger fires too, and the catalog ships a NavFlow agent
that wakes on it and writes its diagnosis back as a **finding** on the timeline. Please set
`ANTHROPIC_API_KEY` first, or see [`demo/`](demo/). `./demo/inject.sh clear` rolls the fault back.)
Other clients, stdio transport, and auth are covered in
[connecting AI agents over MCP](https://www.navflow.ai/docs/agents).

## What you get: connectors, reads, triggers, MCP tools

- **Connectors**: Prometheus (metrics and alerts), Alertmanager, Docker logs, GitHub, Postgres,
  Vercel, OpenTelemetry (OTLP), a generic webhook, reference documents, agent memory, and Claude Code
  sessions. Add and configure sources at runtime; a **Discover** step proposes config for connectors
  that can introspect. → [Connector setup docs](https://www.navflow.ai/docs/connectors)
- **Reads**: `read(selector, window)` returns any entity's correlated timeline across *all* sources
  with no view required; `query(view, …)` reads through a saved, narrowed view; agents `subscribe` to
  be pushed the timeline when a trigger fires. → [reads, views, and triggers explained](https://www.navflow.ai/docs/concepts)
- **NavFlow agents**: attach a prompt to a trigger and NavFlow runs it in-process when the trigger
  fires: it reads the correlated timeline and writes a **finding** back onto the entity's timeline
  (so the next agent to read that entity starts ahead). Read-only — it concludes, it doesn't act.
  → [NavFlow agents](https://www.navflow.ai/docs/navflow-agents)
- **Slack**: subscribe a channel to any trigger with `slack://channel/C0123456789` and every firing
  is posted there as Block Kit — retried, logged in the delivery ledger, and visible in the console
  like any other subscriber. One bot token per instance (`NAVFLOW_SLACK_BOT_TOKEN`, or set it under
  **Security**); the token is never returned by the API. This is the way forward for Slack: an
  agent's older per-agent `slack_webhook` still works, but it is not retried or logged.
  Ask back from the same channel with the **`/navflow ask <question>`** slash command — point the
  Slack app's command at `https://<your-navflow>/api/slack/events` and set the app's signing secret
  (`NAVFLOW_SLACK_SIGNING_SECRET`, or under **Security**). Every inbound request is verified by
  HMAC-SHA256 over the raw body within a 5-minute replay window; with no signing secret configured
  the endpoint answers 503 rather than trusting anything.
- **Console**: Sources (health + setup), **Explore** (pick an entity, read its timeline, human or
  agent view), Views & Triggers, **Agents** (create NavFlow agents + connect external ones), and
  **Ask** (an in-console assistant over your data, summonable with ⌘K).
- **MCP tools**: `read`, `query`, `subscribe`, `catalog_list` / `catalog_describe`, `derive` (an
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

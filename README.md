# NavFlow

A self-hostable data plane for AI agents. NavFlow ingests events from your systems — logs, metrics,
deploys, Postgres, Vercel, GitHub, OpenTelemetry — stores them losslessly in an embedded DuckDB, and
serves an agent **one correlated, time-ordered read** of any entity over MCP. It also **watches**:
triggers fire on a condition and push the correlated timeline to a subscribed agent.

It runs as two processes — `navflowd` (the daemon) and `navflow-mcp` (the MCP proxy) — writing to a
single DuckDB file. No external database or broker.

**Documentation:** [docs.navflow.ai](https://docs.navflow.ai) — quickstart, concepts, connectors,
MCP, deployment, and guides.

## Install and run

```bash
uv tool install navflow        # or: pipx install navflow
navflow up                     # daemon + console on http://127.0.0.1:8787
```

With Docker: `docker run -p 8787:8787 -v navflow-data:/data ghcr.io/glassflow/navflow:latest`.
To self-host on a server (TLS, auth), see [Deployment](https://docs.navflow.ai/deployment).

> **Exposing it on a network?** The daemon binds `127.0.0.1` with no auth by default. Set
> `NAVFLOW_AUTH_TOKEN` (and put it behind TLS) before you bind `0.0.0.0` — it warns you if you don't.

## Connect an agent

NavFlow serves its read/watch surface over [MCP](https://docs.navflow.ai/agents). Run the MCP
endpoint and point a client (Claude Code, Cursor, Claude Desktop, …) at it:

```bash
# 1) the MCP endpoint — a second process (or use the stdio transport and skip this)
navflow mcp --transport streamable-http --port 8788 --navflowd http://localhost:8787

# 2) connect Claude Code
claude mcp add --transport http navflow http://localhost:8788/mcp
```

Then, in your agent:

> Use navflow to read the timeline for `service=checkout` over the last hour.

The agent calls `read` and gets that entity's logs, metrics, and deploys merged into one time-ordered
response — nothing to stitch together across systems. Other clients, stdio, and auth are covered in
[Connecting agents](https://docs.navflow.ai/agents).

## Try the demo

[`demo/`](demo/) stands up a small stack for NavFlow to ingest from (an api-server exposing metrics
and logs, plus Prometheus and traffic), with fault injection so you can cause an
incident and watch NavFlow correlate it:

```bash
cd demo && docker compose up -d --build && cd -              # the stack to ingest from
NAVFLOW_CATALOG=demo/catalog.demo.yaml navflow up            # console at http://127.0.0.1:8787
cd demo && ./inject.sh error_spike                           # cause an incident
```

New here? [GETTING_STARTED.md](GETTING_STARTED.md) is a five-minute, curl-only walkthrough.

## What you get

- **Connectors** — Prometheus, Docker logs, GitHub, Postgres, Vercel, OpenTelemetry (OTLP), a generic
  webhook, agent memory, and Claude Code sessions. Add and configure sources at runtime; a **Discover**
  step proposes config for connectors that can introspect. → [Connectors](https://docs.navflow.ai/connectors)
- **Reads** — `read(selector, window)` returns any entity's correlated timeline across *all* sources
  with no view required; `query(view, …)` reads through a saved, narrowed view; agents `subscribe` to
  be pushed the timeline when a trigger fires. → [Concepts](https://docs.navflow.ai/concepts)
- **Console** — Sources (health + setup), **Explore** (pick an entity, read its timeline, human or
  agent view), Views & Triggers, Agents (connect a client and watch its reads and dispatches), and
  **Ask** (an in-console assistant over your data, summonable with ⌘K).
- **MCP tools** — `read`, `query`, `subscribe`, `catalog_list` / `catalog_describe`, `derive` (an
  agent authors its own view), `remember` (write observations back), and source-setup tools.
  → [MCP](https://docs.navflow.ai/agents)

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
HTTP API. More in [Concepts](https://docs.navflow.ai/concepts).

## Feedback

Bug reports and ideas are very welcome via
[GitHub issues](https://github.com/glassflow/navflow/issues) or `ashish@glassflow.dev`.
**No telemetry** — NavFlow collects and sends no usage data.

## License

[MIT](LICENSE).

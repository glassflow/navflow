# NavFlow

A self-hostable data plane for AI agents. NavFlow ingests events from your systems — logs, metrics,
deploys, Postgres, Vercel, GitHub, OpenTelemetry — stores them losslessly in an embedded DuckDB, and
serves an agent **one correlated, time-ordered read** of any entity over MCP. It also **watches**:
triggers fire on a condition and push the correlated timeline to a subscribed agent.

It runs as two processes — `navflowd` (the daemon) and `navflow-mcp` (the MCP proxy) — writing to a
single DuckDB file. No external database or broker.

**Documentation:** [docs.navflow.ai](https://docs.navflow.ai) covers install, quickstart, concepts,
connectors, MCP, deployment, and guides.

## Install and run

```bash
uv tool install navflow        # or: pipx install navflow
navflow up                     # daemon + console on http://127.0.0.1:8787

# in another terminal — the MCP endpoint agents connect to
navflow mcp --transport streamable-http --port 8788 --navflowd http://localhost:8787
```

With Docker: `docker run -p 8787:8787 -v navflow-data:/data ghcr.io/glassflow/navflow:latest`.
From source: `uv venv && uv pip install -e . && navflow up`. To self-host on a server (TLS, auth),
see [Deployment](https://docs.navflow.ai) — `deploy/` holds the Docker image and compose files.

> **Exposing it on a network?** The daemon binds `127.0.0.1` with no auth by default. Set
> `NAVFLOW_AUTH_TOKEN` (and put it behind TLS) before you bind `0.0.0.0` — it prints a warning if
> you don't.

**Feedback:** bug reports and ideas are very welcome via
[GitHub issues](https://github.com/glassflow/navflow/issues) or `ashish@glassflow.dev`.
**No telemetry:** NavFlow collects and sends no usage data — nothing phones home.

## Try the demo

[`demo/`](demo/) stands up a small stack for NavFlow to ingest from (an api-server exposing metrics,
logs, and an admin API, plus Prometheus and a traffic generator), with fault injection so you can
cause an incident and watch NavFlow correlate it:

```bash
cd demo && docker compose up -d --build && cd -              # the stack to ingest from
NAVFLOW_CATALOG=demo/catalog.demo.yaml navflow up            # console at http://127.0.0.1:8787
cd demo && ./inject.sh error_spike                           # cause an incident
```

New to NavFlow? [GETTING_STARTED.md](GETTING_STARTED.md) is a five-minute, curl-only walkthrough
that needs no upstream systems.

## Connectors

Prometheus · Docker logs · GitHub · Postgres · Vercel · OpenTelemetry (OTLP HTTP + gRPC) · generic
webhook (push) · agent memory · Claude Code sessions. Each connector declares a self-describing
config schema, so the console generates its setup form and validates every write path identically.

## Architecture

Two processes share one DuckDB file.

```
                       upstream: Prometheus, admin APIs, docker logs, webhooks, …
                                          │  poll / push
        ┌─────────────────────────────────▼──────────────────────────────────┐
        │  navflowd  (daemon — sole owner of the store)                        │
        │    connectors ─→ DuckDB ─→ trigger eval ─fire→ webhook dispatch      │
        │    local HTTP API:  POST /read · POST /query · POST /subscribe       │
        └──────────▲──────────────────────────────────────────┬───────────────┘
              read / subscribe (HTTP)                     dispatch + payload (webhook)
                   │                                            │
            ┌──────┴────────┐                                   ▼
            │ navflow-mcp   │  (stdio, spawned per agent session)   agent's "woke" endpoint
            │ thin proxy    │◄── MCP tools: read, query, subscribe, catalog_*, derive, remember
            └──────▲────────┘
                   │ MCP
                the agent
```

- **Two processes.** Ingest and trigger evaluation run *continuously*, so they live in `navflowd`.
  An MCP stdio server only lives for an agent session, so `navflow-mcp` is a thin proxy the agent
  spawns; it reaches the daemon over HTTP. `navflowd` is the only process that touches the DB.
- **DuckDB.** Embedded, zero-ops, a single file; columnar with fast time-range scans; first-class
  JSON so the lossless `payload` column stays queryable. DuckDB is single-writer, which is why the
  daemon owns the DB and everything else goes through its HTTP API.
- **Connectors** are poll loops on a per-source interval, or push endpoints (`POST /ingest/{source}`)
  for producers like webhooks and OTLP.
- **Triggers** are evaluated in the daemon as SQL aggregates over the window after each ingest tick;
  on a match (outside cooldown) the daemon renders the correlated timeline and POSTs it to
  subscribed webhooks. Cooldown state survives restart.

## The console

`navflowd` serves a console at `http://127.0.0.1:8787/`:

- **Sources** — every source with live health (status, last ingest, last error, event counts);
  add / edit / pause / resume / delete at runtime, no restart. Forms are generated from each
  connector's schema, with a test-connection that runs one poll server-side before you save.
  Connectors that can introspect (Prometheus) offer **Discover** — point it at an endpoint and it
  proposes what to ingest, deterministically (no LLM).
- **Explore** — pick any entity, read its correlated, time-ordered timeline across every source,
  narrow it with label filters, and toggle between a readable view and the exact payload an agent
  receives over MCP. Save a slice as a reusable view.
- **Views & Triggers** — manage what agents read and what wakes them.
- **Agents** — connect an MCP client, and watch what they do: the read log, the trigger dispatch
  log (with delivery status and the exact payload delivered), and subscriptions.
- **Ask** — an in-console assistant with read access to your data, for exploring or debugging what
  you're ingesting (also summonable anywhere with ⌘K).

Build the console once: `cd ui && npm install && npm run build` (dev: `npm run dev`, which proxies
to a running `navflowd`).

## Sources, labels & entities

A **source is an ingest pipe** — defined entirely by its connector. What an event is *about* is
carried by **labels**: named correlation axes a source declares, each a fixed `const` or a per-event
`field`:

```yaml
- name: logs
  connector: docker_logs
  config:
    container: app
    labels:
      - {name: env, const: prod}      # fixed for this source
      - {name: app, field: app}       # extracted from each event
```

An **entity is a `(label, value)` pair** — `env=prod`, `app=ui`. Agents and triggers work along any
label:

- **Read** by label: `read({"env": "prod"})`, or an intersection `{"env": "prod", "app": "ui"}`
  (strict AND). No view required.
- **Trigger** per label: a condition with `group_by: [env, app]` fires (and cools down)
  independently per `(env, app)` tuple.
- **Browse** every entity in Explore.

Labels are **retroactive**: because the original payload is kept lossless, a label declared today is
backfilled over events ingested before it existed (only fields that were actually present qualify).

## Reading the data

- **`read(selector, window)`** — a correlated, time-ordered timeline across *all* sources matching a
  conjunction of `label=value` constraints (strict AND), no view required. This is the primitive:
  read any entity on the fly.
- **`query(view, key|where, window)`** — read through a saved view (a narrowed source set + optional
  filters).
- **`subscribe(trigger, url)`** — get pushed the correlated timeline when a trigger fires.

Every read carries each event's labels, so the dimensions you filtered or sliced by are visible on
every row.

## Discover: introspect a source, don't interrogate the user

`POST /api/sources/discover` (and the **Discover** button) points at an upstream and proposes a
source config — deterministically, no LLM. For Prometheus it reads the metadata APIs and returns
which metrics to ingest, a suggested entity key ranked from the series' own labels, the labels to
carry, and type-aware derived suggestions (rate of `*_total` counters, p99 of histograms). You
review, test, and create — instead of hand-writing config.

## The agent shapes its own reads

- **`catalog_describe(handle)`** — full discovery for one entry: an inferred schema (event types +
  typed fields), freshness (last event + lag), lineage (source → view → trigger), and sample records.
- **`derive(sources, key_field, filters?, name?)`** — an agent proposes a view; it lands in the live
  catalog and is immediately queryable by name. Views carry optional filters (`[{field, op, value}]`)
  applied on reads and trigger eval, plus usage stats.
- **`remember(key, content, memory_type?)`** — the agent writes observations back; the first write
  auto-provisions an `agent_memory` source. Memory is a source like any other, so what the agent
  learned last incident appears in the next correlated timeline.

## Catalog & config

The catalog lives in the store (DuckDB tables), so the console and API can mutate it live. On first
boot with an empty catalog, `NAVFLOW_CATALOG` (default `catalog.yaml`) is imported once; after that,
YAML is a portable import/export format (`GET /api/catalog/export`, `POST /api/catalog/import`) —
git it, share it, seed new deployments with it.

Each connector declares an authoritative config schema. Every write path — the console form,
Discover, YAML import, raw API — runs through one `normalize_config()` that validates against it, so
a source set up any of those ways stores the identical canonical config and exports identical YAML.

## Push ingestion

Sources with `connector: webhook` don't poll — producers `POST` JSON to `/ingest/{source}`. The
source config maps payload fields into the event (`key_field`, `event_type_field`, `text_template`,
`event_time_field`); numeric top-level fields become trigger-usable, and the original payload is kept
lossless. This is the generic inbound path for GitHub / Vercel / custom events.

## Management API

Everything the console does is plain HTTP under `/api`: CRUD for `/api/sources` (+ `/pause`,
`/resume`, `/test`, `/{name}/events`, `/{name}/fields`), `/api/views`, `/api/triggers`;
`/api/activity/queries`, `/api/activity/dispatches`, `/api/subscriptions`; `/api/connectors`;
`/api/entities`; `/api/catalog/export|import`. The agent surface is `/read`, `/query`, `/subscribe`,
`/catalog`, `/health`.

## License

[MIT](LICENSE).

# NavFlow

A self-hostable data plane for AI agents. NavFlow ingests events from your systems — logs, metrics,
deploys, Postgres, Vercel, GitHub, OpenTelemetry — stores them losslessly in an embedded DuckDB, and
serves an agent **one correlated, time-ordered read** of any entity over MCP (`query`). It also
**watches**: triggers fire on a condition and push the correlated timeline to a subscribed agent.

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

**Feedback:** this is an early release; bug reports and ideas are very welcome via
[GitHub issues](https://github.com/glassflow/navflow/issues) or `ashish@glassflow.dev`.
**No telemetry:** NavFlow collects and sends no usage data — nothing phones home.

---

## Background

NavFlow is collapsed from a larger
[design doc](https://app.notion.com/p/glassflow/Design-Doc-36f1c086bb6d812db6f8c232853c04df): every
heavy component (a medallion store, a streaming substrate, a separate trigger engine, a Postgres
catalog) is reduced to its smallest honest form, each with a documented expand path (the collapse
map below). It began as the runnable service behind an SRE incident-response cookbook.

---

## What it is (and isn't)

| MVP is | MVP is not |
|---|---|
| Local or single-tenant server (optional token auth) | Hosted / multi-tenant |
| One store (DuckDB), lossless via a JSON `payload` column | Bronze (S3) + Silver (ClickHouse) medallion |
| Poll-based connectors | A streaming substrate (NATS JetStream) |
| In-daemon trigger evaluation | A separate stream-consumer trigger engine |
| A YAML catalog | A Postgres catalog service + lineage graph |
| Read, watch, and **author** over MCP (`query`, `subscribe`, `derive`, `remember`, source setup) | A managed control plane |

The differentiator versus a read-only query federator (e.g. Coral) is exactly the two things this
MVP keeps and a federator omits: a **store** (retention / lossless) and a **trigger loop** (push).
Those are the only parts that make this NavFlow and not a worse Coral.

---

## Architecture

Two processes share one DuckDB file.

```
                       upstream: Prometheus (:9090), api-server admin (:8080), docker logs
                                          │  poll
        ┌─────────────────────────────────▼──────────────────────────────────┐
        │  navflowd  (daemon — sole owner of the store)                        │
        │    connectors ─poll→ DuckDB ─→ trigger eval ─fire→ webhook dispatch  │
        │    local HTTP API:  POST /query · POST /subscribe · GET /catalog     │
        └──────────▲──────────────────────────────────────────┬───────────────┘
              query / subscribe (HTTP)                    dispatch + payload (webhook)
                   │                                            │
            ┌──────┴────────┐                                   ▼
            │ navflow-mcp   │  (stdio, spawned per agent session)   agent's "woke" endpoint
            │ thin proxy    │◄── MCP tools: query, subscribe, catalog_list
            └──────▲────────┘
                   │ MCP
                the agent
```

**Why two processes.** Ingest and trigger evaluation must run *continuously* — that's what "the
store wakes the agent" means. But an MCP stdio server only lives for an agent session. So the
always-on work lives in `navflowd`; the MCP server is a thin proxy the agent spawns. This also
sidesteps DuckDB's single-writer limit (below): `navflowd` is the only process that touches the
DB; the MCP server reaches it over HTTP.

### Why DuckDB

The workload is append-only low-volume writes plus keyed time-range reads
(`WHERE source=? AND key_value=? AND event_time >= now-window`) and windowed aggregates for
trigger eval. DuckDB fits on four points:

- **Embedded, zero-ops, single file** — matches local/single-tenant.
- **Columnar + zonemaps** — time-range scans are fast without index tuning.
- **First-class JSON** — the lossless `payload` column stays queryable.
- **It's the honest local analog of the eventual ClickHouse silver store** — same OLAP shape, so
  the expand path is a swap, not a rewrite.

The real caveat: DuckDB is **single-writer** and won't let a second process read while one writes
(exclusive lock). That limit is load-bearing — it's *why* `navflowd` owns the DB and the MCP
server proxies over HTTP. SQLite (WAL) is the closest alternative (better cross-process
concurrency), but since all access already funnels through `navflowd`, that advantage is moot and
DuckDB's columnar + JSON + aggregate ergonomics win.

### How connectors read

Each connector is a **poll loop** on a per-source interval, reading via that source's native
protocol — the same logic the cookbook's `platform_client.py` had, relocated into `navflowd` and
put on a timer:

| source | reads via | incremental mechanism |
|---|---|---|
| `metrics` | Prometheus `GET /api/v1/query?query=<promql>` | stateless snapshot per tick |
| `deploys` | api-server `GET /admin/changelog` | **cursor** (last-seen ts) |
| `config` | api-server `GET /admin/config` | **snapshot + hash dedupe** |
| `logs` | `docker compose logs --since <cursor> --timestamps` | **cursor** (best-effort, last ts) |
| `alerts` | synthesized at ingest from the Prometheus 5xx ratio | — |

All of these are **pull/poll**. The faithful streaming versions (Prometheus remote-write, a deploy
webhook, log streaming) are lower-latency and more lossless but heavier; poll matches what the
platform already exposes, and the poll interval bounds freshness.

### Where triggers are evaluated

**In `navflowd`, the continuous daemon — not in the MCP server, not in the agent.** This is the
core fix over the cookbook dummy, whose `trigger.wait()` runs *inside the agent's process and polls
Prometheus itself* (the agent polling, not the store pushing).

MVP implementation (`triggers.py`): after each connector's ingest tick, `navflowd` runs each active
trigger as a **SQL aggregate over the DuckDB window** (`MAX(rate_5xx) ... GROUP BY key_value`,
tested against the predicate); on a match not in cooldown, it renders `view(key, window)` and POSTs
the dispatch to subscribed webhooks. Cooldown state lives in a `trigger_state` table so it survives
restart.

- **Cost:** trigger latency is bounded by the poll interval (~5s) — fine for the cookbook, not
  "sub-second."
- **Expand path:** move evaluation onto an in-flight in-memory window (decoupled from poll/store) —
  that in-memory window is exactly what JetStream KV becomes in the full design. NATS never has to
  enter the picture for the cookbook.

### Collapse map → full design

Every shortcut here has a documented expansion:

| MVP (this repo) | → full design |
|---|---|
| one DuckDB table + JSON `payload` | Bronze (S3, immutable) + Silver (ClickHouse, typed per source type) |
| in-daemon SQL trigger eval | stream-consumer Trigger Engine, windowed state in JetStream KV |
| YAML catalog | Postgres Catalog Service + lineage DAG |
| poll connectors | connector framework producing to a NATS substrate |
| local HTTP between proxy and daemon | gRPC (as in the design doc / Coral) |
| single-tenant | `project_id` propagation + per-project isolation |

---

## Layout

```
navflow/
  README.md                  ← this file
  GETTING_STARTED.md         ← new-user walkthrough: zero → ingest/serve/watch with curl
  NEXT.md                    ← what we build next, and why (traced to the design doc)
  pyproject.toml             ← package + the navflowd / navflow-mcp entry points
  demo/                      ← one-command stack to ingest from (api-server + Prometheus + traffic)
  catalog.example.yaml       ← sources, views, triggers (wired to the cookbook platform)
  navflow/
    envelope.py              ← the universal record shape
    config.py                ← catalog types, YAML import/export, validation (DB is source of truth)
    store.py                 ← DuckDB: events, catalog tables, query/dispatch logs, cursors, subs
    runtime.py               ← live source lifecycle: start/stop/pause loops, health, push ingest
    connectors/
      base.py                ← Connector ABC (poll() -> [Envelope])
      __init__.py            ← registry + SPECS (self-describing config schemas, drives UI forms)
      prometheus.py          ← poll PromQL
      changelog.py           ← poll /admin/changelog (cursor)
      config_snapshot.py     ← poll /admin/config (hash dedupe)
      docker_logs.py         ← docker logs --since (cursor)
      alerts.py              ← synthesize alerts from the 5xx ratio
      webhook.py             ← push ingestion: POST /ingest/{source} -> Envelopes (lossless)
      memory.py              ← agent memory: the agent's own observations as a source
    views.py                 ← resolve query(view,key,window) -> the rendered timeline payload
    triggers.py              ← evaluate conditions over the window, fire dispatches
    dispatch.py              ← webhook delivery with retry/backoff; every firing logged
    daemon.py                ← navflowd: runtime + agent API + management API (/api) + console
    mcp_server.py            ← navflow-mcp: stdio MCP proxy -> navflowd HTTP
    cli.py                   ← entry points
  ui/                        ← the console: React/Vite SPA served by navflowd at /
    src/pages/               ← Sources, Views & Triggers, Agent Activity, Catalog
  examples/
    woke_receiver.py         ← a tiny webhook that prints dispatches (stands in for the agent)
```

---

## Run it

New here? [GETTING_STARTED.md](GETTING_STARTED.md) is the five-minute, curl-only walkthrough
(no upstream systems needed). For the full experience, [`demo/`](demo/) stands up a stack to
ingest from — with fault injection so you can cause an incident and watch NavFlow correlate it.

Prereq: a stack for NavFlow to ingest from must be up. The simplest is the bundled demo:

```bash
cd demo && docker compose up -d --build && cd -   # api-server + Prometheus + traffic
```

Then:

```bash
uv venv && uv pip install -e .
cp demo/catalog.demo.yaml catalog.yaml    # sources/views/triggers wired to the demo stack

# terminal 1 — the daemon (ingest + serve + watch)
navflowd                                  # http://127.0.0.1:8787

# terminal 2 — see a push when a fault is injected
python examples/woke_receiver.py          # http://127.0.0.1:9999/woke
curl -XPOST localhost:8787/subscribe -d '{"trigger":"error_spike","url":"http://127.0.0.1:9999/woke"}' -H 'content-type: application/json'

# pull a correlated read directly
curl -XPOST localhost:8787/query -d '{"view":"service_timeline","key":"api-server","window":"15m"}' -H 'content-type: application/json'

# inject a fault on the platform and watch terminal 2 wake up
curl -XPOST localhost:8080/admin/fault -d '{"lever":"error_rate","value":0.3}' -H 'content-type: application/json'
```

To point an agent at it, register `navflow-mcp` as an MCP server (it proxies to `navflowd`):

```bash
NAVFLOWD_URL=http://127.0.0.1:8787 navflow-mcp     # stdio MCP: query, subscribe, catalog_list,
                                                   #   catalog_describe, derive, remember
```

---

## The console

`navflowd` serves a management console at `http://127.0.0.1:8787/`:

- **Sources** — every source with live health (status, last ingest, last error, event counts);
  add/edit/pause/resume/delete sources at runtime, no daemon restart. Forms are generated from
  the connector registry's self-describing specs (`GET /api/connectors`), with a
  test-connection that runs one poll server-side before you save. Connectors that can introspect
  (Prometheus) offer **Discover** — point it at the endpoint and it proposes what to ingest, a
  suggested entity key, and labels, *deterministically* (no LLM); see below.
- **Entities** — every `(label, value)` the store has seen, faceted by label; click a value to
  read its correlated cross-source timeline (see "Sources, labels & entities" below).
- **Views & Triggers** — manage what agents read and what wakes them.
- **Agent Activity** — the query log (every `query()` call, tagged `mcp`/`http`/`ui`), the
  trigger dispatch log (with delivery status and the exact rendered payload the agent got),
  subscriptions, and a query playground that runs the exact read an agent would.
- **Catalog** — export the catalog as YAML / import YAML (merge or replace).

Build it once: `cd ui && npm install && npm run build` (dev mode: `npm run dev`, proxies to a
running `navflowd`).

### Sources, labels & entities

A **source is an ingest pipe** — defined entirely by its connector (its signal `type` is derived
from the connector, not authored). What an event is *about* is carried by **labels**: named
correlation axes a source declares, each a fixed `const` or a per-event `field`:

```yaml
- name: logs
  connector: docker_logs
  config:
    container: app
    labels:
      - {name: env, const: prod}      # fixed for this source
      - {name: app, field: app}       # extracted from each event
```

An **entity is a `(label, value)` pair** — `env=prod`, `app=ui`. Agents and triggers work along
any label:

- **Read** by label: `query(view, where={"env": "prod"})`, or an intersection
  `{"env": "prod", "app": "ui"}`. The legacy primary key still works (`query(view, key=...)`).
- **Trigger** per label: a condition with `group_by: [env, app]` fires (and cools down)
  independently per `(env, app)` tuple — alert narrow, the agent widens on demand.
- **Browse** every entity on the Entities page / `GET /api/entities`.

Labels are **retroactive**: because the original payload is kept lossless, a label declared today
is backfilled over events ingested before it existed (only fields that were actually present
qualify). Connectors extract from whatever they expose per event — a webhook payload, a Prometheus
series' label set, or named groups from a `label_pattern` on a log line.

### Discover: introspect a source, don't interrogate the user

`POST /api/sources/discover` (and the **Discover** button on a connector that supports it) points
at an upstream and proposes a source config — *deterministically, no LLM*. For Prometheus it reads
the metadata APIs and returns: which metrics to ingest raw (lossless — rates/quantiles are
derivable later), a **suggested entity key** ranked from the series' own labels (e.g. `service`,
with its real values), the **labels** to carry, and type-aware **derived suggestions** (rate of
`*_total` counters, p99 of histograms) you accept or ignore. You click Apply, review, Test, Create
— instead of hand-writing PromQL. The same `discover()` shape is how every connector should
onboard (webhook from a sample payload, logs from sample lines); Prometheus is the first.

### Catalog: DB-backed, YAML as the portable form

The catalog now lives in the store (DuckDB tables), so the UI and API can mutate it live. On
first boot with an empty catalog, `NAVFLOW_CATALOG` (default `catalog.yaml`) is imported once;
after that, YAML is an import/export format (`GET /api/catalog/export`,
`POST /api/catalog/import`) — git it, share it, seed new deployments with it.

### Canonical config: one source of truth per connector

Each connector declares an authoritative `CONFIG_SCHEMA` (the universal `labels` is merged in).
It's the single source of truth: the `SPECS` form fields are *generated* from it, and every write
path — the UI form, Discover, YAML import, raw API — runs through one `normalize_config()` that
validates against it (required enforced, unknown keys rejected), coerces types, applies/omits
defaults, and orders keys. So a source set up *any* of those ways stores the **identical canonical
config** and exports the **identical YAML** (git-friendly, stable across round-trips). Prometheus
and webhook are migrated; other connectors pass through unchanged until they declare a schema.

### Push ingestion (webhook connector)

Sources with `connector: webhook` don't poll — producers POST JSON to
`POST /ingest/{source}`. The source config maps payload fields into the envelope
(`key_field`, `event_type_field`, `text_template`, `event_time_field`); numeric top-level
fields become trigger-usable typed fields; the original payload is kept lossless. This is the
generic inbound path for GitHub/Vercel/custom events.

### The agent shapes its own reads (describe → derive → remember)

Three agent-surface additions (see `NEXT.md` for the design-doc tracing) turn the MVP from
"infrastructure that works" into the authorship thesis, demoable:

- **`catalog_describe(handle)`** (`GET /catalog/source:logs` etc.) — full discovery for one
  entry: an inferred schema (event types + typed fields, sampled from stored events),
  freshness (last event + lag), lineage edges (source → view → trigger), sample records.
- **`derive(sources, key_field, filters?, name?)`** (`POST /derive`) — an agent proposes a
  *virtual* view; it lands in the live catalog tagged `created_by: agent:<client>` and is
  immediately queryable by name. Views now carry optional **filters**
  (`[{field, op, value}]`) applied on reads *and* trigger eval, and **usage** (query count +
  last used, from the query log) — the seed of usage-driven deprecation. Materialization and
  cost gates stay post-MVP.
- **`remember(key, content, memory_type?)`** (`POST /remember`) — the agent writes
  observations back; the first write auto-provisions an `agent_memory` push source. Memory is
  a source like any other, so what the agent learned last incident appears in the next
  correlated timeline. (Append-only — the design doc's bi-temporal revision semantics are
  deliberately collapsed.)

### Management API

Everything the console does is plain HTTP under `/api`: CRUD for
`/api/sources` (+ `/pause`, `/resume`, `/test`, `/{name}/events`), `/api/views`,
`/api/triggers`; `/api/activity/queries`, `/api/activity/dispatches`, `/api/subscriptions`;
`/api/connectors`; `/api/catalog/export|import`. The agent surface
(`/query`, `/subscribe`, `/catalog`, `/health`) is unchanged.

---

## Status

Runnable and self-hostable. Implemented and exercised end to end: the two-process split, the
store, twelve connectors (Prometheus, Docker logs, GitHub, Postgres, Vercel, OTLP/HTTP+gRPC,
webhook, agent memory, and the cookbook's changelog/config/alerts/static), query resolution,
in-daemon trigger evaluation, the DB-backed catalog with live source management, the agent
authorship surface (`catalog_describe` / `derive` / `remember`) and source-setup tools over MCP,
the console (sources, **Explore** cross-source timelines, field coverage, an in-app **Ask** agent
with a ⌘K palette, and an **Agents** view for MCP clients), single-tenant token auth + read-only mode, and
deployment via a published image (`ghcr.io/glassflow/navflow`, pinned releases) with a Docker
Compose self-host (daemon + MCP server + Caddy/TLS).

Pre-1.0; commands and config may change between releases. Still collapsed from the full design —
the medallion store, streaming substrate, separate trigger engine, and multi-tenant control plane
remain the expand path (see the collapse map above and `NEXT.md`).

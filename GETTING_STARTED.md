# Getting started with NavFlow

Your agent doesn't have a reasoning problem — it has an input problem. When something breaks,
it burns its context window making 7–16 separate calls (metrics, logs, deploy history, config)
and tries to stitch them together. And it only does that when *asked*, because nothing wakes
it up.

NavFlow is a small data plane that sits between your systems and your agent:

- **Ingest** — continuously pulls (or receives) signals from many sources into one lossless store.
- **Serve** — the agent asks once (`query(view, key, window)`) and gets **one correlated,
  time-ordered timeline** instead of N fan-out reads.
- **Watch** — when a condition you define fires, NavFlow **pushes**: it wakes the agent with
  the relevant context already attached.

This guide takes you from zero to all three in about five minutes, with nothing but `curl`.
No upstream systems required.

---

## The mental model — four nouns

| Noun | What it is | Where you manage it |
|---|---|---|
| **Source** | Where data comes from. *Poll* sources (Prometheus, changelogs, docker logs…) are pulled on a timer; *push* sources (webhooks, agent memory) receive POSTs. | Console → Sources |
| **View** | What agents read: a named correlation — "these sources, keyed by `service`", optionally filtered. | Console → Views & Triggers |
| **Trigger** | What wakes agents: a condition over a view (`max(rate_5xx) > 1.0 over 1m`). On fire, the rendered timeline is POSTed to subscribers. | Console → Views & Triggers |
| **The agent surface** | Six MCP tools: `catalog_list`, `catalog_describe`, `query`, `subscribe`, `derive`, `remember`. | Console → Agent Activity (to watch it) |

Every record, whatever the source, lands in one envelope shape: a **key** (which entity it's
about), an **event type**, a human-readable **text** line, typed **fields** (usable in
triggers), and the original **payload** kept lossless.

---

## 0. Install & start

```bash
cd navflow
uv venv && uv pip install -e .

navflowd                       # → http://127.0.0.1:8787
```

That's the whole deployment: one process, one DuckDB file (`navflow.duckdb`). Open
**http://127.0.0.1:8787** — that's the console. If you have no `catalog.yaml`, you start
empty; everything below builds the catalog live (no restarts, ever).

> Env knobs: `NAVFLOW_PORT`, `NAVFLOW_DB`, `NAVFLOW_CATALOG` (YAML imported once on first
> boot if the catalog is empty).

---

## 1. Ingest — create a source and feed it (60 seconds)

Create a push (webhook) source. The config maps payload fields into the envelope:

```bash
curl -s -XPOST localhost:8787/api/sources -H 'content-type: application/json' -d '{
  "name": "checkout_probe",
  "type": "event_stream",
  "connector": "webhook",
  "config": {
    "key_field": "service",
    "event_type": "probe",
    "text_template": "latency {latency_ms}ms on {endpoint}"
  }
}'
```

Feed it:

```bash
curl -s -XPOST localhost:8787/ingest/checkout_probe -H 'content-type: application/json' \
  -d '{"service": "checkout", "endpoint": "/pay", "latency_ms": 120}'
curl -s -XPOST localhost:8787/ingest/checkout_probe -H 'content-type: application/json' \
  -d '{"service": "checkout", "endpoint": "/pay", "latency_ms": 1450}'
curl -s -XPOST localhost:8787/ingest/checkout_probe -H 'content-type: application/json' \
  -d '{"service": "search", "endpoint": "/q", "latency_ms": 45}'
```

Numeric payload fields (`latency_ms`) automatically become typed fields triggers can
aggregate over; the full payload is kept lossless. Check the **Sources** page in the console —
your source is there, with live health and an event count. Click it to see the events.

This is the generic inbound path for anything that can send JSON: GitHub webhooks, Vercel,
CI, cron jobs, your own services.

> Polling instead: in the console, **Sources → Add source** shows all connectors
> (Prometheus, changelog, config snapshot, docker logs…). The form is generated from the
> connector's spec, and **Test connection** runs one real poll server-side before you save.

## 2. Serve — make it readable with a view (30 seconds)

```bash
curl -s -XPOST localhost:8787/api/views -H 'content-type: application/json' -d '{
  "name": "service_health",
  "key_field": "service",
  "sources": ["checkout_probe"]
}'
```

Now run the exact read an agent would:

```bash
curl -s -XPOST localhost:8787/query -H 'content-type: application/json' \
  -d '{"view": "service_health", "key": "checkout", "window": "15m"}'
```

You get one time-ordered timeline for `checkout`. With one source it's modest — the payoff
comes when the view correlates five sources and the deploy, the config change, and the error
spike arrive interleaved in time order. (The console's **Agent Activity → Query playground**
runs the same read with a UI.)

## 3. Watch — a trigger that wakes someone (90 seconds)

Start the demo receiver (stands in for your agent's webhook) in a second terminal:

```bash
python examples/woke_receiver.py        # listens on http://127.0.0.1:9999/woke
```

Define the condition and subscribe the receiver:

```bash
curl -s -XPOST localhost:8787/api/triggers -H 'content-type: application/json' -d '{
  "name": "slow_checkout",
  "view": "service_health",
  "condition": {"aggregate": "max", "field": "latency_ms", "predicate": "> 1000", "window": "5m"},
  "emit": {"kind": "slow_checkout", "context_window": "15m"},
  "cooldown": "1m"
}'

curl -s -XPOST localhost:8787/subscribe -H 'content-type: application/json' \
  -d '{"trigger": "slow_checkout", "url": "http://127.0.0.1:9999/woke"}'
```

Now cause the condition:

```bash
curl -s -XPOST localhost:8787/ingest/checkout_probe -H 'content-type: application/json' \
  -d '{"service": "checkout", "endpoint": "/pay", "latency_ms": 2100}'
```

The receiver terminal prints the dispatch — **with the 15-minute correlated timeline already
attached**. That's the core move: the store wakes the agent, and the agent starts with
context instead of fetching it. Every firing (even with zero subscribers) is logged under
**Agent Activity → Trigger dispatches**, payload included.

## 4. Connect a real agent (MCP)

Register the MCP proxy with your agent runtime — e.g. for Claude Code:

```bash
claude mcp add navflow -e NAVFLOWD_URL=http://127.0.0.1:8787 -- navflow-mcp
```

The agent now has six tools, and the intended loop is:

1. **`catalog_list`** / **`catalog_describe`** — discover what exists. Describe returns the
   inferred schema (event types + typed fields, sampled from real events), freshness, lineage,
   and sample records: everything needed to write a good query without guessing field names.
   ```bash
   curl -s localhost:8787/catalog/source:checkout_probe | python3 -m json.tool
   ```
2. **`query(view, key, window)`** — the one correlated read.
3. **`subscribe(trigger, url)`** — register to be woken.
4. **`derive(sources, key_field, filters?, name?)`** — when the agent keeps re-asking the same
   shape, it proposes its own view. It lands in the live catalog tagged `agent`, immediately
   queryable:
   ```bash
   curl -s -XPOST localhost:8787/derive -H 'content-type: application/json' -d '{
     "sources": ["checkout_probe"], "key_field": "service", "name": "slow_only",
     "filters": [{"field": "latency_ms", "op": "gt", "value": 1000}]}'
   ```
5. **`remember(key, content)`** — the agent writes its conclusion back:
   ```bash
   curl -s -XPOST localhost:8787/remember -H 'content-type: application/json' \
     -d '{"key": "checkout", "content": "latency spikes on /pay correlate with payments deploys"}'
   ```
   The first write auto-provisions an `agent_memory` source. Memory is a source like any
   other — add it to a view and **what the agent learned last incident appears inside the
   timeline next time the same key acts up**. The loop closes.

Watch all of it under **Agent Activity**: every query (tagged `mcp`/`http`/`ui`), every
dispatch with delivery status, every subscription. The **Views & Triggers** page shows which
views were authored by agents and how much each is actually used.

## 5. Keep it / share it

The catalog lives in the daemon's store; YAML is its portable form:

```bash
curl -s localhost:8787/api/catalog/export > catalog.yaml    # git it, share it
```

Importing (console → **Catalog**, or `POST /api/catalog/import`) supports merge or replace,
validated as a whole before anything is written. A fresh daemon pointed at that YAML
reproduces your whole setup on first boot.

---

## The full demo (real upstream systems)

The curl path above is self-contained. For the real thing — Prometheus + logs + deploys +
config feeding an SRE incident-response agent — bring up the cookbook platform and use the
ready-made catalog:

```bash
cd ../navflow-cookbooks/platform && docker compose up -d && cd -
cp catalog.example.yaml catalog.yaml
navflowd
# inject a fault and watch the error_spike trigger fire:
curl -XPOST localhost:8080/admin/fault -d '{"lever":"error_rate","value":0.3}' -H 'content-type: application/json'
```

---

## Honest scope

This is an MVP: local, single-tenant, no auth, one DuckDB file, trigger latency bounded by
the poll interval (~5s). Each of those is a deliberate collapse of the full design with a
documented expand path — see the collapse map in [README.md](README.md).

# NavFlow demo

A self-contained stack to see NavFlow in action. It stands up a small **`api-server`** (Prometheus
metrics, request logs, and a `/demo/inject` fault switch) plus **Prometheus** and a **traffic generator** — the
*upstream systems NavFlow ingests from*. NavFlow itself is installed separately (below) and reads
from this stack, exactly as it would read from your real systems.

```
 demo stack (docker)                     NavFlow (uv install, on your machine)
 ┌───────────────┐  scrape   ┌────────┐
 │  api-server   │◄──────────│Promethe│◄─── metrics (:9090 PromQL)
 │  :8080        │           │ us     │
 │  /metrics     │──logs────────────────── docker logs
 │  /demo/inject │  (fault injection)      → one correlated timeline + triggers
 └───────────────┘
        ▲ traffic-generator
```

Two files, no checkout needed: `docker-compose.yml` (the stack) and `catalog.demo.yaml` (NavFlow's
view of it). The commands below curl them; from a checkout, run them from `demo/` instead.

## 1. Start the stack

```bash
curl -O https://raw.githubusercontent.com/glassflow/navflow/main/demo/docker-compose.yml
docker compose up -d              # api-server + prometheus + traffic
```

Give it ~10s, then check it's alive:

```bash
curl -s localhost:8080/api/stats            # {"ok": true, ...}
curl -s 'localhost:9090/api/v1/query?query=up'   # prometheus is scraping
```

## 2. Install and run NavFlow

Install NavFlow the normal way (not in Docker) and point it at the demo catalog — from any
directory:

```bash
uv tool install navflow          # or: pipx install navflow  (or from source: uv pip install -e .)

# seed the demo sources/views/triggers and start the daemon + console
curl -O https://raw.githubusercontent.com/glassflow/navflow/main/demo/catalog.demo.yaml
NAVFLOW_CATALOG=catalog.demo.yaml navflow up
```

The console opens at http://127.0.0.1:8787. (`navflow up` imports the catalog while the catalog is
still empty; been running NavFlow already? Restart on a fresh `--data-dir`.)

## 3. Look around

- **Explore** — pick the `api-server` entity and watch metrics, logs, and alerts merge into one
  time-ordered timeline. Flip **Agent view** to see the exact read an agent gets over MCP.
- **Views / Triggers** — `service_timeline` is the saved read; `error_spike` and `slow_responses`
  are watching it.

## 4. Cause an incident

Flip a fault (`./inject.sh <scenario>` from a checkout is the same call):

```bash
curl -s -XPOST localhost:8080/demo/inject -H 'content-type: application/json' \
  -d '{"scenario": "error_spike"}'
```

- `error_spike` — 5xx storm → the `error_spike` trigger fires
- `latency` — p99 > 1s → the `slow_responses` trigger fires
- `dependency_outage` — DB down → 503s + a `dependency_up=0` metric
- `clear` — roll back, faults cleared

Watch it land in **Explore** (the timeline turns red) and, once an agent is subscribed, in
**Agents → Trigger dispatches**.

## 5. Stop

```bash
docker compose down              # from the directory with docker-compose.yml
```

## Files
- `docker-compose.yml` — the whole stack, self-contained (Prometheus config inlined).
- `docker-compose.build.yml` — override to build `api-server` from source instead of pulling.
- `api-server/` — the monitored app (`app.py`): metrics, logs, and the `/demo/inject` fault switch.
  Published as `ghcr.io/glassflow/navflow-demo-api-server`.
- `catalog.demo.yaml` — NavFlow's view of the stack (sources, views, triggers).
- `inject.sh` — cause/clear an incident.

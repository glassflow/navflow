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

## 1. Start the stack

```bash
cd demo
docker compose up -d --build      # api-server + prometheus + traffic
```

Give it ~10s, then check it's alive:

```bash
curl -s localhost:8080/api/stats            # {"ok": true, ...}
curl -s 'localhost:9090/api/v1/query?query=up'   # prometheus is scraping
```

## 2. Install and run NavFlow

Install NavFlow the normal way (not in Docker) and point it at the demo catalog. From the **repo
root**:

```bash
uv tool install navflow          # or: pipx install navflow  (or from source: uv pip install -e .)

# seed the demo sources/views/triggers and start the daemon + console
NAVFLOW_CATALOG=demo/catalog.demo.yaml navflow up
```

The console opens at http://127.0.0.1:8787. (`navflow up` reads the catalog on first boot; the
`docker_logs` source uses `compose_file: demo/docker-compose.yml`, so run from the repo root.)

## 3. Look around

- **Explore** — pick the `api-server` entity and watch metrics, logs, and alerts merge into one
  time-ordered timeline. Flip **Agent view** to see the exact read an agent gets over MCP.
- **Views / Triggers** — `service_timeline` is the saved read; `error_spike` and `slow_responses`
  are watching it.

## 4. Cause an incident

Flip a fault:

```bash
./inject.sh error_spike          # 5xx storm  → the error_spike trigger fires
./inject.sh latency              # p99 > 1s   → the slow_responses trigger fires
./inject.sh dependency_outage    # DB down    → 503s + a dependency_up=0 metric
./inject.sh clear                # roll back
```

Watch it land in **Explore** (the timeline turns red) and, once an agent is subscribed, in
**Agents → Trigger dispatches**.

## 5. Stop

```bash
docker compose down              # from demo/
```

## Files
- `docker-compose.yml` — the three services.
- `api-server/` — the monitored app (`app.py`): metrics, logs, and the `/demo/inject` fault switch.
- `prometheus/prometheus.yml` — scrape config.
- `catalog.demo.yaml` — NavFlow's view of the stack (sources, views, triggers).
- `inject.sh` — cause/clear an incident.

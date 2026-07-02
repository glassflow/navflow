"""NavFlow demo — a small 'api-server' to ingest from.

It exposes what NavFlow's connectors expect from the cookbook platform: Prometheus metrics
(`/metrics`), request logs (uvicorn access logs → docker logs), and an admin API — a deploy
changelog (`/admin/changelog`) and a config snapshot (`/admin/config`). `/admin/inject` flips a
fault so you can cause an incident and watch NavFlow correlate it across all four sources.

This service is the *thing being monitored*. NavFlow itself is installed separately (uv) and reads
from here — see demo/README.md.
"""
import random
import threading
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

SERVICE = "api-server"

REQS = Counter("http_requests_total", "HTTP requests", ["service", "endpoint", "method", "status"])
LAT = Histogram("http_request_duration_milliseconds", "Request duration (ms)",
                ["service", "endpoint"],
                buckets=[5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000])
DB_POOL = Gauge("db_pool_size", "Configured DB pool size")
DB_ACTIVE = Gauge("db_connections_active", "Active DB connections")
DB_MAX = Gauge("db_connections_max", "Max DB connections")
DEP_UP = Gauge("dependency_up", "Dependency up (1) / down (0)", ["dependency"])
ERR_RATE = Gauge("error_injection_rate", "Injected error rate 0..1")
INJ_LAT = Gauge("injected_latency_ms", "Injected latency (ms)")

state = {"error_rate": 0.0, "latency_ms": 0.0, "dependency_up": 1, "pool_size": 20}
changelog = [{"ts": time.time(), "commit": "a1b2c3d", "author": "deploy-bot",
              "message": "v1.4.0 — initial deploy", "lever": None}]
lock = threading.Lock()

DB_POOL.set(state["pool_size"])
DB_MAX.set(state["pool_size"])
DEP_UP.labels("postgres").set(1)
ERR_RATE.set(0)
INJ_LAT.set(0)

app = FastAPI(title="navflow-demo api-server")


def _handle(endpoint: str) -> JSONResponse:
    start = time.perf_counter()
    with lock:
        err_rate, lat_ms, dep_up = state["error_rate"], state["latency_ms"], state["dependency_up"]
    if lat_ms:
        time.sleep(lat_ms / 1000.0)
    if not dep_up:
        status = 503
    elif random.random() < err_rate:
        status = 500
    else:
        status = 200
    elapsed_ms = (time.perf_counter() - start) * 1000.0
    REQS.labels(SERVICE, endpoint, "GET", str(status)).inc()
    LAT.labels(SERVICE, endpoint).observe(elapsed_ms)
    return JSONResponse({"ok": status == 200, "endpoint": endpoint}, status_code=status)


@app.get("/api/orders")
def orders():
    return _handle("/api/orders")


@app.get("/api/stats")
def stats():
    return _handle("/api/stats")


@app.get("/api/users")
def users():
    return _handle("/api/users")


@app.get("/metrics")
def metrics():
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/admin/config")
def config():
    with lock:
        return {"version": changelog[-1]["message"].split(" ")[0],
                "db_pool_size": state["pool_size"], "dependency": "postgres",
                "error_rate": state["error_rate"], "injected_latency_ms": state["latency_ms"]}


@app.get("/admin/changelog")
def get_changelog():
    with lock:
        return {"changes": list(changelog)}


# Each fault ships as a "deploy" (a changelog entry), so NavFlow can correlate the incident back to
# the change that caused it — exactly the cookbook's four incident shapes.
SCENARIOS = {
    "error_spike": {"error_rate": 0.4, "msg": "v1.5.0 — new checkout path (5xx regression)"},
    "latency": {"latency_ms": 1500, "msg": "v1.5.1 — added a synchronous call in the hot path"},
    "dependency_outage": {"dependency_up": 0, "msg": "v1.5.2 — switched the DB endpoint"},
    "clear": {"error_rate": 0.0, "latency_ms": 0.0, "dependency_up": 1, "msg": "rollback — faults cleared"},
}


@app.post("/admin/inject")
async def inject(req: Request):
    raw = await req.body()
    scenario = ((await req.json()) if raw else {}).get("scenario", "clear")
    s = SCENARIOS.get(scenario)
    if not s:
        return JSONResponse({"error": f"unknown scenario {scenario!r}", "options": list(SCENARIOS)}, 400)
    with lock:
        for k in ("error_rate", "latency_ms", "dependency_up"):
            if k in s:
                state[k] = s[k]
        changelog.append({"ts": time.time(), "commit": "%06x" % random.randrange(16 ** 6),
                          "author": "deploy-bot", "message": s["msg"], "lever": scenario})
    ERR_RATE.set(state["error_rate"])
    INJ_LAT.set(state["latency_ms"])
    DEP_UP.labels("postgres").set(state["dependency_up"])
    return {"applied": scenario, "state": dict(state)}


def _db_walk():
    """Keep db_connections_active moving; hold more connections when the service is slow."""
    while True:
        with lock:
            base = 2 + (10 if state["latency_ms"] else 0)
        DB_ACTIVE.set(min(state["pool_size"], base + random.randint(0, 3)))
        time.sleep(2)


threading.Thread(target=_db_walk, daemon=True).start()

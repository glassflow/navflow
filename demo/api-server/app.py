"""NavFlow demo — a small 'api-server' to ingest from.

It exposes what NavFlow's connectors ingest from the cookbook platform: Prometheus metrics
(`/metrics`) and request logs (uvicorn access logs → docker logs). `/demo/inject` flips a
fault so you can cause an incident and watch NavFlow correlate it across the sources.

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


# Fault levers for the demo — flip app state + the Prometheus gauges so you can cause an incident
# and watch NavFlow correlate it across metrics and logs (the cookbook's incident shapes).
SCENARIOS = {
    "error_spike": {"error_rate": 0.4},
    "latency": {"latency_ms": 1500},
    "dependency_outage": {"dependency_up": 0},
    "clear": {"error_rate": 0.0, "latency_ms": 0.0, "dependency_up": 1},
}


@app.post("/demo/inject")
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

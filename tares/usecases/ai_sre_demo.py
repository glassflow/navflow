"""The AI SRE demo as a use case: the same six objects `demo/catalog.demo.yaml` seeds (three
sources keyed by `service`, the `service_timeline` view, the `incident` trigger, the
`incident-first-look` agent), created with one click in the console instead of importing the
catalog. Same names on purpose, so the docs guide (docs.glassflow.ai/tares/guides/ai-sre) reads
the same whichever way you set it up; an unowned object of the same name is adopted, never
duplicated.

The demo stack itself (api-server, Prometheus, traffic) is Docker on the user's machine and stays
outside Tares: SETUP shows the two commands, and the `inject` action calls the api-server's fault
switch so an incident can be caused and cleared from the use case page.
"""
from __future__ import annotations

import httpx

from .base import PlannedObject, Recipe, UsecaseError
from .registry import register

SCENARIOS = ("error_spike", "latency", "dependency_outage", "clear")

PROMPT = """You are an SRE taking the first look when Prometheus fires an alert on api-server. You are \
handed the correlated timeline: the firing alert (HighErrorRate / HighLatency / DependencyDown) \
plus the signals behind it (5xx request rate, p99 latency, active DB connections, dependency \
health) and the service's request logs. That is your evidence.

Produce a tight incident note: (1) what is failing and since when, (2) the most likely cause, \
tied to the specific evidence lines (which signal crossed, what the logs show), (3) a suggested \
next action. If the timeline is too narrow, read a wider window (1h) once before concluding. Do \
not speculate beyond the evidence; if it is inconclusive, say what you would look at next. Plain \
sentences, no em dashes.
"""


class AiSreDemo(Recipe):
    key = "ai_sre_demo"
    title = "AI SRE demo"
    description = ("Watch a small demo system, correlate its metrics, logs and alerts on one timeline, "
                   "and let an agent write the first incident note when Prometheus fires.")
    tags = ("demo",)
    guide = {"label": "Build an AI SRE guide", "url": "https://docs.glassflow.ai/tares/guides/ai-sre"}

    PARAMS = {
        "prometheus_url": {"type": "string", "default": "http://localhost:9090", "label": "Prometheus URL",
                           "help": "the demo stack's Prometheus, as reachable from this Tares"},
        "api_server_url": {"type": "string", "default": "http://localhost:8080", "label": "api-server URL",
                           "help": "the demo api-server; used by the Cause an incident action"},
        "container": {"type": "string", "default": "tares-demo-api-server", "label": "Log container",
                      "help": "the api-server's Docker container name (fixed in docker-compose.yml)"},
        "model": {"type": "string", "default": "", "label": "Model",
                  "help": "model for the agent (empty = the instance default)"},
    }

    SETUP = [
        {"title": "Start the demo stack", "check": "detect",
         "text": "Docker Desktop running. Two files, no checkout needed. The form below fills itself "
                 "from what is running.",
         "command": "curl -O https://raw.githubusercontent.com/glassflow/tares/main/demo/docker-compose.yml\n"
                    "docker compose up -d"},
        {"title": "Check it is alive",
         "command": "curl -s localhost:8080/api/stats\ncurl -s 'localhost:9090/api/v1/query?query=up'"},
        {"title": "Give the agent a key", "check": "anthropic_key",
         "text": "The incident-first-look agent is a real agent: it needs an Anthropic key. Set one here "
                 "or under Settings > Anthropic (or ANTHROPIC_API_KEY before tares up). Without one its "
                 "runs log \"no key\"."},
    ]

    ACTIONS = [
        {"name": "inject", "label": "Cause an incident",
         "help": "flips the api-server's fault switch; HighErrorRate, HighLatency or DependencyDown "
                 "fires within about 30 seconds and the agent wakes",
         "params": {"scenario": {"label": "scenario",
                                 "options": ["error_spike", "latency", "dependency_outage"]}}},
        {"name": "clear", "label": "Clear the fault",
         "help": "rolls the fault back; the alert resolves and a resolved event lands on the timeline"},
    ]

    # ── params ───────────────────────────────────────────────────────────────
    def validate(self, params: dict) -> dict:
        p = super().validate(params)
        for k in ("prometheus_url", "api_server_url"):
            v = str(p.get(k) or self.PARAMS[k]["default"]).strip().rstrip("/")
            if not v.startswith(("http://", "https://")):
                raise UsecaseError(f"{k} must start with http:// or https://")
            p[k] = v
        p["container"] = str(p.get("container") or self.PARAMS["container"]["default"]).strip()
        p["model"] = str(p.get("model") or "").strip()
        return p

    # ── plan: the demo catalog, verbatim ─────────────────────────────────────
    def plan(self, params: dict) -> list[PlannedObject]:
        prom = params["prometheus_url"]
        objs = [
            PlannedObject("source", "metrics", {
                "name": "demo_metrics", "connector": "prometheus", "poll": "5s",
                "config": {
                    "url": prom,
                    "queries": [
                        {"promql": 'sum(rate(http_requests_total{status=~"5.."}[1m])) by (service)',
                         "event_type": "5xx_rate", "text": "5xx rate {service}={val}/s"},
                        {"promql": 'histogram_quantile(0.99, sum(rate(http_request_duration_milliseconds_bucket[2m])) by (le, service))',
                         "event_type": "p99", "text": "p99 {service}={val}ms"},
                        {"promql": "db_connections_active", "event_type": "db_active",
                         "text": "db connections active={val}"},
                        {"promql": "dependency_up", "event_type": "dependency",
                         "text": "dependency {dependency} up={val}"},
                    ],
                    "labels": [{"name": "service", "const": "api-server", "primary": True},
                               {"name": "value", "field": "value", "type": "number"}],
                }}),
            PlannedObject("source", "logs", {
                "name": "demo_logs", "connector": "docker_logs", "poll": "5s",
                "config": {"container": params["container"],
                           "labels": [{"name": "service", "const": "api-server", "primary": True}]}}),
            PlannedObject("source", "alerts", {
                "name": "demo_alerts", "connector": "prometheus_alerts", "poll": "10s",
                "config": {"url": prom,
                           "labels": [{"name": "service", "field": "labels.service", "primary": True},
                                      {"name": "alertname", "field": "labels.alertname"},
                                      {"name": "severity", "field": "labels.severity"},
                                      {"name": "state", "field": "state"},
                                      {"name": "alert_active", "const": 1, "type": "number"}]}}),
            PlannedObject("view", "view", {
                "name": "service_timeline", "key_field": "service",
                "sources": ["demo_logs", "demo_metrics", "demo_alerts"]}),
            PlannedObject("trigger", "trigger", {
                "name": "incident", "view": "service_timeline",
                "condition": {"aggregate": "sum", "field": "alert_active", "predicate": "> 0",
                              "window": "1m", "group_by": ["key_value"]},
                "emit": {"kind": "incident", "attach_view": True, "context_window": "15m"},
                "cooldown": "5m"}),
        ]
        agent = {"name": "incident-first-look", "trigger": "incident", "enabled": True, "prompt": PROMPT}
        if params.get("model"):
            agent["model"] = params["model"]
        objs.append(PlannedObject("agent", "agent", agent))
        return objs

    # ── detect: ask Docker what is running instead of assuming ports ─────────
    async def detect(self, store, runtime) -> dict:
        from ..discovery import _docker_ps, _published_port
        out = {"params": {}, "found": {}, "missing": {}, "notes": []}
        try:
            containers = await _docker_ps()
        except ValueError as e:
            out["notes"].append(str(e))
            for k in ("prometheus_url", "api_server_url", "container"):
                out["missing"][k] = "Docker not reachable; using the default"
            return out
        api = next((c for c in containers if "tares-demo-api-server" in c["image"]
                    or c["name"] == "tares-demo-api-server"), None)
        prom = next((c for c in containers if "prom/prometheus" in c["image"]
                     or _published_port(c["ports"], 9090)), None)
        if api:
            port = _published_port(api["ports"], 8080)
            if port:
                out["params"]["api_server_url"] = f"http://localhost:{port}"
                out["found"]["api_server_url"] = f"container {api['name']} publishes port {port}"
            else:
                out["missing"]["api_server_url"] = f"container {api['name']} runs but publishes no port 8080"
            out["params"]["container"] = api["name"]
            out["found"]["container"] = f"container {api['name']} (image {api['image'].split('/')[-1]})"
        else:
            out["missing"]["api_server_url"] = "no demo api-server container is running; start the demo stack"
            out["missing"]["container"] = "no demo api-server container is running"
        if prom:
            port = _published_port(prom["ports"], 9090) or 9090
            out["params"]["prometheus_url"] = f"http://localhost:{port}"
            out["found"]["prometheus_url"] = f"container {prom['name']} publishes port {port}"
        else:
            out["missing"]["prometheus_url"] = "no Prometheus container is running; start the demo stack"
        if not containers:
            out["notes"].append("Docker is running but no compose-managed containers were found")
        return out

    # ── actions ──────────────────────────────────────────────────────────────
    def run_action(self, instance: dict, action: str, args: dict, store, runtime) -> dict:
        params = self.validate(instance["params"])
        if action == "inject":
            scenario = str(args.get("scenario") or "error_spike")
            if scenario not in SCENARIOS or scenario == "clear":
                raise UsecaseError(f"scenario must be one of {[s for s in SCENARIOS if s != 'clear']}")
        elif action == "clear":
            scenario = "clear"
        else:
            raise UsecaseError(f"{self.key}: no action {action!r}")
        url = params["api_server_url"] + "/demo/inject"
        try:
            r = httpx.post(url, json={"scenario": scenario}, timeout=10)
        except Exception as e:
            raise UsecaseError(f"could not reach the demo api-server at {url}: {e}") from e
        if r.status_code >= 300:
            raise UsecaseError(f"api-server answered {r.status_code} for {scenario}")
        msg = ("fault cleared; the alert resolves within about a minute" if scenario == "clear"
               else f"{scenario} injected; in about 30 seconds the alert fires, the trigger wakes the "
                    f"agent, and its run appears under Runs below")
        return {"scenario": scenario, "message": msg}

    # ── summary ──────────────────────────────────────────────────────────────
    def summary(self, instance: dict, store) -> dict:
        params = self.validate(instance["params"])
        all_stats = {x["source"]: x for x in store.event_stats()}
        stats = {}
        for name in ("demo_metrics", "demo_logs", "demo_alerts"):
            st = all_stats.get(name) or {}
            stats[name] = {"events": int(st.get("events") or 0), "last": _iso(st.get("last_ingest"))}
        runs = []
        try:
            for r in store.list_agent_runs("incident-first-look", limit=10):
                runs.append({"id": r.get("id"), "started_at": _iso(r.get("started_at")),
                             "key": r.get("key"), "repo": r.get("key"), "agent": "incident-first-look",
                             "status": r.get("status"), "rounds": r.get("rounds"),
                             "max_rounds": r.get("max_rounds"), "finding": r.get("finding"),
                             "error": r.get("error")})
        except Exception:
            pass
        last_fired = _iso(store.last_fired("incident", "api-server"))
        return {"prometheus_url": params["prometheus_url"], "api_server_url": params["api_server_url"],
                "container": params["container"], "sources": stats, "runs": runs,
                "runs_total": len(runs), "last_fired": last_fired,
                "guide": "https://docs.glassflow.ai/tares/guides/ai-sre"}


def _iso(v):
    if v is None:
        return None
    return v.isoformat() if hasattr(v, "isoformat") else str(v)


register(AiSreDemo())

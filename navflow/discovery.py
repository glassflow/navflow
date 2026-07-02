"""Environment discovery — scan a whole environment and propose a catalog of sources, spanning
connector types. The Docker scan enumerates compose containers and proposes a `docker_logs`
source per service plus a `prometheus` source if it detects one running (delegating to that
connector's own discover for the detail).

Deterministic, no LLM. Local Docker only (navflowd shells out to the `docker` CLI on its host).
"""
from __future__ import annotations

import asyncio
import re

from .connectors import normalize_config
from .connectors.prometheus import PrometheusConnector

# images we don't pre-select for log ingestion (infra/noise, not the user's app)
_INFRA = re.compile(r"prom/prometheus|grafana|postgres|mysql|mariadb|redis|mongo|rabbitmq|"
                    r"elasticsearch|zookeeper|kafka|buildkit|traefik|nginx", re.I)

_PS_FMT = ('{{.Names}}\t{{.Image}}\t{{.Ports}}\t'
           '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}')


def _published_port(ports: str, target: int) -> int | None:
    """Host port a container's `target` port is published on, e.g. '0.0.0.0:9091->9090/tcp'."""
    m = re.search(rf"(?::|^)(\d+)->{target}/", ports)
    return int(m.group(1)) if m else None


async def _docker_ps() -> list[dict]:
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker", "ps", "--no-trunc", "--format", _PS_FMT,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, err = await asyncio.wait_for(proc.communicate(), timeout=15)
    except FileNotFoundError:
        raise ValueError("the `docker` CLI was not found on navflowd's host")
    except Exception as e:
        raise ValueError(f"could not run `docker ps`: {e}")
    if proc.returncode != 0:
        raise ValueError(f"`docker ps` failed — is the Docker daemon running? "
                         f"({err.decode(errors='replace').strip()})")
    containers = []
    for line in out.decode(errors="replace").strip().splitlines():
        parts = line.split("\t")
        if len(parts) != 5:
            continue
        name, image, ports, project, service = parts
        if not project or not service:      # only compose-managed containers
            continue
        containers.append({"name": name, "image": image, "ports": ports,
                           "project": project, "service": service})
    return containers


async def scan_docker() -> dict:
    containers = await _docker_ps()
    proposed, skipped = [], []

    for c in containers:
        app = not _INFRA.search(c["image"])
        proposed.append({
            "connector": "docker_logs",
            "name": f"{c['service']}_logs",
            "config": normalize_config("docker_logs", {
                "container": c["name"],
                "labels": [{"name": "service", "const": c["service"], "primary": True},
                           {"name": "project", "const": c["project"]}]}),
            "summary": f"{c['service']} container logs · key=service",
            "preselect": app,
            "from": f"container {c['name']}",
        })

    # metrics: detect a Prometheus container and delegate to its own discover
    prom = next((c for c in containers
                 if "prom/prometheus" in c["image"] or _published_port(c["ports"], 9090)), None)
    if prom:
        port = _published_port(prom["ports"], 9090) or 9090
        url = f"http://localhost:{port}"
        try:
            p = await PrometheusConnector.discover({"url": url})
            cfg = normalize_config("prometheus", p["proposed_config"])
            k = p["suggested_key"]
            summary = (f"{p['summary']['relevant']} metrics · key={k['name']} "
                       f"({k['cardinality']} entities) · derived "
                       f"{', '.join(d['label'] for d in p['derived_suggestions'])}")
        except ValueError:
            cfg = normalize_config("prometheus", {"url": url, "default_key": "api-server",
                                                  "queries": [{"promql": "up"}]})
            summary = f"detected at {url} but couldn't introspect — confirm it's reachable"
        proposed.append({
            "connector": "prometheus", "name": "metrics", "config": cfg,
            "summary": summary, "preselect": True, "from": f"container {prom['name']}"})

    for c in containers:
        if "postgres" in c["image"].lower():
            skipped.append({"service": c["service"], "image": c["image"],
                            "reason": "a Postgres CDC connector would go here (not built yet)"})
        elif "grafana" in c["image"].lower():
            skipped.append({"service": c["service"], "image": c["image"],
                            "reason": "a dashboard — nothing to ingest"})

    return {"provider": "docker",
            "summary": {"containers": len(containers), "proposed": len(proposed)},
            "containers": containers, "proposed_sources": proposed, "skipped": skipped}

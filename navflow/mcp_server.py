"""navflow-mcp — the stdio MCP server the agent spawns. A thin proxy to navflowd's HTTP API.

Stateless: every tool call becomes one HTTP call to navflowd. This is the only NavFlow surface the
agent sees.

Two tool groups: the READ surface (query/catalog/list_*) and the WRITE/SETUP surface
(subscribe/derive/remember/discover_*/create_source/…), which lets an agent author views and wire
up its own data sources. The design doc keeps admin ops off the MCP surface; exposing them here is a
deliberate MVP test of agent-operable onboarding (no auth — the proxy talks to the local daemon).
"""
from __future__ import annotations

import contextvars
import json
import os

import httpx
from mcp.server.mcpserver import MCPServer

NAVFLOWD = os.getenv("NAVFLOWD_URL", "http://127.0.0.1:8787")
# Bearer credentials. Over HTTP transports each caller presents its own token (the root auth token
# or a scoped API key) and we forward it per-request — the daemon enforces scopes per route. Over
# stdio (a local agent spawned the proxy) there is no inbound token; the env token is used.
AUTH_TOKEN = os.getenv("NAVFLOW_AUTH_TOKEN", "").strip()
_CALLER_TOKEN = contextvars.ContextVar("navflow_caller_token", default="")


def _cx(timeout: float = 10):
    """An httpx client that carries the caller's token to navflowd (env token as stdio fallback)."""
    tok = _CALLER_TOKEN.get() or AUTH_TOKEN
    return httpx.AsyncClient(timeout=timeout,
                             headers={"Authorization": f"Bearer {tok}"} if tok else {})

# stdio (default) is what a local agent spawns. For remote agents (the demo / a server), run with
# NAVFLOW_MCP_TRANSPORT=streamable-http (or sse) and the server listens on MCP_HOST:MCP_PORT — at
# /mcp (streamable-http) or /sse (sse), proxying tool calls to navflowd as usual.
# mcp 2.0 moved host/port off the constructor, and Settings no longer carries
# them, so they are read here and used directly where the server is started.
MCP_HOST = os.getenv("NAVFLOW_MCP_HOST", "127.0.0.1")
MCP_PORT = int(os.getenv("NAVFLOW_MCP_PORT", "8788"))

mcp = MCPServer("navflow")


def writable():
    """Decorator for a write/setup tool. (Kept as a distinct marker from a plain read tool; there is
    no longer a read-only mode, so it registers normally — the daemon enforces scopes per route.)"""
    return mcp.tool()


@mcp.tool()
async def query(view: str, key: str = "", window: str = "15m",
                where: dict | None = None, include_payload: bool = False) -> str:
    """Pull one correlated, time-ordered view of everything that happened to an entity over a
    window (metrics, logs, config, deploys, alerts) — already merged. Prefer this over many small
    reads. Select the entity with `key` (the primary key) OR `where`, a {label: value} map on any
    named label, e.g. {"env": "prod"} or {"env": "prod", "app": "ui"}. Use catalog_describe to
    see a source's labels. Set `include_payload` when you need each event's full lossless record
    (not just the one-line summary) — the return becomes JSON {timeline, events[]} where each event
    carries a `raw` field."""
    body = {"view": view, "window": window, "client": "mcp", "include_payload": include_payload}
    if where:
        body["where"] = where
    if key:
        body["key"] = key
    async with _cx(30) as cx:
        r = await cx.post(f"{NAVFLOWD}/query", json=body)
    data = r.json()
    if include_payload:
        return json.dumps({"timeline": data["payload"], "events": data["rows"]}, default=str)
    return data["payload"]


@mcp.tool()
async def read(selector: dict, window: str = "15m", include_payload: bool = False) -> str:
    """Read one correlated, time-ordered timeline of everything matching `selector` across ALL
    sources — no view needed. `selector` is a {label: value} conjunction, matched with strict AND,
    e.g. {"project": "frontend"} or {"service": "api-server", "endpoint": "/login"}. An event
    matches only if it carries every named label with that value, so adding a label narrows and
    removing one widens. Use this to investigate any entity on the fly; once you know which sources
    matter, save the slice with derive() to create a reusable view you can attach triggers to. Set
    `include_payload` when the one-line summaries aren't enough and you need each event's full
    lossless record — the return becomes JSON {timeline, events[]} where each event carries `raw`."""
    async with _cx(30) as cx:
        r = await cx.post(f"{NAVFLOWD}/read",
                          json={"selector": selector, "window": window, "client": "mcp",
                                "include_payload": include_payload})
    data = r.json()
    if include_payload:
        return json.dumps({"timeline": data["payload"], "events": data["rows"]}, default=str)
    return data["payload"]


@writable()
async def create_trigger(name: str, view: str, condition: dict,
                         emit: dict | None = None, cooldown: str = "5m") -> str:
    """Create a trigger — a condition NavFlow evaluates continuously over a view; when it trips,
    subscribed agents are woken with the correlated timeline. `condition` is
    {aggregate: any|avg|count|max|min|sum, field: numeric field to aggregate (omit for count),
    predicate: e.g. '> 1.0' / '>= 5' / '== 0', window: detection window e.g. '1m'}. `emit` is
    {kind: what a firing is called e.g. error_spike, context_window: timeline the woken agent
    receives e.g. '15m'}. The view must exist (catalog_describe it to confirm the numeric field).
    Wire agents to it with subscribe()."""
    body = {"name": name, "view": view, "condition": condition,
            "emit": emit or {}, "cooldown": cooldown}
    async with _cx(10) as cx:
        r = await cx.post(f"{NAVFLOWD}/api/triggers", json=body)
    return r.text


@writable()
async def update_trigger(name: str, view: str, condition: dict,
                         emit: dict | None = None, cooldown: str = "5m") -> str:
    """Edit an EXISTING trigger in place: replace its view, condition, emit, and cooldown. Create
    new triggers with create_trigger() — this only updates one that already exists (renaming isn't
    supported, so keep `name` the same). See create_trigger for the condition/emit shape."""
    body = {"name": name, "view": view, "condition": condition,
            "emit": emit or {}, "cooldown": cooldown}
    async with _cx(10) as cx:
        r = await cx.put(f"{NAVFLOWD}/api/triggers/{name}", json=body)
    return r.text


@writable()
async def subscribe(trigger: str, url: str) -> str:
    """Register a webhook to be woken (pushed) when a trigger fires. Returns a subscription id."""
    async with _cx(10) as cx:
        r = await cx.post(f"{NAVFLOWD}/subscribe", json={"trigger": trigger, "url": url})
    return r.json()["subscription_id"]


@mcp.tool()
async def catalog_list() -> str:
    """List available sources, views, and triggers."""
    async with _cx(10) as cx:
        r = await cx.get(f"{NAVFLOWD}/catalog")
    return r.text


@mcp.tool()
async def catalog_describe(handle: str) -> str:
    """Describe one catalog entry in full: schema (event types + typed fields, inferred from
    stored events), freshness, lineage, and sample records. Handles look like source:logs,
    view:service_timeline, trigger:error_spike. Use this to discover field names before
    writing a derive() or querying an unfamiliar view."""
    async with _cx(10) as cx:
        r = await cx.get(f"{NAVFLOWD}/catalog/{handle}")
    return r.text


@writable()
async def derive(sources: list[str], key_field: str, name: str = "",
                 filters: list[dict] | None = None) -> str:
    """Propose a new view shaped the way YOU want to read: pick the sources to correlate, what
    the key means, and optional filters [{field, op, value}] (ops: eq, neq, contains, gt, lt,
    gte, lte) to narrow it. Returns a handle immediately queryable with query(). Use
    catalog_describe first to learn the available fields."""
    body = {"sources": sources, "key_field": key_field, "filters": filters or [],
            "client": "mcp"}
    if name:
        body["name"] = name
    async with _cx(10) as cx:
        r = await cx.post(f"{NAVFLOWD}/derive", json=body)
    return r.text


@writable()
async def update_view(name: str, sources: list[str], key_field: str = "",
                      filters: list[dict] | None = None) -> str:
    """Edit an EXISTING view in place: replace its sources, key_field, and filters. Create new
    views with derive() — this only updates one that already exists (renaming isn't supported, so
    keep `name` the same). filters are [{field, op, value}] (ops: eq, neq, contains, gt, lt, gte,
    lte). Use catalog_describe first to learn the available fields."""
    body = {"name": name, "key_field": key_field, "sources": sources, "filters": filters or []}
    async with _cx(10) as cx:
        r = await cx.put(f"{NAVFLOWD}/api/views/{name}", json=body)
    return r.text


@writable()
async def remember(key: str, content: str, memory_type: str = "observation") -> str:
    """Write an observation back to NavFlow's agent-memory lane. It becomes a source like any
    other: joined into correlated reads, so what you learned this incident appears in the
    timeline next time the same key acts up. memory_type: observation | aggregation | decision."""
    async with _cx(10) as cx:
        r = await cx.post(f"{NAVFLOWD}/remember",
                          json={"key": key, "content": content, "memory_type": memory_type})
    return r.text


# ── setup surface: an agent can wire up its own data sources ─────────────────

@mcp.tool()
async def list_connectors() -> str:
    """List the connector types you can create a source with, each with its config fields, mode
    (poll | push), and whether it supports discovery. Read this first to learn what you can ingest
    and how to configure it."""
    async with _cx(10) as cx:
        r = await cx.get(f"{NAVFLOWD}/api/connectors")
    return r.text


@writable()
async def discover_source(connector: str, config: dict) -> str:
    """Introspect an upstream and get a proposed source config — no commitment. Works for
    connectors that can introspect: e.g. prometheus given {"url": "http://..."}, or github given
    {"repo": "owner/name"}. The returned `proposed_config` can be passed straight to create_source.
    (Use list_connectors to see which connectors support discovery.)"""
    async with _cx(20) as cx:
        r = await cx.post(f"{NAVFLOWD}/api/sources/discover",
                          json={"connector": connector, "config": config})
    return r.text


@writable()
async def discover_docker() -> str:
    """Scan the local Docker environment and get a list of proposed sources (one per container's
    logs, plus a detected Prometheus). Each item's `config` is ready to pass to create_source."""
    async with _cx(20) as cx:
        r = await cx.get(f"{NAVFLOWD}/api/discover/environment", params={"provider": "docker"})
    return r.text


@writable()
async def test_source(name: str, connector: str, config: dict, poll: str = "5s") -> str:
    """Dry-run a source config without creating it: poll connectors do one live poll and return a
    sample; push connectors return their ingest endpoint. Use before create_source to check the
    config works."""
    async with _cx(20) as cx:
        r = await cx.post(f"{NAVFLOWD}/api/sources/test",
                          json={"name": name, "connector": connector, "poll": poll, "config": config})
    return r.text


@writable()
async def create_source(name: str, connector: str, config: dict, poll: str = "5s") -> str:
    """Create a data source so NavFlow starts ingesting it immediately (no restart). `config` is
    the connector's config (see list_connectors / discover_source); push connectors ignore `poll`.
    Returns {ok, name} or an error detail. After creating, use list_sources to watch it ingest and
    catalog_describe("source:<name>") to see its labels."""
    async with _cx(15) as cx:
        r = await cx.post(f"{NAVFLOWD}/api/sources",
                          json={"name": name, "connector": connector, "poll": poll, "config": config})
    return r.text


@mcp.tool()
async def list_sources() -> str:
    """List every configured source with its live health (status, events ingested, last error).
    Use it to confirm a source you created is actually ingesting."""
    async with _cx(10) as cx:
        r = await cx.get(f"{NAVFLOWD}/api/sources")
    return r.text


@mcp.tool()
async def source_fields(name: str, limit: int = 500) -> str:
    """Profile a source's real fields from recent events: every candidate field with its coverage,
    distinct count, and top values, plus which are already declared as labels/keys. Call this BEFORE
    choosing labels for a source — a label's `field` MUST be one of these exact field names (never
    invent one). The `labels` block echoes the source's current declared axes."""
    async with _cx(15) as cx:
        r = await cx.get(f"{NAVFLOWD}/api/sources/{name}/fields", params={"limit": limit})
    return r.text


class _BearerGate:
    """Pure-ASGI middleware: every HTTP request to the MCP server must carry *a* bearer token —
    the root auth token or a scoped API key. The token is forwarded to navflowd per-request, which
    validates it and enforces scopes per tool call (the proxy can't check key hashes itself).
    Non-HTTP scopes (lifespan/websocket) pass through untouched."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers") or []}
            auth = headers.get("authorization", "")
            tok = auth[7:].strip() if auth.lower().startswith("bearer ") else headers.get("x-navflow-token", "")
            if not tok:
                await send({"type": "http.response.start", "status": 401,
                            "headers": [(b"content-type", b"application/json")]})
                await send({"type": "http.response.body", "body": b'{"detail":"unauthorized"}'})
                return
            _CALLER_TOKEN.set(tok)
        await self.app(scope, receive, send)


def main():
    transport = os.getenv("NAVFLOW_MCP_TRANSPORT", "stdio")  # stdio | sse | streamable-http
    if transport == "stdio":
        mcp.run(transport="stdio")
        return
    # HTTP transports: build the ASGI app, gate it with the bearer token, run it under uvicorn.
    app = mcp.streamable_http_app() if transport == "streamable-http" else mcp.sse_app()
    if AUTH_TOKEN:
        app = _BearerGate(app)
    import uvicorn
    uvicorn.run(app, host=MCP_HOST, port=MCP_PORT)


if __name__ == "__main__":
    main()

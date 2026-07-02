"""The in-app agent — a server-side chat loop that gives Claude NavFlow's read API as tools, so a
user can ask about the data they're ingesting from the console (the in-app twin of the MCP agent).

The Anthropic key is supplied per-request (header) and used transiently — never stored. Tools are
thin self-calls to the daemon's own read endpoints, so the agent sees exactly what the API exposes.
"""
from __future__ import annotations

import json
import os

import httpx

DEFAULT_MODEL = os.getenv("NAVFLOW_AGENT_MODEL", "claude-sonnet-4-6")
_SELF = f"http://127.0.0.1:{os.getenv('NAVFLOW_PORT', '8787')}"
MAX_ROUNDS = 10

# Each tool maps to a read endpoint. (method, path-template, query-params, is-json-body).
TOOLS = [
    {"name": "list_sources",
     "description": "List every configured source with its connector, type and live health "
                    "(status, events ingested, last error). Start here to see what's flowing.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "list_connectors",
     "description": "List the connector types and their config/fields/mode.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "catalog",
     "description": "List all sources, views and triggers (handles) in the catalog.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "describe",
     "description": "Describe one catalog entry in full: schema (event types + inferred typed "
                    "fields), the entities it carries (label -> values, the key flagged), freshness, "
                    "sample events, and lineage. Handles look like source:<name>, view:<name>, "
                    "trigger:<name>. The richest way to understand a source's data.",
     "input_schema": {"type": "object", "properties": {
         "handle": {"type": "string", "description": "e.g. source:logs, view:timeline"}},
         "required": ["handle"]}},
    {"name": "source_fields",
     "description": "Profile a source's normalized fields from real data: each field's coverage "
                    "(how many sampled events carry it), distinct count, and top values. Use this to "
                    "judge whether a field is a good key, or to spot a sparse/empty one.",
     "input_schema": {"type": "object", "properties": {
         "name": {"type": "string"}}, "required": ["name"]}},
    {"name": "entities",
     "description": "The (label, value) entities across sources, faceted. Optionally pass a single "
                    "label to get its values with counts.",
     "input_schema": {"type": "object", "properties": {
         "label": {"type": "string", "description": "optional: one label axis"}}}},
    {"name": "recent_events",
     "description": "Recent events for a source (key, type, text, time) — the actual data.",
     "input_schema": {"type": "object", "properties": {
         "name": {"type": "string"}, "limit": {"type": "integer", "default": 20}},
         "required": ["name"]}},
    {"name": "query",
     "description": "Pull one correlated, time-ordered timeline for an entity from a view. Select "
                    "the entity by `key` or by `where` ({label: value}). Needs an existing view "
                    "(see catalog).",
     "input_schema": {"type": "object", "properties": {
         "view": {"type": "string"}, "key": {"type": "string"},
         "where": {"type": "object"}, "window": {"type": "string", "default": "15m"}},
         "required": ["view"]}},
    {"name": "create_view",
     "description": "Create a view that correlates one or more sources into a single time-ordered "
                    "timeline for an entity, so it can then be query()'d. Choose the sources to join, "
                    "a key_field (the label/field identifying the entity, ideally present across the "
                    "sources — check with describe/source_fields first), an optional name, and "
                    "optional filters [{field, op, value}] (ops: eq, neq, contains, gt, lt, gte, lte). "
                    "Confirm the intent with the user before creating. Returns the new view.",
     "input_schema": {"type": "object", "properties": {
         "sources": {"type": "array", "items": {"type": "string"}},
         "key_field": {"type": "string"},
         "name": {"type": "string"},
         "filters": {"type": "array", "items": {"type": "object"}}},
         "required": ["sources", "key_field"]}},
]


async def _execute_tool(name: str, args: dict, headers: dict) -> str:
    """Run a tool by calling the daemon's own read endpoint. Returns the response text (JSON)."""
    args = args or {}
    async with httpx.AsyncClient(timeout=30, headers=headers, base_url=_SELF) as cx:
        if name == "list_sources":
            r = await cx.get("/api/sources")
        elif name == "list_connectors":
            r = await cx.get("/api/connectors")
        elif name == "catalog":
            r = await cx.get("/catalog")
        elif name == "describe":
            r = await cx.get(f"/catalog/{args.get('handle', '')}")
        elif name == "source_fields":
            r = await cx.get(f"/api/sources/{args.get('name', '')}/fields")
        elif name == "entities":
            r = await cx.get("/api/entities", params={"label": args["label"]} if args.get("label") else None)
        elif name == "recent_events":
            r = await cx.get(f"/api/sources/{args.get('name', '')}/events",
                             params={"limit": int(args.get("limit", 20))})
        elif name == "query":
            body = {"view": args.get("view"), "window": args.get("window", "15m"), "client": "in-app-agent"}
            if args.get("key"):
                body["key"] = args["key"]
            if args.get("where"):
                body["where"] = args["where"]
            r = await cx.post("/query", json=body)
        elif name == "create_view":
            body = {"sources": args.get("sources") or [], "key_field": args.get("key_field"),
                    "filters": args.get("filters") or [], "client": "in-app-agent"}
            if args.get("name"):
                body["name"] = args["name"]
            r = await cx.post("/derive", json=body)
        else:
            return json.dumps({"error": f"unknown tool {name!r}"})
    text = r.text
    return text if len(text) <= 20000 else text[:20000] + "\n…(truncated)"


_SYSTEM_BASE = """You are NavFlow's in-app data assistant. NavFlow is a data plane for AI agents: \
connectors ingest events from sources (logs, metrics, deploys, Vercel/GitHub/Postgres/OTLP, …). \
Every event has a key, named labels (correlation axes; one is the primary key), typed fields, and a \
text line. Entities are label values. Views correlate sources for a key; triggers watch views.

You help the user with their OWN ingested data — both to UNDERSTAND it (what's ingesting, the shape \
and entities of each source, coverage) and to DEBUG problems (a source not ingesting, an empty or \
sparse entity, an unpopulated field, stale data). Adapt to whatever they ask.

Always inspect with the read tools — never guess at what's there. For a problem, form a hypothesis \
then verify it (health, field coverage, recent events, freshness). Be concrete: cite source names, \
field coverage, entity values, counts. Prefer `describe` and `source_fields` to understand a source. \
Keep answers tight and useful; use small tables or lists where they help. If a tool errors, say so.

You can also CREATE a view (create_view) to correlate sources into one timeline for an entity when \
the user wants that — pick a key_field that exists across the sources, and confirm before creating."""


def system_prompt(mode: str | None = None) -> str:
    return _SYSTEM_BASE   # one adaptive agent; `mode` is accepted but no longer changes the prompt


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj)}\n\n"


async def run_agent(api_key: str, messages: list, mode: str = "explore",
                    model: str | None = None, self_headers: dict | None = None):
    """Async generator of SSE lines: the agent loop, streaming assistant text and tool activity."""
    try:
        import anthropic
    except ImportError:
        yield _sse({"type": "error", "detail": "the agent needs the 'anthropic' package "
                                               "(pip install navflow[agent])"})
        return

    client = anthropic.AsyncAnthropic(api_key=api_key)
    convo = list(messages)
    headers = self_headers or {}
    try:
        for _ in range(MAX_ROUNDS):
            async with client.messages.stream(
                model=model or DEFAULT_MODEL, max_tokens=2048,
                system=system_prompt(mode), tools=TOOLS, messages=convo,
            ) as stream:
                async for event in stream:
                    if event.type == "content_block_delta" and event.delta.type == "text_delta":
                        yield _sse({"type": "text", "text": event.delta.text})
                final = await stream.get_final_message()

            convo.append({"role": "assistant", "content": final.content})
            tool_uses = [b for b in final.content if b.type == "tool_use"]
            if not tool_uses:
                break
            results = []
            for tu in tool_uses:
                yield _sse({"type": "tool", "name": tu.name, "input": tu.input})
                out = await _execute_tool(tu.name, tu.input, headers)
                results.append({"type": "tool_result", "tool_use_id": tu.id, "content": out})
            convo.append({"role": "user", "content": results})
        yield _sse({"type": "done"})
    except Exception as e:  # noqa: BLE001 — surface auth/rate/other errors to the chat
        yield _sse({"type": "error", "detail": f"{type(e).__name__}: {e}"})

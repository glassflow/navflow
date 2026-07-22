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
]


# Organize mode: the agent PROPOSES catalog changes as structured cards the user applies or skips
# in the console — these tools mutate nothing server-side (the console fires the normal validated
# management APIs on Apply). See docs/design/organize-agent.md.
PROPOSAL_TOOLS = [
    {"name": "propose_labels",
     "description": "Propose the labels (and primary key) for ONE source, as a card the user will "
                    "review. Propose only fields the source's field profile actually shows "
                    "(source_fields) — anything else cannot be extracted. Give concrete evidence "
                    "in `reasoning` (coverage, distinct counts, why the key is an entity). This "
                    "REPLACES the source's label set, so include every label it should end up with.",
     "input_schema": {"type": "object", "properties": {
         "source": {"type": "string"},
         "labels": {"type": "array", "items": {"type": "object", "properties": {
             "name": {"type": "string"},
             "field": {"type": "string", "description": "read per-event from this profiled field"},
             "const": {"type": "string", "description": "or: a fixed value on every event"},
             "primary": {"type": "boolean", "description": "exactly one label should be primary (the key)"},
             "pattern": {"type": "string", "description": "optional value normalization: regex "
                         "substitution applied to the field's value (e.g. '-(service|svc)$')"},
             "replace": {"type": "string", "description": "replacement for pattern (empty = strip)"},
             "map": {"type": "object", "description": "optional exact aliases applied AFTER the "
                     "pattern: {observed: canonical}, e.g. {\"ck\": \"checkout\"}"},
             "type": {"type": "string", "enum": ["string", "number"],
                      "description": "'number' stores the extracted value as a number so a trigger "
                      "can aggregate it (avg/max/sum); default 'string'. The primary key must be a "
                      "string. Only use 'number' when the value is genuinely numeric (e.g. an HTTP "
                      "status parsed out of the text, a latency)."}},
             "required": ["name"]}},
         "reasoning": {"type": "string"}},
         "required": ["source", "labels", "reasoning"]}},
    {"name": "propose_view",
     "description": "Propose a view correlating one or more sources into a single per-entity "
                    "timeline, as a card the user will review. key_field must be a label the "
                    "chosen sources share (after any proposed labels are applied). Explain in "
                    "`reasoning` what one read of this view returns and why it's useful.",
     "input_schema": {"type": "object", "properties": {
         "name": {"type": "string"},
         "key_field": {"type": "string"},
         "sources": {"type": "array", "items": {"type": "string"}},
         "filters": {"type": "array", "items": {"type": "object"}},
         "reasoning": {"type": "string"}},
         "required": ["name", "key_field", "sources", "reasoning"]}},
    {"name": "propose_trigger",
     "description": "Propose a trigger — a condition NavFlow evaluates continuously over a view; "
                    "when it trips, subscribed agents are woken with the correlated timeline. Use "
                    "when the user's goal involves alerting or autonomous debugging. The view must "
                    "exist or be proposed in this conversation; `field` must be a numeric field "
                    "events in that view carry (check source_fields). Explain the condition in "
                    "plain terms in `reasoning`.",
     "input_schema": {"type": "object", "properties": {
         "name": {"type": "string"},
         "view": {"type": "string"},
         "condition": {"type": "object", "properties": {
             "aggregate": {"type": "string", "enum": ["any", "avg", "count", "max", "min", "sum"]},
             "field": {"type": "string", "description": "numeric field to aggregate (omit for count)"},
             "predicate": {"type": "string", "description": "e.g. '> 1.0', '>= 5', '== 0'"},
             "window": {"type": "string", "description": "detection window, e.g. 1m"}},
             "required": ["aggregate", "predicate", "window"]},
         "emit": {"type": "object", "properties": {
             "kind": {"type": "string", "description": "what a firing is called, e.g. error_spike"},
             "context_window": {"type": "string", "description": "how much timeline the woken agent gets, e.g. 15m"}}},
         "cooldown": {"type": "string", "description": "minimum gap between firings per entity, e.g. 5m"},
         "reasoning": {"type": "string"}},
         "required": ["name", "view", "condition", "reasoning"]}},
]
_PROPOSAL_NAMES = {t["name"] for t in PROPOSAL_TOOLS}


def _canon_labels(specs) -> list:
    """Label specs in comparable form: (name, field, const, primary), order-independent."""
    out = []
    for s in specs or []:
        out.append((str(s.get("name") or ""), s.get("field"),
                    None if s.get("field") else (None if s.get("const") is None else str(s["const"])),
                    bool(s.get("primary"))))
    return sorted(out)


async def _current_labels(source: str, headers: dict):
    """The source's declared labels right now, or None if the source can't be read."""
    try:
        async with httpx.AsyncClient(timeout=10, headers=headers, base_url=_SELF) as cx:
            r = await cx.get(f"/api/sources/{source}")
        if r.status_code != 200:
            return None
        return (r.json().get("config") or {}).get("labels") or []
    except Exception:
        return None


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

When the user wants the catalog changed — labels on a source, a view, a trigger — do not just \
describe it: call propose_labels / propose_view / propose_trigger. Each proposal appears to the \
user as a card they apply or skip; you never change the catalog directly. Ground every proposal \
in evidence from the read tools."""


_ORGANIZE_SYSTEM = _SYSTEM_BASE + """

You are running in ORGANIZE mode: help the user structure their ingested data with the right
labels, keys, and views. Work in one pass:

1. Inventory: list_sources, then source_fields (and recent_events where the shape is unclear)
   for every source that has data.
2. Judge entity-ness from evidence: a good KEY identifies a durable entity (a service, a session,
   a tenant) — moderate distinct count, high coverage, stable values. Dimensions (http_method,
   level, status) make good secondary labels but bad keys. Sparse or constant fields are weak.
3. Labels come from REAL fields — never invent one. A label's `field` MUST be a field name
   source_fields actually showed for that source; anything else extracts nothing. A label reads a
   `field`, a `const`, or a regex over a field (`pattern`/`replace`, plus `map` for aliases) — reach
   for the regex to clean messy values rather than guessing at a tidy field that isn't there.
   FIRST check each source's existing labels (list_sources shows config.labels): if they already
   match what you'd propose, say so in text and do NOT call propose_labels. Otherwise call it ONCE
   with the COMPLETE label set (the proposal replaces, not appends). Same for views — don't propose
   a duplicate of one that already covers it.
3b. Watch the top values for VARIANTS of one entity (checkout / checkout-svc / checkout-service):
   correlation needs values to agree literally, so propose value normalization on the label —
   `pattern`/`replace` for whole families, `map` for irregular aliases (pattern runs first, map
   applies to its result). This is often the highest-value fix you can propose.
4. Views key and filter on LABELS only — never a raw field. A view's `key_field` (and filters) must
   be a label the chosen sources EXPOSE. If you want to correlate on something that isn't a label
   yet, promote it to a label first (propose_labels), then the view. Prefer a natural shared label;
   when sources share nothing but belong together, propose const labels (same name+value) on each,
   then key the view by that label. propose_view for each (1–3 views, not a zoo).
4b. To match a label across sources, add a NEW label — don't rename. If source B should join source
   A on `service` but B has no such label, propose a NEW label named `service` on B (reading B's
   matching field) — there is no rename, and a source's label set is declared whole, so add it and
   keep B's others. Normalize B's values (pattern/map) so they agree literally with A's.
5. When the user's goal involves alerting or waking agents on a condition (errors, spikes,
   thresholds), also propose triggers on the views you proposed: a numeric field the view's
   events carry, an aggregate + predicate + detection window, a sensible cooldown.
6. Finish with a short summary of what you proposed and why. Everything goes through proposals;
   the user applies or skips each card.

Proposals stream to the user as cards they apply or skip on the spot. Labels apply to new events
going forward — mention this only if the user asks. Be decisive; don't ask permission to inspect."""


def system_prompt(mode: str | None = None) -> str:
    return _ORGANIZE_SYSTEM if mode == "organize" else _SYSTEM_BASE


def tools_for(mode: str | None = None) -> list:
    # every mode: read tools + proposal cards — the agent never mutates the catalog directly
    return TOOLS + PROPOSAL_TOOLS


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
                system=system_prompt(mode), tools=tools_for(mode), messages=convo,
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
                if tu.name in _PROPOSAL_NAMES:
                    # no-op proposals are suppressed deterministically: re-proposing a source's
                    # exact current label set produces no card (re-runs must converge, not nag)
                    if tu.name == "propose_labels":
                        cur = await _current_labels(str(tu.input.get("source", "")), headers)
                        if cur is not None and _canon_labels(cur) == _canon_labels(tu.input.get("labels")):
                            results.append({"type": "tool_result", "tool_use_id": tu.id,
                                            "content": "this source ALREADY has exactly this label "
                                                       "set — no card was shown. Tell the user its "
                                                       "labels already look right; propose only "
                                                       "changes."})
                            continue
                    # a proposal is a card for the user, not a server-side action
                    kind = {"propose_labels": "labels", "propose_view": "view", "propose_trigger": "trigger"}[tu.name]
                    yield _sse({"type": "proposal", "kind": kind, "id": tu.id, "payload": tu.input})
                    results.append({"type": "tool_result", "tool_use_id": tu.id,
                                    "content": "proposal recorded — the user will review it as a "
                                               "card and apply or skip it"})
                    continue
                yield _sse({"type": "tool", "name": tu.name, "input": tu.input})
                out = await _execute_tool(tu.name, tu.input, headers)
                results.append({"type": "tool_result", "tool_use_id": tu.id, "content": out})
            convo.append({"role": "user", "content": results})
        yield _sse({"type": "done"})
    except Exception as e:  # noqa: BLE001 — surface auth/rate/other errors to the chat
        yield _sse({"type": "error", "detail": f"{type(e).__name__}: {e}"})

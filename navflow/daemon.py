"""navflowd — the always-on daemon. Owns the store; runs connector loops + trigger eval; serves
the local HTTP API (agent surface + management API) and the built-in console UI.

The catalog lives in the store (DB-backed). On first boot with an empty catalog, the YAML file at
NAVFLOW_CATALOG is imported once; from then on YAML is an import/export format, and all source/
view/trigger management happens over /api (or the UI at /).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel

from .config import (CatalogError, export_db_to_yaml, import_yaml_to_db,
                     validate_source_dict, validate_trigger_dict, validate_view_dict,
                     _source_from_dict)
from .connectors import SPECS, normalize_config, source_type_for
from .dispatch import Dispatcher
from .envelope import now_utc
from .runtime import Runtime
from .store import Store
from .views import resolve_query_full, resolve_read

CATALOG_PATH = os.getenv("NAVFLOW_CATALOG", "catalog.yaml")
DB_PATH = os.getenv("NAVFLOW_DB", "navflow.duckdb")
# Re-import the catalog YAML on every boot (declarative: the file is the source of truth, so an
# operator manages a read-only demo's sources by editing the YAML and restarting).
CATALOG_SYNC = os.getenv("NAVFLOW_CATALOG_SYNC", "").strip().lower() in ("1", "true", "yes", "on")

# Read-only mode (the public demo): the CONTROL plane (authoring — create/edit sources, derive,
# remember, …) is refused, but the DATA plane (ingest) stays open so real push services (Vercel,
# OTLP, webhooks) can still deliver. Poll sources reach outward and need no exception.
READONLY = os.getenv("NAVFLOW_READONLY", "").strip().lower() in ("1", "true", "yes", "on")
_READ_POST = {"/query"}  # the only read that happens to be a POST
# If set, ingest (push) requires this token in X-NavFlow-Token or Authorization: Bearer — so a
# public demo's ingest endpoints aren't wide open. Independent of READONLY.
INGEST_TOKEN = os.getenv("NAVFLOW_INGEST_TOKEN", "").strip()
# If set, the whole API + console require this token (self-hosted single-tenant). The SPA shell and
# static assets stay public so the login screen can load; ingest uses its own token (above).
AUTH_TOKEN = os.getenv("NAVFLOW_AUTH_TOKEN", "").strip()
# Server-provisioned Anthropic key for the in-app agent (Ask/Organize). Set at deploy time on
# hosted cells so users never paste a key; absent locally, the console prompts (BYO, unchanged).
# Never returned by any API — capabilities exposes only a boolean.
ANTHROPIC_KEY = os.getenv("NAVFLOW_ANTHROPIC_KEY", "").strip()
# Vercel verifies a log-drain endpoint by checking an x-vercel-verify response header. Set this to
# the value Vercel shows when adding the drain (or rely on echoing the request's header).
VERCEL_VERIFY = os.getenv("NAVFLOW_VERCEL_VERIFY", "").strip()


def _is_ingest(path: str) -> bool:
    return path.startswith("/ingest/") or path in ("/v1/logs", "/v1/traces", "/v1/metrics")


def _bearer(auth: str | None) -> str:
    return auth[7:].strip() if auth and auth.lower().startswith("bearer ") else ""


def _public(method: str, path: str) -> bool:
    """Reachable without the auth token: CORS preflight, the health probe, ingest (own token), and
    the console SPA shell + static assets (any GET that isn't an API/data route)."""
    if method == "OPTIONS" or path == "/health":
        return True
    if _is_ingest(path):
        return True
    return method in ("GET", "HEAD") and not (
        path.startswith("/api/") or path.startswith("/catalog") or path == "/query")


def _ui_dist() -> Path:
    """Where the built console SPA lives. Prefer the copy shipped inside the wheel
    (navflow/console, via hatch force-include); fall back to the source tree's ui/dist for
    `npm run dev`-style local work. NAVFLOW_UI_DIST overrides both."""
    if env := os.getenv("NAVFLOW_UI_DIST"):
        return Path(env)
    from importlib import resources
    packaged = resources.files("navflow") / "console"   # present in an installed wheel
    if packaged.is_dir():
        return Path(str(packaged))
    return Path(__file__).resolve().parent.parent / "ui" / "dist"   # running from the source tree


UI_DIST = _ui_dist()


class QueryReq(BaseModel):
    view: str
    key: str | None = None       # legacy primary key_value; optional when `where` is given
    where: dict = {}             # {label: value} on any named label — the label-native selector
    window: str = "15m"
    client: str = "http"   # http | mcp | ui — tags the query in the activity log
    include_payload: bool = False  # also return the raw lossless record as `raw` on each row


class ReadReq(BaseModel):
    selector: dict = {}          # {label: value, ...} — strict-AND conjunction; must be non-empty
    window: str = "15m"
    client: str = "http"   # http | mcp | ui — tags the read in the activity log
    include_payload: bool = False  # also return the raw lossless record as `raw` on each row


class SubReq(BaseModel):
    trigger: str
    url: str


class UnsubReq(BaseModel):
    subscription_id: str


class SourceIn(BaseModel):
    name: str
    type: str = ""          # ignored — the signal type is derived from the connector
    connector: str
    poll: str = "5s"
    config: dict = {}


class ViewIn(BaseModel):
    name: str
    key_field: str = ""          # optional: what the primary key means; labels make it non-essential
    sources: list[str]
    filters: list[dict] = []


class DeriveReq(BaseModel):
    sources: list[str]
    key_field: str
    name: str | None = None      # auto-generated if absent
    filters: list[dict] = []     # [{field, op, value}] — the doc's `predicate` param
    client: str = "mcp"          # who proposed it; lands in created_by as agent:<client>


class RememberReq(BaseModel):
    key: str                     # the entity this memory is about
    content: str
    memory_type: str = "observation"   # observation | aggregation | decision | custom
    fields: dict = {}            # extra values, kept in the payload (lossless); not auto-aggregated
    source: str | None = None    # target memory source; default auto-provisions agent_memory


class TriggerIn(BaseModel):
    name: str
    view: str
    condition: dict
    emit: dict = {}
    cooldown: str = "5m"


class ImportReq(BaseModel):
    yaml: str
    mode: str = "merge"    # merge (upsert) | replace (clear catalog first)


def make_app() -> FastAPI:
    store = Store(DB_PATH)

    # seed the DB catalog from YAML on first boot — or on every boot when CATALOG_SYNC is set, so
    # the file stays the source of truth (the admin interface for a read-only demo: edit + restart).
    if Path(CATALOG_PATH).exists() and (store.catalog_empty() or CATALOG_SYNC):
        counts = import_yaml_to_db(store, Path(CATALOG_PATH).read_text())
        how = "synced" if CATALOG_SYNC else "imported"
        print(f"navflowd: {how} {CATALOG_PATH} into catalog "
              f"({counts['sources']} sources, {counts['views']} views, {counts['triggers']} triggers)")

    dispatcher = Dispatcher(store)
    runtime = Runtime(store, dispatcher)

    def _otlp_source_for(header: str | None) -> str:
        """Resolve the OTLP source for an export (shared by the HTTP and gRPC receivers). Raises
        KeyError/ValueError; auto-provisions a single `otlp` source on the first export."""
        names = [s.name for s in runtime.catalog.sources.values() if s.connector == "otlp"]
        if header:
            if header not in names:
                raise KeyError(f"unknown OTLP source {header!r}")
            return header
        if len(names) == 1:
            return names[0]
        if not names:   # zero-setup: provision one on first export (point a collector and go)
            store.upsert_catalog_source(
                "otlp", source_type_for("otlp"), "otlp", "5s",
                normalize_config("otlp", {"labels": [
                    {"name": "service", "field": "resourceAttributes.service.name",
                     "primary": True}]}))
            runtime.reload_catalog()
            print("navflowd: auto-provisioned OTLP source 'otlp'")
            return "otlp"
        raise ValueError("multiple OTLP sources — set the X-NavFlow-Source header")

    @asynccontextmanager
    async def lifespan(_app):
        runtime.start_all()
        print(f"navflowd: {len(runtime.catalog.sources)} source(s); "
              f"console at / · agent API at /query · management API at /api")
        # optional OTLP gRPC receiver (:4317). Needs grpcio + opentelemetry-proto; off if absent.
        grpc_server = None
        port = os.getenv("NAVFLOW_OTLP_GRPC_PORT", "4317")
        if port and port.lower() not in ("off", "none", "0"):
            try:
                from .otlp_grpc import serve as _serve_otlp_grpc
                grpc_server = await _serve_otlp_grpc(int(port), _otlp_source_for, runtime.ingest_otlp)
                print(f"navflowd: OTLP gRPC receiver on :{port}")
            except ImportError:
                print("navflowd: OTLP gRPC off (install navflow[otlp-grpc] to enable)")
            except Exception as e:   # never let the optional receiver block startup
                print(f"navflowd: OTLP gRPC failed to start: {e}")
        yield
        if grpc_server is not None:
            await grpc_server.stop(grace=2)
        runtime.shutdown()

    app = FastAPI(title="navflowd", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                       allow_headers=["*"])

    # ── auth: scoped credentials ──────────────────────────────────────────────
    # Three scopes — read (consume: queries, catalog reads, derive/subscribe), ingest (contribute:
    # /ingest, /v1/*, remember), admin (configure: catalog CRUD, discover, credentials, keys).
    # Credentials: the env tokens act as implicit root keys (AUTH_TOKEN = admin, INGEST_TOKEN =
    # ingest, non-revocable), plus revocable scoped keys in the api_keys table (docs/design).
    _ADMIN_PATHS = ("/api/security", "/api/catalog/export", "/api/catalog/import", "/api/agent/chat")

    def _required_scope(method: str, path: str) -> str | None:
        """None = public. 'any' = any valid credential. Reads of credentials and all catalog
        mutation are admin; a trigger changes what the daemon computes for everyone, so trigger
        CRUD is admin too — but derive/subscribe stay read: they expose nothing a reader couldn't
        pull and forward, they only persist that reader's own delivery."""
        if method == "POST" and (_is_ingest(path) or path == "/remember"):
            return "ingest"   # before _public(): ingest paths are "public" only in the sense of
                              # not needing the auth token — they have their own scope
        if _public(method, path):
            return None
        if path == "/api/whoami":
            return "any"
        if path in _ADMIN_PATHS or path.startswith("/api/keys") or path.startswith("/api/discover"):
            return "admin"
        if method != "GET" and (path.startswith("/api/sources")
                                or path.startswith("/api/views") or path.startswith("/api/triggers")):
            return "admin"
        return "read"

    def _resolve_credential(request) -> tuple[set, dict] | tuple[None, None]:
        """Token from the request -> (scopes, identity), or (None, None) if unknown/absent."""
        tok = _bearer(request.headers.get("authorization")) or request.headers.get("x-navflow-token", "")
        if not tok:
            return None, None
        if AUTH_TOKEN and tok == AUTH_TOKEN:
            return {"read", "ingest", "admin"}, {"id": "env:auth", "name": "auth token (env)"}
        if INGEST_TOKEN and tok == INGEST_TOKEN:
            return {"ingest"}, {"id": "env:ingest", "name": "ingest token (env)"}
        key = store.find_api_key(hashlib.sha256(tok.encode()).hexdigest())
        if key:
            last = key.get("last_used_at")
            if last is None or (now_utc() - last).total_seconds() > 60:   # throttle write churn
                store.touch_api_key(key["id"])
            return set(key["scopes"]), {"id": f"key:{key['id']}", "name": key["name"]}
        return None, None

    if READONLY or INGEST_TOKEN or AUTH_TOKEN:
        @app.middleware("http")
        async def _guard(request, call_next):
            path, method = request.url.path, request.method
            required = _required_scope(method, path)
            # activation matches the pre-keys behavior: ingest is gated only when an ingest token
            # is configured; reads/management only when an auth token is (open local installs
            # stay open — keys are meaningful once the root tokens exist, i.e. always on hosted).
            if required == "ingest" and (INGEST_TOKEN or AUTH_TOKEN):
                scopes, ident = _resolve_credential(request)
                if not scopes or not ({"ingest", "admin"} & scopes):
                    return JSONResponse({"detail": "invalid or missing ingest token"}, status_code=401)
                request.state.credential = ident
            elif required in ("read", "admin", "any") and AUTH_TOKEN:
                scopes, ident = _resolve_credential(request)
                if not scopes:
                    return JSONResponse({"detail": "authentication required"}, status_code=401)
                if required != "any" and required not in scopes and "admin" not in scopes:
                    return JSONResponse({"detail": f"this credential lacks the {required!r} scope"},
                                        status_code=403)
                request.state.credential = ident
                request.state.scopes = sorted(scopes)
            if (READONLY and method not in ("GET", "HEAD", "OPTIONS")
                    and path not in _READ_POST and not _is_ingest(path)):
                return JSONResponse({"detail": "this NavFlow instance is read-only (control plane "
                                               "disabled; ingest still accepted)"}, status_code=403)
            return await call_next(request)

    def _err(e: Exception, code: int = 400):
        raise HTTPException(status_code=code, detail=str(e))

    # ── agent surface (unchanged contract; queries now logged) ───────────────
    @app.get("/health")
    async def health():
        return {"status": "ok", "readonly": READONLY, "auth_required": bool(AUTH_TOKEN),
                "sources": [] if AUTH_TOKEN else list(runtime.catalog.sources)}

    @app.post("/query")
    async def query(req: QueryReq):
        if req.view not in runtime.catalog.views:
            _err(KeyError(f"unknown view {req.view!r}"), 404)
        if not req.key and not req.where:
            _err(ValueError("query needs a key or a where selector"))
        payload, nrows, rows = resolve_query_full(store, runtime.catalog, req.view, req.key,
                                                  req.window, where=req.where or None,
                                                  include_payload=req.include_payload)
        log_key = req.key if req.key else ", ".join(f"{k}={v}" for k, v in req.where.items())
        store.log_query("q_" + uuid.uuid4().hex[:12], req.view, log_key, req.window,
                        nrows, req.client)
        return {"payload": payload, "rows": rows}

    @app.post("/read")
    async def read(req: ReadReq):
        """Raw label-native read across ALL sources — no view. The selector is a {label: value}
        conjunction (strict AND). This is the Layer-1 primitive: read any entity on the fly, then
        derive() a view once you know which sources matter."""
        if not req.selector:
            _err(ValueError('read needs a selector, e.g. {"project": "frontend"}'))
        payload, nrows, sources, rows = resolve_read(store, runtime.catalog, req.selector, req.window,
                                                     include_payload=req.include_payload)
        log_key = ", ".join(f"{k}={v}" for k, v in req.selector.items())
        store.log_query("r_" + uuid.uuid4().hex[:12], "(read)", log_key, req.window,
                        nrows, req.client)
        return {"payload": payload, "count": nrows, "sources": sources, "rows": rows}

    @app.post("/subscribe")
    async def subscribe(req: SubReq, request: Request):
        if req.trigger not in {t.name for t in runtime.catalog.triggers}:
            _err(KeyError(f"unknown trigger {req.trigger!r}"), 404)
        sid = "sub_" + uuid.uuid4().hex[:8]
        # record the creating credential: revoking a key removes its subscriptions (a revoked
        # agent must stop receiving trigger dispatches)
        ident = getattr(request.state, "credential", None)
        store.add_subscription(sid, req.trigger, req.url, created_by=ident["id"] if ident else None)
        return {"subscription_id": sid}

    @app.post("/unsubscribe")
    async def unsubscribe(req: UnsubReq):
        store.remove_subscription(req.subscription_id)
        return {"ok": True}

    @app.get("/catalog")
    async def catalog_list():
        return {
            "sources": [{"name": s.name, "type": s.type} for s in runtime.catalog.sources.values()],
            "views": [{"name": v.name, "key_field": v.key_field, "sources": v.sources,
                       "created_by": v.created_by}
                      for v in runtime.catalog.views.values()],
            "triggers": [{"name": t.name, "view": t.view} for t in runtime.catalog.triggers],
        }

    # ── catalog.describe — the discovery surface (design doc §4 MCP surface) ──
    def _lineage_edges() -> list[dict]:
        edges = []
        for v in runtime.catalog.views.values():
            for s in v.sources:
                edges.append({"from": f"source:{s}", "to": f"view:{v.name}",
                              "transform": "correlate"})
        for t in runtime.catalog.triggers:
            edges.append({"from": f"view:{t.view}", "to": f"trigger:{t.name}",
                          "transform": "condition"})
        return edges

    def _lag_seconds(ts) -> float | None:
        if ts is None:
            return None
        aware = ts if ts.tzinfo else ts.replace(tzinfo=now_utc().tzinfo)
        return max((now_utc() - aware).total_seconds(), 0.0)

    def _source_label_names(entry: dict) -> list[str]:
        cfg = entry.get("config") if isinstance(entry.get("config"), dict) else {}
        return [l["name"] for l in (cfg.get("labels") or []) if isinstance(l, dict) and l.get("name")]

    def _source_primary(entry: dict) -> str | None:
        """Name of the source's explicitly-marked primary label (the key), or None."""
        cfg = entry.get("config") if isinstance(entry.get("config"), dict) else {}
        for l in cfg.get("labels") or []:
            if isinstance(l, dict) and l.get("primary"):
                return l.get("name")
        return None

    def _label_facets() -> dict:
        """Entity axes the console facets by. A key is just the label marked primary, so facets
        are named labels (one flagged primary). Sources with no declared labels fall back to an
        unnamed `key` facet (their bare key_value)."""
        facets: dict = {}
        for s in store.list_catalog_sources():
            names = _source_label_names(s)
            if names:
                primary = _source_primary(s)
                for ln in names:
                    f = facets.setdefault(ln, {"sources": [], "primary": False})
                    f["sources"].append(s["name"])
                    if ln == primary:
                        f["primary"] = True
            else:
                f = facets.setdefault("key", {"sources": [], "primary": True, "unnamed": True})
                f["sources"].append(s["name"])
        return facets

    @app.get("/catalog/{handle}")
    async def catalog_describe(handle: str):
        kind, _, name = handle.partition(":")
        if not name or kind not in ("source", "view", "trigger"):
            _err(ValueError("handle must be source:<name>, view:<name> or trigger:<name>"))
        edges = [e for e in _lineage_edges() if handle in (e["from"], e["to"])]

        if kind == "source":
            entry = next((s for s in store.list_catalog_sources() if s["name"] == name), None)
            if entry is None:
                _err(KeyError(f"unknown source {name!r}"), 404)
            health = runtime.health_snapshot().get(name) or {}
            names = _source_label_names(entry)
            if names:
                labels = {ln: store.list_entities(ln, sources=[name], limit=20) for ln in names}
                primary_label = _source_primary(entry)
            else:
                labels = {"key": store.list_entities("key_value", sources=[name], limit=20)}
                primary_label = "key"
            return {
                "handle": handle, "kind": "source", "entry": entry,
                "schema": store.source_schema(name),
                "labels": labels,           # each named axis with its observed values
                "primary_label": primary_label,   # which axis is the key
                "freshness": {"last_event_time": health.get("last_ingest"),
                              "lag_seconds": _lag_seconds(health.get("last_ingest")),
                              "events_total": health.get("events_total", 0),
                              "status": health.get("status")},
                "lineage": edges,
                "sample": store.recent_events(source=name, limit=3),
            }

        if kind == "view":
            entry = next((v for v in store.list_catalog_views() if v["name"] == name), None)
            if entry is None:
                _err(KeyError(f"unknown view {name!r}"), 404)
            totals = {s["source"]: s for s in store.event_stats()}
            last = max((t["last_ingest"] for s in entry["sources"]
                        if (t := totals.get(s))), default=None)
            return {
                "handle": handle, "kind": "view",
                "entry": {**entry, "usage": store.view_usage().get(name)},
                "schema": {s: store.source_schema(s) for s in entry["sources"]},
                "freshness": {"last_event_time": last, "lag_seconds": _lag_seconds(last)},
                "lineage": edges,
            }

        entry = next((t for t in store.list_catalog_triggers() if t["name"] == name), None)
        if entry is None:
            _err(KeyError(f"unknown trigger {name!r}"), 404)
        return {
            "handle": handle, "kind": "trigger", "entry": entry,
            "subscribers": len(store.list_subscriptions(name)),
            "lineage": edges,
        }

    # ── entities — the (label, value) pairs, faceted (the entity surface) ─────
    @app.get("/api/entities")
    async def entities(label: str | None = None, limit: int = 50):
        facets = _label_facets()

        def values_for(name: str, facet: dict, lim: int):
            # an unnamed `key` facet reads the bare key_value, scoped to its label-less sources;
            # a named label reads that label across events that carry it
            if facet.get("unnamed"):
                return store.list_entities("key_value", sources=facet["sources"], limit=lim)
            return store.list_entities(name, limit=lim)

        def entry(name: str, facet: dict, lim: int) -> dict:
            srcs = facet["sources"] if facet.get("unnamed") else None
            lbl = "key_value" if facet.get("unnamed") else name
            return {"label": name, "primary": facet.get("primary", False),
                    "sources": sorted(set(facet["sources"])),
                    # high-cardinality: exceeded the cap, so it's served by a live scan, not the
                    # counter — surface it so the UI can flag it as "not a useful entity axis".
                    "high_cardinality": store.is_label_truncated(lbl, srcs),
                    "values": values_for(name, facet, lim)}

        if label is not None:
            if label not in facets:
                _err(KeyError(f"unknown label {label!r} (have {sorted(facets)})"), 404)
            return entry(label, facets[label], min(limit, 500))
        return {"labels": [entry(ln, f, min(limit, 50)) for ln, f in facets.items()]}

    # ── derive — agent-proposed views (virtual; the authorship layer) ─────────
    @app.post("/derive", status_code=201)
    async def derive(req: DeriveReq):
        name = req.name or "agent_view_" + uuid.uuid4().hex[:6]
        if name in runtime.catalog.views:
            _err(ValueError(f"view {name!r} already exists — derived views must not "
                            f"collide with existing entries"), 409)
        try:
            validate_view_dict({"name": name, "key_field": req.key_field,
                                "sources": req.sources, "filters": req.filters},
                               set(runtime.catalog.sources))
        except CatalogError as e:
            _err(e)
        store.upsert_catalog_view(name, req.key_field, req.sources, req.filters,
                                  created_by=f"agent:{req.client}")
        runtime.reload_catalog()
        return {"handle": f"view:{name}", "name": name, "status": "active",
                "note": "virtual view — query it by name like any other view"}

    # ── remember — the agent writes its own memory back (closes the loop) ─────
    @app.post("/remember", status_code=202)
    async def remember(req: RememberReq):
        source_name = req.source or next(
            (s.name for s in runtime.catalog.sources.values() if s.connector == "memory"), None)
        if source_name is None:   # first memory ever: provision the source on the fly
            source_name = "agent_memory"
            store.upsert_catalog_source(source_name, "agent_memory", "memory", "5s", {})
            runtime.reload_catalog()
            print(f"navflowd: auto-provisioned memory source {source_name!r}")
        payload = {"key": req.key, "content": req.content,
                   "memory_type": req.memory_type, "fields": req.fields}
        try:
            n = await runtime.ingest(source_name, payload)
        except KeyError as e:
            _err(e, 404)
        except ValueError as e:
            _err(e)
        return {"ok": True, "source": source_name, "ingested": n}

    # ── push ingestion (webhook sources) ──────────────────────────────────────
    def _verify_headers(request: Request) -> dict:
        """Vercel verifies a drain endpoint via the x-vercel-verify response header — echo the
        request's value if present, else the configured one."""
        val = request.headers.get("x-vercel-verify") or VERCEL_VERIFY
        return {"x-vercel-verify": val} if val else {}

    async def _parse_ingest_body(request: Request):
        """Accept a JSON object/array OR NDJSON (one JSON object per line, as some log drains send).
        An empty body (a verification ping) parses to []."""
        raw = (await request.body()).decode("utf-8", "replace").strip()
        if not raw:
            return []
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            try:
                return [json.loads(ln) for ln in raw.splitlines() if ln.strip()]
            except json.JSONDecodeError:
                _err(ValueError("body must be JSON or NDJSON"))

    @app.get("/ingest/{token}", include_in_schema=False)
    async def ingest_verify(token: str, request: Request):
        # Vercel (and similar) probe the endpoint before saving a drain — answer with the verify header.
        return JSONResponse({"ok": True}, headers=_verify_headers(request))

    @app.post("/ingest/{token}", status_code=202)
    async def ingest(token: str, request: Request):
        body = await _parse_ingest_body(request)
        try:
            n = await runtime.ingest(token, body)
        except KeyError as e:
            _err(e, 404)
        except ValueError as e:
            _err(e, 400)
        return JSONResponse({"ingested": n}, status_code=202, headers=_verify_headers(request))

    # ── OTLP receiver (OpenTelemetry/HTTP JSON; gRPC counterpart in lifespan) ──
    def _resolve_otlp_source(header: str | None) -> str:
        try:
            return _otlp_source_for(header)   # shared with the gRPC receiver
        except KeyError as e:
            _err(e, 404)
        except ValueError as e:
            _err(e)

    async def _otlp(signal: str, request: Request):
        try:
            body = await request.json()
        except Exception:
            _err(ValueError("invalid JSON (OTLP/HTTP JSON expected)"))
        source = _resolve_otlp_source(request.headers.get("x-navflow-source"))
        try:
            await runtime.ingest_otlp(source, signal, body)
        except KeyError as e:
            _err(e, 404)
        except ValueError as e:
            _err(e, 400)
        return {}   # OTLP success: an (empty) ExportServiceResponse

    @app.post("/v1/logs")
    async def otlp_logs(request: Request):
        return await _otlp("logs", request)

    @app.post("/v1/traces")
    async def otlp_traces(request: Request):
        return await _otlp("traces", request)

    @app.post("/v1/metrics")
    async def otlp_metrics(request: Request):
        return await _otlp("metrics", request)

    # ── management API: connectors ────────────────────────────────────────────
    @app.get("/api/connectors")
    async def connectors():
        return {name: spec for name, spec in SPECS.items()}

    @app.get("/api/security")
    async def security():
        """Instance credentials, for the authenticated operator. The ingest token is the shared,
        machine-facing secret producers send as X-NavFlow-Token / Bearer on /ingest and /v1/*; the
        console surfaces it here so the operator can hand it to producers without shell access."""
        # ingest is gated whenever ANY root token is configured (a secured instance doesn't accept
        # anonymous events); auth_required tells the UI whether this instance enforces at all
        return {"ingest_token": INGEST_TOKEN or None,
                "ingest_required": bool(INGEST_TOKEN or AUTH_TOKEN),
                "auth_required": bool(AUTH_TOKEN)}

    # ── API keys: scoped, revocable credentials (admin scope; see docs/design) ─
    _SCOPES = {"read", "ingest", "admin"}

    @app.get("/api/keys")
    async def list_keys():
        return {"keys": store.list_api_keys(),
                "enforced": bool(AUTH_TOKEN),   # without a root auth token the instance is open
                "scopes": sorted(_SCOPES)}

    @app.post("/api/keys", status_code=201)
    async def create_key(body: dict = Body(...)):
        name = str(body.get("name") or "").strip()
        scopes = sorted(set(body.get("scopes") or []))
        if not name:
            _err(ValueError("name is required"))
        if not scopes or not set(scopes) <= _SCOPES:
            _err(ValueError(f"scopes must be a non-empty subset of {sorted(_SCOPES)}"))
        kid = uuid.uuid4().hex[:8]
        secret = f"nvf_{kid}_{secrets.token_urlsafe(24)}"
        store.insert_api_key(kid, name, f"nvf_{kid}", hashlib.sha256(secret.encode()).hexdigest(),
                             scopes)
        # the secret exists only in this response; the store keeps its hash
        return {"id": kid, "name": name, "scopes": scopes, "secret": secret}

    @app.delete("/api/keys/{kid}")
    async def revoke_key(kid: str):
        if not store.revoke_api_key(kid):
            _err(KeyError(f"no active key {kid!r}"), 404)
        return {"ok": True, "note": "key revoked; its subscriptions were removed"}

    @app.get("/api/whoami")
    async def whoami(request: Request):
        ident = getattr(request.state, "credential", None)
        scopes = getattr(request.state, "scopes", None)
        if ident is None:   # guard not active (open instance) or ingest-path credential
            return {"id": "open", "name": "no auth configured", "scopes": sorted(_SCOPES)}
        return {**ident, "scopes": scopes or []}

    @app.get("/api/capabilities")
    async def capabilities():
        """Host capabilities that gate local-only console features, so the UI can hide actions that
        can't work on this deployment — e.g. a hosted cell has no Docker socket, so Auto-discover
        would be a dead end. (Claude Code is plugin-based and works everywhere, so it's not gated.)"""
        import shutil
        return {
            "discover_docker": shutil.which("docker") is not None or os.path.exists("/var/run/docker.sock"),
            "agent_key_configured": bool(ANTHROPIC_KEY),
        }

    @app.post("/api/labels/preview")
    async def label_preview(body: dict = Body(...)):
        """Pure preview of a label spec's value normalization against a source's OBSERVED values:
        before -> after with event counts, so the user sees the merge they're about to create
        before saving (docs/design/label-value-normalization.md). No state is touched."""
        from collections import Counter

        from .config import extract_labels
        from .connectors import build_connector, normalize_label_specs

        source = body.get("source")
        spec = body.get("label") or {}
        cfg = runtime.catalog.sources.get(str(source))
        if cfg is None:
            _err(KeyError(f"unknown source {source!r}"), 404)
        try:   # validate the label spec exactly like a save would (bad regex -> 400 here)
            normalized = normalize_label_specs([spec])
        except CatalogError as e:
            _err(e)
        if not normalized or "field" not in normalized[0]:
            _err(ValueError("preview needs a field label spec"))
        lspec = normalized[0]

        conn = build_connector(cfg, store)
        pairs: Counter = Counter()   # (before, after) -> events
        sampled = 0
        for payload in store.recent_payloads(cfg.name, 2000):
            ctx = conn.label_context(payload)
            if not isinstance(ctx, dict):
                continue
            sampled += 1
            plain = extract_labels([{k: v for k, v in lspec.items() if k not in ("pattern", "replace", "map")}], ctx)
            if lspec["name"] not in plain:
                continue
            before = plain[lspec["name"]]
            after = extract_labels([lspec], ctx)[lspec["name"]]
            pairs[(before, after)] += 1
        results = [{"from": b, "to": a, "events": n}
                   for (b, a), n in sorted(pairs.items(), key=lambda kv: -kv[1])]
        return {"sampled": sampled, "results": results,
                "distinct_before": len({b for b, _ in pairs}),
                "distinct_after": len({a for _, a in pairs})}

    @app.post("/api/sources/discover")
    async def discover_source(body: dict = Body(...)):
        from .connectors import REGISTRY
        connector = body.get("connector")
        if connector not in REGISTRY:
            _err(ValueError(f"unknown connector {connector!r}"), 404)
        try:
            # bounded + catch-all: driver errors (asyncpg timeouts/auth/network) are not ValueError
            # and would otherwise 500 with nothing shown to the user
            proposal = await asyncio.wait_for(
                REGISTRY[connector].discover(body.get("config", {}) or {}), timeout=30)
        except (TimeoutError, asyncio.TimeoutError):
            _err(ValueError("discover timed out — is the target reachable from the NavFlow "
                            "server? (a hosted NavFlow can only reach public endpoints)"))
        except HTTPException:
            raise
        except Exception as e:
            _err(ValueError(f"discover failed: {e}"))
        if proposal is None:
            _err(ValueError(f"connector {connector!r} doesn't support discovery yet"))
        return proposal

    @app.get("/api/discover/environment")
    async def discover_environment(provider: str = "docker"):
        if provider != "docker":
            _err(ValueError(f"unknown provider {provider!r} (have: docker)"), 404)
        from .discovery import scan_docker
        try:
            return await scan_docker()
        except ValueError as e:
            _err(e)


    # ── management API: sources ───────────────────────────────────────────────
    @app.get("/api/sources")
    async def list_sources():
        health = runtime.health_snapshot()
        return [{**s, "health": health.get(s["name"])} for s in store.list_catalog_sources()]

    @app.get("/api/sources/{name}")
    async def get_source(name: str):
        for s in store.list_catalog_sources():
            if s["name"] == name:
                return {**s, "health": runtime.health_snapshot().get(name)}
        _err(KeyError(f"unknown source {name!r}"), 404)

    @app.post("/api/sources", status_code=201)
    async def create_source(body: SourceIn):
        if body.name in runtime.catalog.sources:
            _err(ValueError(f"source {body.name!r} already exists"), 409)
        try:
            validate_source_dict(body.model_dump())
            config = normalize_config(body.connector, body.config)
        except CatalogError as e:
            _err(e)
        store.upsert_catalog_source(body.name, source_type_for(body.connector), body.connector,
                                    body.poll, config)
        runtime.reload_catalog()
        cfg = runtime.catalog.sources.get(body.name)
        return {"ok": True, "name": body.name, "ingest_key": cfg.ingest_key if cfg else None}

    @app.put("/api/sources/{name}")
    async def update_source(name: str, body: SourceIn):
        existing = {s["name"]: s for s in store.list_catalog_sources()}.get(name)
        if existing is None:
            _err(KeyError(f"unknown source {name!r}"), 404)
        if body.name != name:
            _err(ValueError("renaming a source is not supported; delete and recreate"), 400)
        try:
            validate_source_dict(body.model_dump())
            config = normalize_config(body.connector, body.config)
        except CatalogError as e:
            _err(e)
        store.upsert_catalog_source(name, source_type_for(body.connector), body.connector,
                                    body.poll, config, paused=existing["paused"])
        runtime.reload_catalog()
        # Label specs apply to NEW events going forward — ingest reads the current specs. Existing
        # events keep the labels they were ingested with. A retroactive relabel of stored events can
        # rewrite millions of rows, so it is a planned explicit background action (see
        # store.backfill_labels for the building block), never something that runs inline on an edit.
        return {"ok": True, "relabeled": False}

    @app.delete("/api/sources/{name}")
    async def delete_source(name: str, purge_events: bool = False):
        if name not in {s["name"] for s in store.list_catalog_sources()}:
            _err(KeyError(f"unknown source {name!r}"), 404)
        referencing = [v.name for v in runtime.catalog.views.values() if name in v.sources]
        if referencing:
            _err(ValueError(f"source {name!r} is used by views {referencing}; "
                            f"remove it from those views first"), 409)
        store.delete_catalog_source(name)
        purged = store.purge_events(name) if purge_events else 0
        runtime.reload_catalog()
        return {"ok": True, "purged_events": purged}

    @app.post("/api/sources/{name}/pause")
    async def pause_source(name: str):
        if name not in runtime.catalog.sources:
            _err(KeyError(f"unknown source {name!r}"), 404)
        store.set_source_paused(name, True)
        runtime.reload_catalog()
        return {"ok": True}

    @app.post("/api/sources/{name}/resume")
    async def resume_source(name: str):
        if name not in runtime.catalog.sources:
            _err(KeyError(f"unknown source {name!r}"), 404)
        store.set_source_paused(name, False)
        runtime.reload_catalog()
        return {"ok": True}

    @app.post("/api/sources/test")
    async def test_source(body: SourceIn):
        try:
            validate_source_dict(body.model_dump())
            d = body.model_dump()
            d["config"] = normalize_config(body.connector, body.config)
        except CatalogError as e:
            _err(e)
        return await runtime.test_source(_source_from_dict(d))

    @app.get("/api/sources/{name}/events")
    async def source_events(name: str, limit: int = 50):
        if name not in {s["name"] for s in store.list_catalog_sources()}:
            _err(KeyError(f"unknown source {name!r}"), 404)
        return store.recent_events(source=name, limit=min(limit, 500))

    @app.get("/api/sources/{name}/fields")
    async def source_fields(name: str, limit: int = 500):
        """What this source actually contains: the connector's normalized fields (the things you can
        key/label on), each with how many sampled events carry it and its top values. Makes the
        otherwise-invisible normalized structure visible, so a key is chosen, not guessed."""
        from collections import Counter

        from .connectors import build_connector
        cfg = runtime.catalog.sources.get(name)
        if cfg is None:
            _err(KeyError(f"unknown source {name!r}"), 404)
        conn = build_connector(cfg, store)

        # Which fields are actual entity axes (the things you read/alert by). Match a declared label
        # by the field's last path segment, so a nested context (e.g. a Prometheus label set stored
        # under `metric`) still maps: `metric.service` counts as the declared `service` label.
        label_specs = (cfg.config.get("labels") or []) if isinstance(cfg.config, dict) else []
        label_names = {s.get("field") or s.get("name") for s in label_specs} | {s.get("name") for s in label_specs}
        label_names.discard(None)
        key_names = {(s.get("field") or s.get("name")) for s in label_specs if s.get("primary")}
        key_names.discard(None)

        from .config import extract_labels

        counts: dict[str, Counter] = {}
        label_counts: dict[str, Counter] = {}   # the EXTRACTED value of each declared label
        sampled = 0
        for payload in store.recent_payloads(name, min(limit, 2000)):
            ctx = conn.label_context(payload)
            if not isinstance(ctx, dict):
                continue
            sampled += 1
            for k, v in ctx.items():
                if isinstance(v, dict):                 # explode one level: metric.service, metric.endpoint, …
                    for sk, sv in v.items():
                        if sv not in (None, ""):
                            counts.setdefault(f"{k}.{sk}", Counter())[str(sv)] += 1
                elif v not in (None, ""):
                    counts.setdefault(k, Counter())[str(v)] += 1
            # Profile the actual EXTRACTED labels too (the same extraction ingest uses), so a
            # derived label (regex/const/map over a raw field) is visible with its real coverage
            # and values — not just the raw field it reads from.
            for lname, lval in extract_labels(label_specs, ctx).items():
                if lval not in (None, ""):
                    label_counts.setdefault(lname, Counter())[str(lval)] += 1

        def entry(fname, help_="", primary_default=False):
            vals = counts.get(fname, Counter())
            seg = fname.rsplit(".", 1)[-1]
            return {"name": fname, "help": help_, "primary_default": primary_default,
                    "coverage": sum(vals.values()), "distinct": len(vals),
                    "is_label": seg in label_names or fname in label_names,
                    "is_key": seg in key_names or fname in key_names,
                    "values": [{"value": val, "events": c} for val, c in vals.most_common(8)]}

        fields, seen = [], set()
        for spec in getattr(type(conn), "PROVIDES", None) or []:   # advertised fields, in order
            fields.append(entry(spec["name"], spec.get("help", ""), spec.get("primary", False)))
            seen.add(spec["name"])
        for fname in counts:                                       # plus observed (flattened) fields
            if fname not in seen:
                fields.append(entry(fname))
        # entity axes first (key, then label), then the rest — lead with what you'd actually key on.
        fields.sort(key=lambda f: (0 if f["is_key"] else 1 if f["is_label"] else 2))

        # Declared labels, profiled by their EXTRACTED value — the curated axes you read/alert by,
        # surfaced whether they map to a raw field (service) or are derived (http_status). Coverage
        # of 0 means the extraction matched nothing (e.g. a bad regex) — useful on its own.
        labels = []
        for s in label_specs:
            lname = s.get("name")
            if not lname:
                continue
            vals = label_counts.get(lname, Counter())
            labels.append({"name": lname, "is_key": bool(s.get("primary")),
                           "coverage": sum(vals.values()), "distinct": len(vals),
                           "values": [{"value": val, "events": c} for val, c in vals.most_common(8)]})
        labels.sort(key=lambda l: 0 if l["is_key"] else 1)

        return {"sampled": sampled, "fields": fields, "labels": labels}

    # ── in-app agent (the Ask view) — server-side chat loop over the read API ──
    @app.post("/api/agent/chat")
    async def agent_chat(request: Request):
        from .agent import run_agent
        # per-request header key wins (a user override); the server-provisioned key is the fallback
        key = request.headers.get("x-anthropic-key", "").strip() or ANTHROPIC_KEY
        if not key:
            _err(ValueError("add your Anthropic API key to use the assistant"), 400)
        body = await request.json()
        # the daemon's own token, so the agent's tool self-calls clear the auth middleware
        self_headers = {"Authorization": f"Bearer {AUTH_TOKEN}"} if AUTH_TOKEN else {}
        return StreamingResponse(
            run_agent(key, body.get("messages") or [], body.get("mode") or "explore",
                      body.get("model"), self_headers),
            media_type="text/event-stream")

    @app.get("/api/mcp/tools")
    async def mcp_tool_list():
        """The tools an external agent gets over MCP — read straight from the MCP server's own
        registration (so it reflects read-only gating). Powers the Connect view."""
        from .mcp_server import mcp as mcp_srv
        return [{"name": t.name, "description": (t.description or "").strip()}
                for t in await mcp_srv.list_tools()]

    # ── management API: views ─────────────────────────────────────────────────
    @app.get("/api/views")
    async def list_views():
        usage = store.view_usage()
        return [{**v, "usage": usage.get(v["name"])} for v in store.list_catalog_views()]

    @app.post("/api/views", status_code=201)
    async def create_view(body: ViewIn):
        if body.name in runtime.catalog.views:
            _err(ValueError(f"view {body.name!r} already exists"), 409)
        try:
            validate_view_dict(body.model_dump(), set(runtime.catalog.sources))
        except CatalogError as e:
            _err(e)
        store.upsert_catalog_view(body.name, body.key_field, body.sources, body.filters)
        runtime.reload_catalog()
        return {"ok": True}

    @app.put("/api/views/{name}")
    async def update_view(name: str, body: ViewIn):
        if name not in runtime.catalog.views:
            _err(KeyError(f"unknown view {name!r}"), 404)
        if body.name != name:
            _err(ValueError("renaming a view is not supported; delete and recreate"), 400)
        try:
            validate_view_dict(body.model_dump(), set(runtime.catalog.sources))
        except CatalogError as e:
            _err(e)
        store.upsert_catalog_view(name, body.key_field, body.sources, body.filters,
                                  created_by=runtime.catalog.views[name].created_by)
        runtime.reload_catalog()
        return {"ok": True}

    @app.delete("/api/views/{name}")
    async def delete_view(name: str):
        if name not in runtime.catalog.views:
            _err(KeyError(f"unknown view {name!r}"), 404)
        referencing = [t.name for t in runtime.catalog.triggers if t.view == name]
        if referencing:
            _err(ValueError(f"view {name!r} is used by triggers {referencing}; "
                            f"delete those triggers first"), 409)
        store.delete_catalog_view(name)
        runtime.reload_catalog()
        return {"ok": True}

    # ── management API: triggers ──────────────────────────────────────────────
    @app.get("/api/triggers")
    async def list_triggers():
        return store.list_catalog_triggers()

    @app.post("/api/triggers", status_code=201)
    async def create_trigger(body: TriggerIn):
        if body.name in {t.name for t in runtime.catalog.triggers}:
            _err(ValueError(f"trigger {body.name!r} already exists"), 409)
        try:
            validate_trigger_dict(body.model_dump(), set(runtime.catalog.views))
        except CatalogError as e:
            _err(e)
        store.upsert_catalog_trigger(body.name, body.view, body.condition, body.emit, body.cooldown)
        runtime.reload_catalog()
        return {"ok": True}

    @app.put("/api/triggers/{name}")
    async def update_trigger(name: str, body: TriggerIn):
        if name not in {t.name for t in runtime.catalog.triggers}:
            _err(KeyError(f"unknown trigger {name!r}"), 404)
        if body.name != name:
            _err(ValueError("renaming a trigger is not supported; delete and recreate"), 400)
        try:
            validate_trigger_dict(body.model_dump(), set(runtime.catalog.views))
        except CatalogError as e:
            _err(e)
        store.upsert_catalog_trigger(name, body.view, body.condition, body.emit, body.cooldown)
        runtime.reload_catalog()
        return {"ok": True}

    @app.delete("/api/triggers/{name}")
    async def delete_trigger(name: str):
        if name not in {t.name for t in runtime.catalog.triggers}:
            _err(KeyError(f"unknown trigger {name!r}"), 404)
        store.delete_catalog_trigger(name)
        runtime.reload_catalog()
        return {"ok": True}

    @app.post("/api/triggers/{name}/pause")
    async def pause_trigger(name: str):
        if name not in {t.name for t in runtime.catalog.triggers}:
            _err(KeyError(f"unknown trigger {name!r}"), 404)
        store.set_trigger_paused(name, True)
        runtime.reload_catalog()
        return {"ok": True}

    @app.post("/api/triggers/{name}/resume")
    async def resume_trigger(name: str):
        if name not in {t.name for t in runtime.catalog.triggers}:
            _err(KeyError(f"unknown trigger {name!r}"), 404)
        store.set_trigger_paused(name, False)
        runtime.reload_catalog()
        return {"ok": True}

    # ── management API: activity (what agents saw / what woke them) ──────────
    @app.get("/api/activity/queries")
    async def activity_queries(limit: int = 100):
        return store.list_queries(limit=min(limit, 500))

    @app.get("/api/activity/dispatches")
    async def activity_dispatches(limit: int = 100):
        return store.list_dispatches(limit=min(limit, 500))

    @app.get("/api/activity/dispatches/{dispatch_id}")
    async def activity_dispatch(dispatch_id: str):
        """One firing, deep. Fetch-by-id so a linked dispatch page never dead-ends (unlike the
        capped list). Includes the per-subscriber delivery attempts with masked endpoints + agent
        names, so the failure is attributable to a specific agent."""
        d = store.get_dispatch(dispatch_id)
        if d is None:
            _err(KeyError(f"unknown dispatch {dispatch_id!r}"), 404)
        deliveries = []
        for dv in store.deliveries_for(dispatch_id):
            name, masked = _agent_identity(dv["url"].rstrip("/"))
            deliveries.append({"agent": name, "endpoint": masked, "ok": dv["ok"],
                               "error": dv["error"], "delivered_at": dv["delivered_at"]})
        return {**d, "deliveries": deliveries}

    # ── connected agents: subscriptions grouped by endpoint, named deterministically ──
    _AGENT_ADJ = ["brisk", "quiet", "amber", "bold", "calm", "deft", "eager", "fleet",
                  "keen", "lucid", "merry", "noble", "prime", "swift", "vivid", "wry"]
    _AGENT_NOUN = ["heron", "otter", "drake", "skiff", "beacon", "compass", "gull", "harbor",
                   "keel", "lantern", "mast", "pilot", "rudder", "sextant", "tide", "wake"]

    def _agent_identity(url: str) -> tuple[str, str]:
        """(deterministic name, masked display URL) for a subscriber endpoint. The URL is the
        identity; hook URLs carry secrets in the path, so the last path segment is masked."""
        norm = url.rstrip("/")
        h = int(hashlib.sha256(norm.encode()).hexdigest(), 16)
        name = f"{_AGENT_ADJ[h % len(_AGENT_ADJ)]}-{_AGENT_NOUN[(h // 16) % len(_AGENT_NOUN)]}"
        try:
            from urllib.parse import urlsplit
            u = urlsplit(norm)
            segs = [seg for seg in u.path.split("/") if seg]
            if segs:
                segs[-1] = segs[-1][:2] + "…" if len(segs[-1]) > 2 else "…"
            masked = f"{u.scheme}://{u.netloc}/" + "/".join(segs)
        except Exception:
            masked = norm[:24] + "…"
        return name, masked

    @app.get("/api/agents")
    async def connected_agents():
        """The roster: every subscribed endpoint as a named agent — its wiring (triggers,
        creating credential), delivery health, and recent wakes."""
        stats = store.delivery_stats()
        agents: dict[str, dict] = {}
        for sub in store.all_subscriptions():
            norm = sub["url"].rstrip("/")
            a = agents.get(norm)
            if a is None:
                name, masked = _agent_identity(norm)
                st = stats.get(sub["url"], stats.get(norm, {}))
                a = agents[norm] = {
                    "name": name, "endpoint": masked,
                    "subscriptions": [], "triggers": [], "created_by": set(),
                    "first_seen": sub["created_at"],
                    "delivered_ok": st.get("ok", 0), "delivered_fail": st.get("fail", 0),
                    "last_woken": st.get("last_at"),
                    # currently failing: the most recent delivery to this endpoint did not succeed.
                    "unhealthy": st.get("fail", 0) > 0 and not st.get("last_ok", True),
                    "last_error": None if st.get("last_ok", True) else st.get("last_error"),
                    "recent": [{"at": d["at"], "ok": d["ok"], "trigger": d["trigger"],
                                "key": d["key"], "error": d["error"], "dispatch_id": d["dispatch_id"]}
                               for d in store.recent_deliveries(sub["url"], 10)],
                }
            a["subscriptions"].append({"subscription_id": sub["subscription_id"],
                                       "trigger": sub["trigger"], "created_at": sub["created_at"]})
            if sub["trigger"] not in a["triggers"]:
                a["triggers"].append(sub["trigger"])
            if sub["created_by"]:
                a["created_by"].add(sub["created_by"])
            if sub["created_at"] and (a["first_seen"] is None or sub["created_at"] < a["first_seen"]):
                a["first_seen"] = sub["created_at"]
        out = []
        for a in agents.values():
            a["created_by"] = sorted(a["created_by"])
            out.append(a)
        out.sort(key=lambda x: str(x.get("last_woken") or x.get("first_seen") or ""), reverse=True)
        return {"agents": out}

    @app.get("/api/subscriptions")
    async def subscriptions():
        return store.list_all_subscriptions()

    # ── management API: catalog import/export ────────────────────────────────
    @app.get("/api/catalog/export")
    async def catalog_export():
        return PlainTextResponse(export_db_to_yaml(store), media_type="application/yaml")

    @app.post("/api/catalog/import")
    async def catalog_import(body: ImportReq):
        if body.mode == "replace":
            store.clear_catalog()
        try:
            counts = import_yaml_to_db(store, body.yaml)
        except CatalogError as e:
            _err(e)
        except Exception as e:
            _err(ValueError(f"invalid YAML: {e}"))
        runtime.reload_catalog()
        return {"ok": True, **counts}

    # ── console UI (built SPA; catch-all registered last so API routes win) ──
    @app.get("/{path:path}", include_in_schema=False)
    async def ui(path: str):
        if not UI_DIST.exists():
            return JSONResponse(
                {"detail": "console not built — run `npm install && npm run build` in ui/"},
                status_code=404)
        f = (UI_DIST / path).resolve()
        if path and f.is_file() and f.is_relative_to(UI_DIST.resolve()):
            return FileResponse(f)
        return FileResponse(UI_DIST / "index.html")

    return app

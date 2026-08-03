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
import re
import secrets
import shutil
import traceback
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import parse_qs

import httpx
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel

from .config import (SLACK_URL_PREFIX, CatalogError, agent_url, export_db_to_yaml,
                     import_yaml_to_db, slack_channel_from_url, slack_url,
                     validate_agent_dict, validate_slack_channel, validate_source_dict,
                     validate_trigger_dict, validate_view_dict, _source_from_dict)
from .connectors import (SPECS, normalize_config, redact_config, restore_secrets,
                         source_type_for)
from .dispatch import Dispatcher
from .envelope import now_utc
from .builtin_agents import (PRESETS as AGENT_PRESETS, AgentRunner,
                             resolve_key as resolve_anthropic_key)
from .runtime import Runtime
from . import slack as slack_mod
from . import slack_verify
from .slack import SETTING_KEY as SLACK_TOKEN_SETTING, resolve_token as resolve_slack_token
from .store import Store, StoreUnavailable
from .views import resolve_query_full, resolve_read

CATALOG_PATH = os.getenv("NAVFLOW_CATALOG", "catalog.yaml")
DB_PATH = os.getenv("NAVFLOW_DB", "navflow.duckdb")
# Re-import the catalog YAML on every boot (declarative: the file is the source of truth, so an
# operator manages a read-only demo's sources by editing the YAML and restarting).
CATALOG_SYNC = os.getenv("NAVFLOW_CATALOG_SYNC", "").strip().lower() in ("1", "true", "yes", "on")

# Auth mode. When set (via `navflow up --auth`, which resolves + exports a root token), the whole
# API + console + ingest require a credential; when unset the instance is open (local default).
# The SPA shell and static assets stay public so the login screen can load. This is the ONE security
# switch — there is no separate ingest token and no read-only mode; producers get scoped API keys.
AUTH_TOKEN = os.getenv("NAVFLOW_AUTH_TOKEN", "").strip()
# Cloud login handoff (additive, env-gated). Set on a cloud-managed cell to the control plane's login
# URL, e.g. https://app.navflow.dev/login; unset for self-host (behaves exactly as before). Surfaced
# on the PUBLIC /health so a logged-out console knows where to send the browser to authenticate.
LOGIN_URL = os.getenv("NAVFLOW_LOGIN_URL", "").strip()
# The Anthropic key for the in-app Ask agent (and NavFlow agents) is resolved at request time via
# resolve_anthropic_key(store): env ANTHROPIC_API_KEY, else the console-stored key.
# Never returned by any API — capabilities exposes only a boolean.
# The Slack bot token behind the slack:// dispatch sink follows exactly the same rule via
# resolve_slack_token(store): env NAVFLOW_SLACK_BOT_TOKEN, else the console-stored value.


def _is_ingest(path: str) -> bool:
    return path.startswith("/ingest/") or path in ("/v1/logs", "/v1/traces", "/v1/metrics")


def _bearer(auth: str | None) -> str:
    return auth[7:].strip() if auth and auth.lower().startswith("bearer ") else ""


SLACK_EVENTS_PATH = "/api/slack/events"


def _public(method: str, path: str) -> bool:
    """Reachable without the auth token: CORS preflight, the health probe, ingest (own token), the
    Slack inbound endpoint (own signature), and the console SPA shell + static assets (any GET that
    isn't an API/data route)."""
    if method == "OPTIONS" or path == "/health":
        return True
    if _is_ingest(path):
        return True
    if method == "POST" and path == SLACK_EVENTS_PATH:
        # Slack calls this from its own infrastructure and cannot carry our bearer token, so it has
        # to be public to THIS middleware — but it is not unauthenticated. It is gated by an
        # HMAC-SHA256 signature over the raw body plus a 5-minute replay window (slack_verify.py),
        # and returns 503 rather than serving anything when no signing secret is configured.
        # Exactly one method on exactly one path: no prefix match, so nothing else rides in on it.
        return True
    return method in ("GET", "HEAD") and not (
        path.startswith("/api/") or path.startswith("/catalog") or path == "/query")


_SIZE_UNITS = {"": 1, "k": 10**3, "m": 10**6, "g": 10**9, "t": 10**12,
               "ki": 1 << 10, "mi": 1 << 20, "gi": 1 << 30, "ti": 1 << 40}


def _parse_size(v: str | None) -> int | None:
    """NAVFLOW_MAX_DB_SIZE -> bytes. Accepts a plain integer or a Kubernetes-style quantity
    ('10Gi', '500Mi', '2G') so a Helm chart can pass the PVC size through verbatim. Unset,
    empty or unparseable -> None, i.e. no denominator and exactly today's behaviour."""
    if not v or not (v := v.strip()):
        return None
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([KMGTkmgt]i?|)[Bb]?", v)
    if not m:
        return None
    n = int(float(m.group(1)) * _SIZE_UNITS[m.group(2).lower()])
    return n if n > 0 else None


MAX_DB_SIZE = _parse_size(os.getenv("NAVFLOW_MAX_DB_SIZE"))


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

# /health reports `degraded` at or above this share of NAVFLOW_MAX_DB_SIZE. On the 0-100 scale of
# /api/usage's pct_used, so 90 means 90% — not 0.9. Unknown (no limit configured) is never degraded.
DEGRADED_PCT = float(os.getenv("NAVFLOW_DEGRADED_PCT", "90"))

# How long a `/navflow ask` may think before Slack gets an apology instead of an answer. The user
# is staring at a "…" in a channel, so this is deliberately much shorter than the agent's own
# round budget would allow.
SLACK_ASK_TIMEOUT = float(os.getenv("NAVFLOW_SLACK_ASK_TIMEOUT", "120"))


def _serve_ui(path: str):
    """The built console SPA: a real file if it exists, else index.html (client-side routing)."""
    if not UI_DIST.exists():
        return JSONResponse(
            {"detail": "console not built — run `npm install && npm run build` in ui/"},
            status_code=404)
    f = (UI_DIST / path).resolve()
    if path and f.is_file() and f.is_relative_to(UI_DIST.resolve()):
        return FileResponse(f)
    return FileResponse(UI_DIST / "index.html")


def _degraded_app(reason: str) -> FastAPI:
    """The app we serve when the store could not be opened. It exists so the failure reaches a
    human instead of ERR_CONNECTION_REFUSED: the console still loads and every data route answers
    503 with the reason, so the UI can name the problem. No runtime, no connectors, no ingest —
    nothing that would need the store. Restart once the DB is reachable again."""
    app = FastAPI(title="navflowd (degraded)")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                       allow_headers=["*"])

    @app.get("/health", include_in_schema=False)
    async def health():
        # HTTP 200 with status "down": a probe that can read the body learns WHAT is wrong, and the
        # console (which only ever reaches this daemon) can render it. Keys AuthGate depends on stay.
        body = {"status": "down", "detail": reason, "auth_required": bool(AUTH_TOKEN),
                "sources": [], "pct_used": None}
        if LOGIN_URL:
            body["login_url"] = LOGIN_URL
        return body

    async def unavailable():
        return JSONResponse({"detail": f"database unavailable — {reason}", "status": "down"},
                            status_code=503)

    # Everything that needs the store answers 503 (not a bare 500, and not the SPA's index.html).
    for _p in ("/api/{rest:path}", "/query", "/read", "/remember", "/catalog", "/catalog/{rest:path}",
               "/ingest/{rest:path}", "/v1/logs", "/v1/traces", "/v1/metrics"):
        app.add_api_route(_p, unavailable, include_in_schema=False,
                          methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])

    @app.get("/{path:path}", include_in_schema=False)
    async def ui(path: str):
        return _serve_ui(path)

    return app


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


class AgentIn(BaseModel):
    name: str
    trigger: str
    prompt: str                  # the only field a user edits — see docs/design/navflow-agents.md
    slack_webhook: str = ""


class ImportReq(BaseModel):
    yaml: str
    mode: str = "merge"    # merge (upsert) | replace (clear catalog first)


class AnthropicKeyIn(BaseModel):
    key: str    # blank-to-keep is not offered here: the only edits are "set a new one" or DELETE


class SlackTokenIn(BaseModel):
    token: str  # same contract as AnthropicKeyIn: set a new one, or DELETE to clear


class SlackSigningSecretIn(BaseModel):
    secret: str  # the signing secret behind POST /api/slack/events; same write-only contract


def make_app() -> FastAPI:
    try:
        store = Store(DB_PATH)
    except StoreUnavailable as e:
        # Losing the DB must not cost us the ability to SAY that we lost the DB. Log the full
        # traceback (degraded mode explains the failure to the user, it does not hide it from the
        # operator) and serve the console + 503s instead of exiting before uvicorn ever binds.
        traceback.print_exc()
        print(f"navflowd: DEGRADED — {e.reason}. Serving the console and 503s; fix the database "
              f"and restart.", flush=True)
        return _degraded_app(e.reason)

    # seed the DB catalog from YAML on first boot — or on every boot when CATALOG_SYNC is set, so
    # the file stays the source of truth (the admin interface for a read-only demo: edit + restart).
    if Path(CATALOG_PATH).exists() and (store.catalog_empty() or CATALOG_SYNC):
        counts = import_yaml_to_db(store, Path(CATALOG_PATH).read_text())
        how = "synced" if CATALOG_SYNC else "imported"
        print(f"navflowd: {how} {CATALOG_PATH} into catalog "
              f"({counts['sources']} sources, {counts['views']} views, {counts['triggers']} triggers)")

    dispatcher = Dispatcher(store)
    runtime = Runtime(store, dispatcher)
    # NavFlow agents are the second kind of subscriber to a firing (the first is an external agent's
    # webhook). In-process, so `navflow up` closes the loop with nothing to deploy.
    dispatcher.agents = AgentRunner(store, runtime)

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
    # Credentials: the env AUTH_TOKEN is the implicit root (admin, non-revocable), plus revocable
    # scoped keys in the api_keys table (docs/design/api-keys.md).
    _ADMIN_PATHS = ("/api/catalog/export", "/api/catalog/import", "/api/agent/chat")

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
        # /api/settings holds instance credentials (the Anthropic key): admin even to READ, since
        # a read tells you whether and where a credential is configured.
        if (path in _ADMIN_PATHS or path.startswith("/api/keys")
                or path.startswith("/api/discover") or path.startswith("/api/settings")):
            return "admin"
        if method != "GET" and (path.startswith("/api/sources") or path.startswith("/api/views")
                                or path.startswith("/api/triggers")
                                or path.startswith("/api/agents")):
            return "admin"
        return "read"

    def _resolve_credential(request) -> tuple[set, dict] | tuple[None, None]:
        """Token from the request -> (scopes, identity), or (None, None) if unknown/absent."""
        tok = _bearer(request.headers.get("authorization")) or request.headers.get("x-navflow-token", "")
        if not tok:
            return None, None
        if AUTH_TOKEN and tok == AUTH_TOKEN:
            return {"read", "ingest", "admin"}, {"id": "env:auth", "name": "auth token (env)"}
        key = store.find_api_key(hashlib.sha256(tok.encode()).hexdigest())
        if key:
            last = key.get("last_used_at")
            if last is None or (now_utc() - last).total_seconds() > 60:   # throttle write churn
                store.touch_api_key(key["id"])
            return set(key["scopes"]), {"id": f"key:{key['id']}", "name": key["name"]}
        return None, None

    # Auth off (no token) → no middleware, the instance is fully open (local default). Auth on →
    # every non-public route needs a credential carrying the required scope; ingest is gated exactly
    # like reads and management (admin implies all scopes).
    if AUTH_TOKEN:
        @app.middleware("http")
        async def _guard(request, call_next):
            required = _required_scope(request.method, request.url.path)
            if required is not None:
                scopes, ident = _resolve_credential(request)
                if not scopes:
                    return JSONResponse({"detail": "authentication required"}, status_code=401)
                if required != "any" and required not in scopes and "admin" not in scopes:
                    return JSONResponse({"detail": f"this credential lacks the {required!r} scope"},
                                        status_code=403)
                request.state.credential = ident
                request.state.scopes = sorted(scopes)
            return await call_next(request)

    def _err(e: Exception, code: int = 400):
        raise HTTPException(status_code=code, detail=str(e))

    # ── agent surface (unchanged contract; queries now logged) ───────────────
    @app.get("/health")
    async def health():
        """Liveness that actually touches the store, so a wedged DuckDB can't read as healthy to a
        k8s probe or the control plane's uptime check. `ok` / `degraded` (running, but nearly out of
        the configured storage) / `down` (the store stopped answering — restart needed). Always
        HTTP 200: the status and `detail` say what is wrong, which a bare 503 could not.
        `pct_used` is on /api/usage's 0-100 scale and is null when no limit is configured — unknown,
        never 0. The probe is a SELECT 1 plus a stat() of the db file; no table is scanned."""
        status, detail, pct = "ok", None, None
        try:
            store.ping()
        except Exception as e:
            status, detail = "down", f"database unavailable: {e}"
        if status == "ok" and MAX_DB_SIZE:
            pct = round(100 * store.disk_bytes() / MAX_DB_SIZE, 2)
            if pct >= DEGRADED_PCT:
                status = "degraded"
                detail = f"storage {pct}% full ({MAX_DB_SIZE} byte limit)"
        body = {"status": status, "auth_required": bool(AUTH_TOKEN),
                "sources": [] if AUTH_TOKEN else list(runtime.catalog.sources),
                "pct_used": pct}
        if detail:
            body["detail"] = detail
        if LOGIN_URL:
            # public, non-secret: where the logged-out console sends the browser to authenticate.
            body["login_url"] = LOGIN_URL
        return body

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
        url = req.url.strip()
        if url.startswith(SLACK_URL_PREFIX):
            # A Slack subscription is checked at creation, not at the first firing: an unroutable
            # channel or a missing token would otherwise surface hours later as a failed delivery
            # nobody is watching.
            try:
                url = slack_url(validate_slack_channel(url[len(SLACK_URL_PREFIX):]))
            except ValueError as e:
                _err(e)
            if not resolve_slack_token(store)[0]:
                _err(ValueError("no Slack bot token configured — set NAVFLOW_SLACK_BOT_TOKEN or "
                                "add one under Security before subscribing a channel"))
        sid = "sub_" + uuid.uuid4().hex[:8]
        # record the creating credential: revoking a key removes its subscriptions (a revoked
        # agent must stop receiving trigger dispatches)
        ident = getattr(request.state, "credential", None)
        store.add_subscription(sid, req.trigger, url, created_by=ident["id"] if ident else None)
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
            entry = {**entry, "config": redact_config(entry["connector"], entry["config"])}
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
        """Vercel verifies a drain endpoint via the x-vercel-verify response header — echo back the
        value it sends on its verification probe (how the Vercel drain flow actually verifies)."""
        val = request.headers.get("x-vercel-verify")
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

    # (there is no /api/security — whether auth is on is a boolean on /health; producers authenticate
    #  with scoped ingest API keys, not a shared token.)

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
        from importlib.metadata import version as _pkg_version
        try:
            ver = _pkg_version("navflow")   # the installed release (release.sh bumps pyproject.toml)
        except Exception:
            ver = None
        return {
            "version": ver,
            "discover_docker": shutil.which("docker") is not None or os.path.exists("/var/run/docker.sock"),
            # the Ask assistant runs on the same resolved key as NavFlow agents (env ANTHROPIC_API_KEY
            # or the console-stored key) — so once a key is set anywhere, the Ask chat stops
            # prompting for a browser-pasted one.
            "agent_key_configured": bool(resolve_anthropic_key(store)[0]),
            # gates the "subscribe a Slack channel" affordance on a trigger — offering it with no
            # bot token configured only leads to a 400.
            "slack_configured": bool(resolve_slack_token(store)[0]),
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
        return [{**s, "config": redact_config(s["connector"], s["config"]),
                 "health": health.get(s["name"])} for s in store.list_catalog_sources()]

    @app.get("/api/sources/{name}")
    async def get_source(name: str):
        for s in store.list_catalog_sources():
            if s["name"] == name:
                return {**s, "config": redact_config(s["connector"], s["config"]),
                        "health": runtime.health_snapshot().get(name)}
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
            # A client edits with the secret masked; if it saves the placeholder back unchanged,
            # keep the stored secret instead of overwriting it (see connectors.redact_config).
            config = normalize_config(
                body.connector, restore_secrets(body.connector, body.config, existing["config"]))
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
        # per-request header key wins (a user override); otherwise the same key NavFlow agents use
        # (env, or the console-stored key) — so a key set once under Agents/Security works here too.
        key = request.headers.get("x-anthropic-key", "").strip() or resolve_anthropic_key(store)[0]
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

    # ── management API: NavFlow agents (a prompt attached to a trigger) ──────
    # Definitions live under /api/agents/builtin; the roster of everything a trigger wakes (these
    # PLUS external subscribers) is /api/agents. A NavFlow agent is "enabled" exactly when it has a
    # subscription to its trigger — the same wiring an external agent has.
    def _agent_enabled(name: str) -> bool:
        return store.subscription_by_url(agent_url(name)) is not None

    def _agent_payload(body: AgentIn) -> dict:
        """Validate against the live catalog, including the loop guard (an agent may not be woken by
        the findings source it writes into)."""
        triggers = {t["name"]: t for t in store.list_catalog_triggers()}
        views = {v["name"]: v for v in store.list_catalog_views()}
        raw = body.model_dump()
        try:
            validate_agent_dict(raw, set(triggers), triggers, views)
        except CatalogError as e:
            _err(e)
        return raw

    @app.get("/api/agents/builtin")
    async def list_builtin_agents():
        """NavFlow agent definitions plus the state the UI needs to explain why one isn't running:
        no key configured is the common case on a fresh install and looks identical to "disabled"
        without this."""
        key, origin = resolve_anthropic_key(store)
        rows = []
        for a in store.list_catalog_agents():
            runs = store.list_agent_runs(a["name"], limit=1)
            rows.append({"name": a["name"], "trigger": a["trigger"], "prompt": a["prompt"],
                         "slack_configured": bool(a.get("slack_webhook")),
                         "enabled": _agent_enabled(a["name"]), "updated_at": a.get("updated_at"),
                         "last_run": runs[0] if runs else None})
        return {"agents": rows, "key_configured": bool(key), "key_source": origin,
                "presets": [{"id": k, **v} for k, v in AGENT_PRESETS.items()]}

    @app.post("/api/agents/builtin", status_code=201)
    async def create_builtin_agent(body: AgentIn):
        if store.get_catalog_agent(body.name) is not None:
            _err(ValueError(f"agent {body.name!r} already exists"), 409)
        _agent_payload(body)
        store.upsert_catalog_agent(body.name, body.trigger, body.prompt, body.slack_webhook)
        runtime.reload_catalog()
        return {"ok": True, "enabled": False,
                "note": "agents start disabled — enable it to run on the next firing"}

    @app.put("/api/agents/builtin/{name}")
    async def update_builtin_agent(name: str, body: AgentIn):
        existing = store.get_catalog_agent(name)
        if existing is None:
            _err(KeyError(f"unknown agent {name!r}"), 404)
        if body.name != name:
            _err(ValueError("renaming an agent is not supported; delete and recreate"), 400)
        _agent_payload(body)
        # blank-to-keep for the webhook, matching the connector-secret convention: the UI never
        # receives the stored URL back, so an unedited form must not wipe it.
        hook = body.slack_webhook or existing.get("slack_webhook", "")
        store.upsert_catalog_agent(name, body.trigger, body.prompt, hook)
        # if the trigger changed while enabled, re-point the subscription so the agent fires on the
        # new trigger (the subscription, not the definition, is what the dispatcher reads).
        if body.trigger != existing["trigger"] and _agent_enabled(name):
            store.remove_subscription_by_url(agent_url(name))
            store.add_subscription("sub_" + uuid.uuid4().hex[:8], body.trigger,
                                   agent_url(name), created_by="navflow")
        runtime.reload_catalog()
        return {"ok": True}

    @app.delete("/api/agents/builtin/{name}")
    async def delete_builtin_agent(name: str):
        if store.get_catalog_agent(name) is None:
            _err(KeyError(f"unknown agent {name!r}"), 404)
        store.remove_subscription_by_url(agent_url(name))   # unwire before dropping the definition
        store.delete_catalog_agent(name)
        runtime.reload_catalog()
        return {"ok": True}

    @app.post("/api/agents/builtin/{name}/enable")
    async def enable_builtin_agent(name: str):
        agent = store.get_catalog_agent(name)
        if agent is None:
            _err(KeyError(f"unknown agent {name!r}"), 404)
        key, _ = resolve_anthropic_key(store)
        if not key:
            _err(ValueError("no Anthropic key configured — set ANTHROPIC_API_KEY or add one "
                            "under Security before enabling an agent"))
        # enable = subscribe to the trigger (the same wiring an external agent has). Idempotent.
        if not _agent_enabled(name):
            store.add_subscription("sub_" + uuid.uuid4().hex[:8], agent["trigger"],
                                   agent_url(name), created_by="navflow")
        return {"ok": True, "enabled": True}

    @app.post("/api/agents/builtin/{name}/disable")
    async def disable_builtin_agent(name: str):
        if store.get_catalog_agent(name) is None:
            _err(KeyError(f"unknown agent {name!r}"), 404)
        store.remove_subscription_by_url(agent_url(name))
        return {"ok": True, "enabled": False}

    @app.get("/api/agents/builtin/{name}/runs")
    async def builtin_agent_runs(name: str, limit: int = 50):
        """The operational record — status, duration, errors. Distinct from findings, which are
        events on the entity's timeline; a failed run must never look like a conclusion."""
        if store.get_catalog_agent(name) is None:
            _err(KeyError(f"unknown agent {name!r}"), 404)
        return store.list_agent_runs(name, limit=min(limit, 200))

    # ── the Anthropic key: env wins, console is the fallback ─────────────────
    @app.get("/api/settings/anthropic-key")
    async def get_anthropic_key():
        """Never returns the key — only whether one is resolvable and where it came from, so the
        console can explain that an env-set key overrides what's stored."""
        key, origin = resolve_anthropic_key(store)
        return {"configured": bool(key), "source": origin,
                "stored": bool(store.get_setting("anthropic_key")),
                "env_overrides": origin.startswith("env:")}

    @app.put("/api/settings/anthropic-key")
    async def set_anthropic_key(body: AnthropicKeyIn):
        key = body.key.strip()
        if not key:
            _err(ValueError("key is required (use DELETE to remove the stored key)"))
        store.set_setting("anthropic_key", key)
        _, origin = resolve_anthropic_key(store)
        return {"ok": True, "source": origin,
                **({"note": "an environment key takes precedence and is still in use"}
                   if origin.startswith("env:") else {})}

    @app.delete("/api/settings/anthropic-key")
    async def clear_anthropic_key():
        store.set_setting("anthropic_key", None)
        key, origin = resolve_anthropic_key(store)
        return {"ok": True, "configured": bool(key), "source": origin}

    # ── the Slack bot token: same contract as the Anthropic key ──────────────
    # One token per instance, behind every slack:// subscription. It is a credential, so it is
    # write-only over the API exactly like the model key: the console can learn THAT one resolves
    # and where from, never what it is.
    @app.get("/api/settings/slack-bot-token")
    async def get_slack_token():
        token, origin = resolve_slack_token(store)
        return {"configured": bool(token), "source": origin,
                "stored": bool(store.get_setting(SLACK_TOKEN_SETTING)),
                "env_overrides": origin.startswith("env:")}

    @app.put("/api/settings/slack-bot-token")
    async def set_slack_token(body: SlackTokenIn):
        token = body.token.strip()
        if not token:
            _err(ValueError("token is required (use DELETE to remove the stored token)"))
        if not token.startswith("xox"):
            # Caught here rather than on the first failed delivery: a pasted webhook URL or signing
            # secret would otherwise sit in the settings table looking configured.
            _err(ValueError("that does not look like a Slack bot token — it should start with "
                            "'xoxb-' (OAuth & Permissions → Bot User OAuth Token)"))
        store.set_setting(SLACK_TOKEN_SETTING, token)
        _, origin = resolve_slack_token(store)
        return {"ok": True, "source": origin,
                **({"note": "an environment token takes precedence and is still in use"}
                   if origin.startswith("env:") else {})}

    @app.delete("/api/settings/slack-bot-token")
    async def clear_slack_token():
        store.set_setting(SLACK_TOKEN_SETTING, None)
        token, origin = resolve_slack_token(store)
        return {"ok": True, "configured": bool(token), "source": origin}

    # ── the Slack signing secret: the credential that makes inbound Slack safe ──
    # Same write-only contract as the bot token. Without it POST /api/slack/events answers 503:
    # there is no configuration in which accepting an unverified inbound request is correct.
    @app.get("/api/settings/slack-signing-secret")
    async def get_slack_signing_secret():
        secret, origin = slack_verify.resolve_secret(store)
        return {"configured": bool(secret), "source": origin,
                "stored": bool(store.get_setting(slack_verify.SETTING_KEY)),
                "env_overrides": origin.startswith("env:")}

    @app.put("/api/settings/slack-signing-secret")
    async def set_slack_signing_secret(body: SlackSigningSecretIn):
        secret = body.secret.strip()
        if not secret:
            _err(ValueError("secret is required (use DELETE to remove the stored secret)"))
        if secret.startswith("xox"):
            # A bot token pasted into the wrong box would look configured and fail every signature.
            _err(ValueError("that is a bot token, not the signing secret — take the Signing Secret "
                            "from the Slack app's Basic Information page"))
        store.set_setting(slack_verify.SETTING_KEY, secret)
        _, origin = slack_verify.resolve_secret(store)
        return {"ok": True, "source": origin,
                **({"note": "an environment secret takes precedence and is still in use"}
                   if origin.startswith("env:") else {})}

    @app.delete("/api/settings/slack-signing-secret")
    async def clear_slack_signing_secret():
        store.set_setting(slack_verify.SETTING_KEY, None)
        secret, origin = slack_verify.resolve_secret(store)
        return {"ok": True, "configured": bool(secret), "source": origin}

    # ── inbound Slack: the /navflow slash command ───────────────────────────
    # The only route in this daemon that is public to the auth middleware AND accepts a body from
    # the internet, so it carries its own authentication: an HMAC over the raw bytes.
    _ask_cap = slack_mod.AskCap()
    _ask_tasks: set = set()      # keeps background tasks referenced; asyncio only holds weak refs

    async def _slack_respond(response_url: str, body: dict) -> None:
        """Deliver one message to Slack's `response_url`. Best-effort with a couple of retries: the
        user is waiting, and there is nowhere else to put the answer if this fails."""
        for attempt in range(3):
            try:
                async with httpx.AsyncClient(timeout=10) as cx:
                    r = await cx.post(response_url, json=body)
                if r.status_code < 400:
                    return
                if r.status_code < 500:
                    print(f"navflowd: slack response_url rejected the answer: "
                          f"HTTP {r.status_code} {r.text[:200]}", flush=True)
                    return
            except Exception as e:
                print(f"navflowd: slack response_url failed: {type(e).__name__}: {e}", flush=True)
            if attempt < 2:
                await asyncio.sleep(1.0 * (attempt + 1))

    async def _slack_answer(question: str, response_url: str, thread_ts: str | None) -> None:
        """Run the Ask agent for one slash command and post the result. Never raises: this runs
        detached from the request, so an exception here would otherwise be pure silence in Slack."""
        from .agent import run_agent
        text, error = "", None
        try:
            key = resolve_anthropic_key(store)[0]
            self_headers = {"Authorization": f"Bearer {AUTH_TOKEN}"} if AUTH_TOKEN else {}
            async def _run():
                nonlocal text, error
                async for chunk in run_agent(key, [{"role": "user", "content": question}],
                                             "explore", None, self_headers):
                    for line in chunk.splitlines():
                        if not line.startswith("data: "):
                            continue
                        ev = json.loads(line[6:])
                        if ev.get("type") == "text":
                            text += ev.get("text") or ""
                        elif ev.get("type") == "error":
                            error = ev.get("detail") or "the assistant failed"
            await asyncio.wait_for(_run(), timeout=SLACK_ASK_TIMEOUT)
        except asyncio.TimeoutError:
            error = f"that took longer than {SLACK_ASK_TIMEOUT}s — try a narrower question"
        except Exception as e:   # noqa: BLE001 — every failure has to reach the user as words
            error = f"{type(e).__name__}: {e}"
        if text.strip():
            # Partial output plus an error still beats an error alone; say both.
            body = slack_mod.build_answer(question, text + (f"\n\n_{error}_" if error else ""),
                                          thread_ts)
        else:
            body = slack_mod.build_error(
                f":warning: {error or 'the assistant returned nothing to say'}", thread_ts)
        await _slack_respond(response_url, body)

    @app.post(SLACK_EVENTS_PATH, include_in_schema=False)
    async def slack_events(request: Request):
        """Slack's inbound endpoint: the URL-verification handshake and `/navflow ask …`.

        Two contracts shape this whole handler:

        · **The signature covers the RAW body.** Read `await request.body()` and parse afterwards —
          letting FastAPI decode and re-serialise changes the bytes and every HMAC fails.
        · **Slack allows 3 seconds to ACK.** A model call cannot make that, so anything that has to
          think ACKs immediately and posts the answer to `response_url` from a background task.
          Anything we already know (usage, no key, over the cap) is answered in the ACK itself.
        """
        raw = await request.body()
        secret, _origin = slack_verify.resolve_secret(store)
        if not secret:
            # Never "accept and hope". Refusing to serve is the only safe failure here.
            return JSONResponse({"detail": "Slack is not configured on this instance: set "
                                           f"{slack_verify.ENV_VAR} (or add the signing secret "
                                           "under Security) and try again"}, status_code=503)
        if (why := slack_verify.check(request.headers, raw, secret)) is not None:
            # The reason goes to the operator's log, not to the caller: telling a forger which part
            # of their forgery failed is free help.
            print(f"navflowd: rejected an inbound Slack request ({why})", flush=True)
            return JSONResponse({"detail": "invalid Slack signature"}, status_code=401)

        ctype = request.headers.get("content-type", "")
        if "json" in ctype:
            try:
                body = json.loads(raw or b"{}")
            except ValueError:
                return JSONResponse({"detail": "malformed JSON"}, status_code=400)
            if body.get("type") == "url_verification":
                # Without this the Slack app can never be pointed at this daemon at all.
                return {"challenge": body.get("challenge", "")}
            # Event subscriptions are out of scope (slash command only) — ACK so Slack doesn't
            # retry, and say nothing.
            return {"ok": True}

        form = {k: v[0] for k, v in parse_qs(raw.decode("utf-8", "replace")).items()}
        response_url = (form.get("response_url") or "").strip()
        thread_ts = (form.get("thread_ts") or "").strip() or None
        question, problem = slack_mod.parse_command(form.get("text", ""))
        if problem:
            return slack_mod.build_error(problem, thread_ts)
        if not response_url:
            return slack_mod.build_error(
                ":warning: that request carried no response_url — NavFlow has nowhere to reply",
                thread_ts)
        if not resolve_anthropic_key(store)[0]:
            return slack_mod.build_error(
                ":warning: no Anthropic API key is configured on this NavFlow instance — set "
                "`ANTHROPIC_API_KEY` or add one under Security in the console", thread_ts)
        if not runtime.catalog.sources:
            return slack_mod.build_error(
                ":warning: this NavFlow instance has no sources configured yet, so there is "
                "nothing to ask about", thread_ts)
        if not _ask_cap.take(form.get("team_id", ""), form.get("user_id", "")):
            return slack_mod.build_error(
                f":warning: you've hit the cap of {_ask_cap.cap} NavFlow questions in 24h "
                "(NAVFLOW_SLACK_DAILY_CAP)", thread_ts)

        task = asyncio.create_task(_slack_answer(question, response_url, thread_ts))
        _ask_tasks.add(task)
        task.add_done_callback(_ask_tasks.discard)
        # The ACK Slack shows while we think; the answer replaces it via response_url.
        ack = {"response_type": "ephemeral", "text": ":hourglass_flowing_sand: asking NavFlow…"}
        if thread_ts:
            ack["thread_ts"] = thread_ts
        return ack

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
        """(name, masked display URL) for a subscriber endpoint. A NavFlow agent's URL carries its
        real name and no secret, so it's shown verbatim; a Slack channel likewise. An external hook
        URL is the identity but carries a secret in the path, so it's anonymized (deterministic
        name) and the last path segment masked."""
        from .config import agent_name_from_url
        internal = agent_name_from_url(url.rstrip("/"))
        if internal is not None:
            return internal, "in-process (NavFlow agent)"
        channel = slack_channel_from_url(url.rstrip("/"))
        if channel is not None:
            # The channel IS the identity and holds no secret (the token does), so it's shown as
            # written — a raw slack://channel/C0123456 URL in the roster reads like a bug.
            return f"#{channel}", "Slack channel"
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
    async def agent_roster():
        """The roster of everything a trigger wakes: NavFlow agents (run in-process) and connected
        external agents (webhooks), one row each, tagged by `kind`. Both are subscriptions, so both
        appear here identically — wiring (triggers), delivery health, recent wakes."""
        stats = store.delivery_stats()
        agents: dict[str, dict] = {}
        for sub in store.all_subscriptions():
            norm = sub["url"].rstrip("/")
            a = agents.get(norm)
            if a is None:
                from .config import agent_name_from_url
                name, masked = _agent_identity(norm)
                kind = ("navflow" if agent_name_from_url(norm) is not None
                        else "slack" if slack_channel_from_url(norm) is not None
                        else "connected")
                st = stats.get(sub["url"], stats.get(norm, {}))
                a = agents[norm] = {
                    "name": name, "endpoint": masked, "kind": kind,
                    "subscriptions": [], "triggers": [], "created_by": set(),
                    "first_seen": sub["created_at"],
                    # windowed counts are what the roster shows (an all-time total next to a
                    # "last woken" of weeks ago reads as busy); totals ride along for context.
                    "delivered_ok_24h": st.get("ok", 0), "delivered_fail_24h": st.get("fail", 0),
                    "delivered_ok_total": st.get("ok_total", 0),
                    "delivered_fail_total": st.get("fail_total", 0),
                    "pending": st.get("pending", 0), "last_woken": st.get("last_at"),
                    # currently failing: the most recent delivery to this endpoint did not succeed —
                    # deliberately over ALL deliveries, so a failing endpoint that has gone quiet
                    # doesn't quietly go healthy when it falls out of the window.
                    "unhealthy": st.get("fail_total", 0) > 0 and not st.get("last_ok", True),
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
    async def catalog_export(sources: str | None = None, include_secrets: bool = False):
        """Catalog YAML. Defaults (no params, as the agent/MCP call it): all sources, secrets
        OMITTED. `sources=a,b` limits to a subset (views/triggers filtered to stay consistent);
        `include_secrets=true` emits real connector secrets (admin-gated route)."""
        src = [s for s in sources.split(",") if s] if sources else None
        return PlainTextResponse(export_db_to_yaml(store, src, include_secrets),
                                 media_type="application/yaml")

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

    # ── metering ──────────────────────────────────────────────────────────────
    @app.get("/api/usage")
    async def usage():
        """What this instance is using: db + WAL bytes, the volume they sit on, and event counts.
        `max_bytes` is what the operator says this instance may grow to (NAVFLOW_MAX_DB_SIZE — a
        hosted cell gets its PVC size); unset -> null, and nothing is enforced here either way.
        `pct_used` is (db + wal) over max_bytes on a 0-100 scale, NOT a 0-1 fraction — so a
        "warn at 80%" consumer compares against 80, not 0.8. Null whenever max_bytes is null.
        Cheap by construction: file stats plus the maintained per-source counters, no table scan,
        so the cost does not grow with the event count."""
        u = store.usage()
        try:
            du = shutil.disk_usage(os.path.dirname(os.path.abspath(DB_PATH)) or ".")
            disk_total, disk_free = du.total, du.free
        except OSError:
            disk_total = disk_free = None
        used = u["db_bytes"] + u["wal_bytes"]
        return {**u, "disk_total": disk_total, "disk_free": disk_free,
                "max_bytes": MAX_DB_SIZE,
                "pct_used": round(100 * used / MAX_DB_SIZE, 2) if MAX_DB_SIZE else None}

    # ── console UI (built SPA; catch-all registered last so API routes win) ──
    @app.get("/{path:path}", include_in_schema=False)
    async def ui(path: str):
        return _serve_ui(path)

    return app

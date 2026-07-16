"""Connector registry — maps catalog `connector:` names to implementations.

SPECS describes each connector's config surface so the UI can render forms and validate input
without hardcoding connector knowledge — the registry is self-describing (GET /api/connectors).
Field types: string | number | json. `required` fields gate source creation.
"""
from __future__ import annotations

import re as _re

from ..config import CatalogError
from .alerts import AlertsConnector
from .base import UNIVERSAL_CONFIG
from .claude_code import ClaudeCodeConnector
from .docker_logs import DockerLogsConnector
from .github import GithubConnector
from .memory import MemoryConnector
from .otlp import OtlpConnector
from .postgres import PostgresConnector
from .prometheus import PrometheusConnector
from .static import StaticConnector
from .vercel import VercelConnector
from .webhook import WebhookConnector

REGISTRY = {
    "prometheus": PrometheusConnector,
    "docker_logs": DockerLogsConnector,
    "alerts": AlertsConnector,
    "static": StaticConnector,
    "webhook": WebhookConnector,
    "memory": MemoryConnector,
    "otlp": OtlpConnector,
    "github": GithubConnector,
    "vercel": VercelConnector,
    "postgres": PostgresConnector,
    "claude_code": ClaudeCodeConnector,
}

# Connector metadata for the UI. The `fields` of each are GENERATED from the connector's
# CONFIG_SCHEMA at the bottom of this module (single source of truth — no parallel definition).
SPECS = {
    "prometheus": {"label": "Prometheus", "mode": "poll", "discover": True,
                   "description": "Instant-query snapshots of PromQL expressions on every poll tick."},
    "docker_logs": {"label": "Docker logs", "mode": "poll", "discover": True,
                    "description": "Tails a running container's logs — all lines by default; "
                                   "optional match/drop regex filters."},
    "alerts": {"label": "Synthesized alerts", "mode": "poll",
               "description": "Evaluates a PromQL ratio each poll; emits an alert event past the threshold."},
    "static": {"label": "Static records", "mode": "poll",
               "description": "One-time import of inline records (file-shaped fixtures, demo data)."},
    "webhook": {"label": "Inbound webhook", "mode": "push",
                "description": "Push ingestion: producers POST JSON (or NDJSON) to this source's "
                               "ingest endpoint. Lossless; declare labels to map payload fields "
                               "into the envelope."},
    "memory": {"label": "Agent memory", "mode": "push",
               "description": "The agent's own observations, written back via the `remember` MCP tool "
                              "(or POST /remember). Joinable into views like any other source."},
    "otlp": {"label": "OpenTelemetry (OTLP)", "mode": "push",
             "description": "Receives OTLP/HTTP logs, traces and metrics at POST /v1/{logs,traces,"
                            "metrics}. One source ingests every service; resource attributes "
                            "(service.name) become labels."},
    "github": {"label": "GitHub commits", "mode": "poll", "discover": True, "poll": "2m",
               "description": "Polls a repo's commits (cursor by SHA); one event per commit, "
                              "keyed by repo, with author as a label."},
    "vercel": {"label": "Vercel logs", "mode": "push",
               "description": "Push source for Vercel logs — point a Vercel log drain (JSON) at this "
                              "source's ingest endpoint; one event per log entry, keyed by project, "
                              "with environment + source labels."},
    "postgres": {"label": "Postgres table", "mode": "poll", "discover": True, "poll": "30s",
                 "description": "Polls a table incrementally (cursor by an id or updated_at); one "
                                "event per new/changed row, keyed by an entity column (tenant_id). "
                                "Your application's source-of-truth data in the timeline."},
    "claude_code": {"label": "Claude Code sessions", "mode": "poll",
                    "description": "Tails local Claude Code session transcripts "
                                   "(~/.claude/projects/*.jsonl) into the data plane — one event per "
                                   "message, keyed by session, with project/branch/model labels and "
                                   "token-usage fields. Sub-agents roll up into the same source. "
                                   "Secrets are redacted before storage."},
}


# A source's signal type is a property of its connector, not something the user authors.
# (Design doc's five source types; the MVP only distinguishes these three.)
_SOURCE_TYPES = {"docker_logs": "application_log", "memory": "agent_memory",
                 "otlp": "application_log", "vercel": "application_log",
                 "claude_code": "agent_session"}


def source_type_for(connector: str) -> str:
    return _SOURCE_TYPES.get(connector, "event_stream")


# ── connector config schema = the source of truth (form, discover, YAML, API all normalize to it)

def full_schema(connector: str) -> dict | None:
    """A connector's complete config schema (its own + the universal keys), or None if it hasn't
    declared one (those connectors keep their hand-written SPECS and skip normalization)."""
    schema = getattr(REGISTRY.get(connector), "CONFIG_SCHEMA", None)
    return {**schema, **UNIVERSAL_CONFIG} if schema is not None else None


_LABEL_NAME = _re.compile(r"^[A-Za-z0-9_]+$")


def _coerce_labels(val) -> list:
    out, primaries = [], 0
    for spec in val:
        if not isinstance(spec, dict) or not spec.get("name"):
            raise CatalogError(f"label needs a name (got {spec!r})")
        if not _LABEL_NAME.match(str(spec["name"])):
            raise CatalogError(f"label name {spec['name']!r} must be alphanumeric/_")
        if ("const" in spec) == ("field" in spec):
            raise CatalogError(f"label {spec['name']!r} needs exactly one of const or field")
        row = {"name": str(spec["name"]),
               **({"const": str(spec["const"])} if "const" in spec else {"field": str(spec["field"])})}
        if spec.get("primary"):       # the primary label is the entity key
            row["primary"] = True
            primaries += 1
        out.append(row)
    if primaries > 1:
        raise CatalogError("at most one label can be primary (the key)")
    return out


def _coerce(spec: dict, val):
    t = spec["type"]
    if t == "string":
        return str(val)
    if t == "number":
        f = float(val)
        return int(f) if f.is_integer() else f
    if t == "bool":
        return bool(val)
    if t == "labels":
        return _coerce_labels(val)
    if t == "list":
        return [_normalize_against(spec["item"], e, "list item") for e in val]
    return val


def _normalize_against(schema: dict, raw, where: str) -> dict:
    """Terse-canonicalize `raw` against a (sub)schema: schema key order, type-coerced, required
    enforced, defaults dropped, unknown keys rejected."""
    if not isinstance(raw, dict):
        raise CatalogError(f"{where}: expected an object, got {raw!r}")
    out = {}
    for key, spec in schema.items():
        val = raw.get(key)
        if val is None or val == "" or val == []:
            if spec.get("required"):
                raise CatalogError(f"{where}: {key!r} is required")
            continue
        cval = _coerce(spec, val)
        if "default" in spec and cval == spec["default"]:
            continue  # omit values equal to their default (terse but deterministic)
        out[key] = cval
    unknown = set(raw) - set(schema)
    if unknown:
        raise CatalogError(f"{where}: unknown keys {sorted(unknown)}")
    return out


def normalize_config(connector: str, raw: dict) -> dict:
    """Canonical config for a source: every entry path runs through this, so a source set up by
    hand, via Discover, via YAML, or via the API all produce the identical stored config (and so
    the identical exported YAML). Connectors without a declared schema pass through unchanged."""
    schema = full_schema(connector)
    if schema is None:
        return raw or {}
    return _normalize_against(schema, raw or {}, f"connector {connector!r}")


def _fields_from_schema(schema: dict) -> list:
    """SPECS form fields generated from a config schema (labels get the form's own editor).
    A `list` field carries its `item` sub-fields so the UI can render a row-by-row builder."""
    def scalar(name, spec):
        ftype = "number" if spec["type"] == "number" else "string"
        return {"name": name, "type": ftype, "required": spec.get("required", False),
                "help": spec.get("help", ""), "secret": spec.get("secret", False),
                "discover_input": spec.get("discover_input", False)}

    fields = []
    for name, spec in schema.items():
        if spec["type"] == "labels" or spec.get("advanced"):
            continue  # labels get the dedicated editor; advanced/legacy keys are kept in the
                      # schema (so they round-trip) but hidden from the form — set via a primary label
        if spec["type"] == "list":
            fields.append({"name": name, "type": "list", "required": spec.get("required", False),
                           "help": spec.get("help", ""),
                           "item": [scalar(k, v) for k, v in spec.get("item", {}).items()]})
        elif spec["type"] == "object":
            fields.append({"name": name, "type": "json", "required": spec.get("required", False),
                           "help": spec.get("help", "")})
        else:
            fields.append(scalar(name, spec))
    return fields


# Every connector's SPECS form fields are generated from its CONFIG_SCHEMA (single source of truth).
# `provides` (a connector's synthesized label fields) is surfaced so the form can offer them.
for _name, _conn in REGISTRY.items():
    if getattr(_conn, "CONFIG_SCHEMA", None) is not None:
        SPECS[_name]["fields"] = _fields_from_schema(full_schema(_name))
    _provides = getattr(_conn, "PROVIDES", None)
    if _provides:
        SPECS[_name]["provides"] = _provides


def build_connector(cfg, store):
    return REGISTRY[cfg.connector](cfg, store)

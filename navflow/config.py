"""Load and type the catalog YAML — the MVP stand-in for the design doc's Catalog Service.

Declares the sources (what to ingest and how), the views (named query shapes), and the triggers
(conditions that fire a push). Coral-style declarative config, not a service.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field as dc_field
from functools import lru_cache
from pathlib import Path

import yaml

_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def parse_duration(s) -> float:
    """'5s' -> 5.0, '15m' -> 900.0, '6h' -> 21600.0."""
    s = str(s).strip()
    return float(s[:-1]) * _UNITS[s[-1]]


@dataclass
class SourceCfg:
    name: str
    type: str
    connector: str
    poll_seconds: float
    config: dict = dc_field(default_factory=dict)
    poll: str = "5s"          # original duration string, kept for round-tripping
    paused: bool = False
    ingest_key: str = ""      # stable unguessable path segment for push endpoints (/ingest/<key>)


@dataclass
class ViewCfg:
    name: str
    key_field: str
    sources: list
    filters: list = dc_field(default_factory=list)   # [{field, op, value}] applied on read + trigger eval
    created_by: str = "human"                        # "human" | "agent:<client>" (design doc §6.5)


@dataclass
class Condition:
    aggregate: str          # count | sum | avg | max | min | any
    predicate: str          # "> 1.0", ">= 100", "== 0"
    window: str             # "1m", "5m"
    field: str | None = None
    group_by: list = dc_field(default_factory=lambda: ["key_value"])


@dataclass
class TriggerCfg:
    name: str
    view: str
    condition: Condition
    emit: dict = dc_field(default_factory=dict)
    cooldown_seconds: float = 300.0


@dataclass
class Catalog:
    sources: dict   # name -> SourceCfg
    views: dict     # name -> ViewCfg
    triggers: list  # [TriggerCfg]


def _source_from_dict(s: dict) -> SourceCfg:
    from .connectors import source_type_for  # late import: connectors import config
    poll = str(s.get("poll", "5s"))
    # type is derived from the connector, not authored (any provided `type` is ignored)
    return SourceCfg(
        name=s["name"], type=source_type_for(s["connector"]), connector=s["connector"],
        poll_seconds=parse_duration(poll), config=s.get("config", {}) or {},
        poll=poll, paused=bool(s.get("paused", False)), ingest_key=s.get("ingest_key") or "",
    )


def _view_from_dict(v: dict) -> ViewCfg:
    return ViewCfg(
        name=v["name"], key_field=v["key_field"], sources=v["sources"],
        filters=v.get("filters", []) or [],
        created_by=v.get("created_by") or "human",
    )


def _trigger_from_dict(t: dict) -> TriggerCfg:
    c = t["condition"]
    return TriggerCfg(
        name=t["name"], view=t["view"],
        condition=Condition(
            aggregate=c["aggregate"], predicate=c["predicate"], window=c["window"],
            field=c.get("field"), group_by=c.get("group_by", ["key_value"]),
        ),
        emit=t.get("emit", {}) or {},
        cooldown_seconds=parse_duration(t.get("cooldown", "5m")),
    )


def load_catalog(path) -> Catalog:
    raw = yaml.safe_load(Path(path).read_text())

    sources = {s["name"]: _source_from_dict(s) for s in raw.get("sources", [])}

    views = {v["name"]: _view_from_dict(v) for v in raw.get("views", [])}

    triggers = [_trigger_from_dict(t) for t in raw.get("triggers", [])]

    return Catalog(sources=sources, views=views, triggers=triggers)


# ── DB-backed catalog (the YAML above becomes import/export) ─────────────────

def catalog_from_db(store) -> Catalog:
    """Build the typed Catalog from the store's catalog tables."""
    sources = {}
    for s in store.list_catalog_sources():
        sources[s["name"]] = _source_from_dict(s)

    views = {v["name"]: _view_from_dict(v) for v in store.list_catalog_views()}

    triggers = []
    for t in store.list_catalog_triggers():
        triggers.append(_trigger_from_dict(
            {"name": t["name"], "view": t["view"], "condition": t["condition"],
             "emit": t["emit"], "cooldown": t["cooldown"]}))

    return Catalog(sources=sources, views=views, triggers=triggers)


def import_yaml_to_db(store, text: str) -> dict:
    """Validate and write a YAML catalog into the store. Returns counts."""
    raw = yaml.safe_load(text) or {}
    sources = raw.get("sources", []) or []
    views = raw.get("views", []) or []
    triggers = raw.get("triggers", []) or []

    # validate the whole document before writing anything
    names = {s["name"] for s in sources}
    for s in sources:
        validate_source_dict(s)
    for v in views:
        validate_view_dict(v, names)
    view_names = {v["name"] for v in views} | {v["name"] for v in store.list_catalog_views()}
    for t in triggers:
        validate_trigger_dict(t, view_names)

    from .connectors import normalize_config, source_type_for
    for s in sources:
        store.upsert_catalog_source(
            s["name"], source_type_for(s["connector"]), s["connector"], str(s.get("poll", "5s")),
            normalize_config(s["connector"], s.get("config", {}) or {}),
            bool(s.get("paused", False)), ingest_key=s.get("ingest_key"))
    for v in views:
        store.upsert_catalog_view(v["name"], v["key_field"], v["sources"],
                                  v.get("filters", []) or [],
                                  v.get("created_by") or "human")
    for t in triggers:
        store.upsert_catalog_trigger(
            t["name"], t["view"], t["condition"], t.get("emit", {}) or {},
            str(t.get("cooldown", "5m")))

    return {"sources": len(sources), "views": len(views), "triggers": len(triggers)}


def export_db_to_yaml(store) -> str:
    doc = {
        "sources": [
            {"name": s["name"], "connector": s["connector"],  # type is derived from the connector
             "poll": s["poll"], "config": s["config"]}
            for s in store.list_catalog_sources()
        ],
        "views": [
            {"name": v["name"], "key_field": v["key_field"], "sources": v["sources"],
             **({"filters": v["filters"]} if v.get("filters") else {}),
             **({"created_by": v["created_by"]} if v.get("created_by", "human") != "human" else {})}
            for v in store.list_catalog_views()
        ],
        "triggers": [
            {"name": t["name"], "view": t["view"], "condition": t["condition"],
             "emit": t["emit"], "cooldown": t["cooldown"]}
            for t in store.list_catalog_triggers()
        ],
    }
    return yaml.safe_dump(doc, sort_keys=False, default_flow_style=False)


# ── validation (shared by the API and YAML import) ───────────────────────────

class CatalogError(ValueError):
    pass


_AGGREGATES = {"count", "sum", "avg", "max", "min", "any"}
_PREDICATE_SYMS = (">=", "<=", "==", ">", "<")


def _check_duration(value, label: str) -> None:
    try:
        parse_duration(value)
    except Exception:
        raise CatalogError(f"{label}: {value!r} is not a duration (use e.g. '5s', '15m', '1h')")


@lru_cache(maxsize=256)
def _compiled(pattern: str):
    return re.compile(pattern)


# Group-reference styles accepted in a label's `replace`: sed/Python (\1, \g<1>) and JS/PCRE
# ($1, ${1}). The $-forms are translated to Python before substituting.
_DOLLAR_GROUP = re.compile(r"\$\{(\d+)\}|\$(\d+)")
_GROUP_REF = re.compile(r"\$\{?\d|\\g?<?\d")


def _to_py_replace(replace: str) -> str:
    """Accept JS/PCRE `$1`/`${1}` (and `$$` → a literal `$`) in a replacement, alongside `\\1`."""
    protected = replace.replace("$$", "\x00")
    subbed = _DOLLAR_GROUP.sub(lambda m: f"\\g<{m.group(1) or m.group(2)}>", protected)
    return subbed.replace("\x00", "$")


def _normalize_value(spec: dict, raw: str) -> str | None:
    """Value normalization for one field label: regex substitution first, exact-alias map second
    (map keys are written against the cleaned form). Fail-open: any error keeps the raw value —
    the lossless payload always preserves the original, so normalization is never destructive.

    A `replace` that references a capture group (`\\1` or `$1`) is treated as an EXTRACTION: if the
    pattern doesn't match this value, the label doesn't apply, so return None (the label is dropped
    for this event). A `replace` with no group reference is a plain substitution/cleanup and keeps
    the original value on no-match, as before."""
    v = raw
    try:
        pattern = spec.get("pattern")
        if pattern:
            raw_replace = spec.get("replace", "")
            v, n = _compiled(pattern).subn(_to_py_replace(raw_replace), v)
            if n == 0 and _GROUP_REF.search(raw_replace):
                return None                       # extraction whose pattern didn't match → omit
        m = spec.get("map")
        if m:
            v = m.get(v, v)
    except Exception:
        return raw
    return v


def extract_labels(specs, context: dict | None = None) -> dict:
    """Build an event's label map from a source's `labels` config and a per-event context dict.

    Each spec is {name, const} (fixed value) or {name, field} (read context[field]). The context
    is whatever the connector exposes per event — a webhook payload, a Prometheus series' label
    set, named groups parsed from a log line. A label whose source value is absent is omitted.
    """
    ctx = context or {}
    out = {}
    for spec in specs or []:
        name = spec.get("name")
        if not name:
            continue
        if "const" in spec:
            tv = _coerce_type(spec, str(spec["const"]))
            if tv is not None:
                out[name] = tv
        elif "field" in spec:
            v = ctx.get(spec["field"]) if isinstance(ctx, dict) else None
            if v is None and isinstance(ctx, dict) and "." in str(spec["field"]):
                # dotted path into a nested context (the field profile shows e.g. metric.service;
                # promoting that name must extract it too)
                head, _, tail = str(spec["field"]).partition(".")
                sub = ctx.get(head)
                if isinstance(sub, dict):
                    v = sub.get(tail)
            if v is not None:
                nv = _normalize_value(spec, str(v))
                if nv is not None:               # extraction that didn't match drops the label
                    tv = _coerce_type(spec, nv)
                    if tv is not None:           # number-typed but not a number → drop the label
                        out[name] = tv
    return out


def _coerce_type(spec: dict, value: str):
    """Apply a label's declared `type`. Default is string. A `number` label stores an actual
    number (so it can be aggregated) — or None if the value isn't numeric, which drops the label
    for this event (numbers are chosen intentionally, never guessed)."""
    if spec.get("type") == "number":
        try:
            f = float(value)
        except (TypeError, ValueError):
            return None
        return int(f) if f.is_integer() else f
    return str(value)


def _validate_labels(s: dict) -> None:
    specs = s.get("config", {}).get("labels") if isinstance(s.get("config"), dict) else None
    for spec in specs or []:
        if not isinstance(spec, dict) or not spec.get("name"):
            raise CatalogError(f"source {s['name']!r}: each label needs a name (got {spec!r})")
        if not re.match(r"^[A-Za-z0-9_]+$", str(spec["name"])):
            raise CatalogError(
                f"source {s['name']!r}: label name {spec['name']!r} must be alphanumeric/_")
        if ("const" in spec) == ("field" in spec):
            raise CatalogError(
                f"source {s['name']!r}: label {spec['name']!r} needs exactly one of "
                f"const (fixed value) or field (extract from the event)")
        if spec.get("type") not in (None, "string", "number"):
            raise CatalogError(
                f"source {s['name']!r}: label {spec['name']!r} type must be 'string' or 'number'")
        if spec.get("type") == "number" and spec.get("primary"):
            raise CatalogError(
                f"source {s['name']!r}: the primary (key) label {spec['name']!r} must be a string")
    if sum(1 for spec in (specs or []) if spec.get("primary")) > 1:
        raise CatalogError(f"source {s['name']!r}: at most one label can be primary (the key)")


def validate_source_dict(s: dict) -> None:
    from .connectors import REGISTRY  # late import: connectors import config
    # `type` is no longer required — it's derived from the connector.
    for field in ("name", "connector"):
        if not s.get(field):
            raise CatalogError(f"source is missing required field {field!r}")
    if s["connector"] not in REGISTRY:
        raise CatalogError(
            f"source {s['name']!r}: unknown connector {s['connector']!r} "
            f"(available: {', '.join(sorted(REGISTRY))})")
    _check_duration(s.get("poll", "5s"), f"source {s['name']!r} poll")
    if not isinstance(s.get("config", {}) or {}, dict):
        raise CatalogError(f"source {s['name']!r}: config must be a mapping")
    _validate_labels(s)


_FILTER_OPS = {"eq", "neq", "contains", "gt", "lt", "gte", "lte"}
_FILTER_FIELD_RE = re.compile(r"^[A-Za-z0-9_.]+$")   # dots: raw payload fields (OTLP et al.)


def validate_view_dict(v: dict, source_names: set) -> None:
    # key_field is optional now — labels make a single primary key non-essential; a view just
    # correlates its sources, and the query picks which label(s) to slice by.
    for field in ("name", "sources"):
        if not v.get(field):
            raise CatalogError(f"view is missing required field {field!r}")
    unknown = set(v["sources"]) - source_names
    if unknown:
        raise CatalogError(f"view {v['name']!r}: unknown sources {sorted(unknown)}")
    for f in v.get("filters", []) or []:
        if not isinstance(f, dict) or not all(k in f for k in ("field", "op", "value")):
            raise CatalogError(
                f"view {v['name']!r}: each filter needs field, op and value (got {f!r})")
        if not _FILTER_FIELD_RE.match(str(f["field"])):
            raise CatalogError(
                f"view {v['name']!r}: filter field {f['field']!r} must be alphanumeric/_/.")
        if f["op"] not in _FILTER_OPS:
            raise CatalogError(
                f"view {v['name']!r}: filter op must be one of {sorted(_FILTER_OPS)}")
        if f["op"] in ("gt", "lt", "gte", "lte"):
            try:
                float(f["value"])
            except (TypeError, ValueError):
                raise CatalogError(
                    f"view {v['name']!r}: filter op {f['op']!r} needs a numeric value")


def validate_trigger_dict(t: dict, view_names: set) -> None:
    for field in ("name", "view", "condition"):
        if not t.get(field):
            raise CatalogError(f"trigger is missing required field {field!r}")
    if t["view"] not in view_names:
        raise CatalogError(f"trigger {t['name']!r}: unknown view {t['view']!r}")
    c = t["condition"]
    if c.get("aggregate") not in _AGGREGATES:
        raise CatalogError(
            f"trigger {t['name']!r}: aggregate must be one of {sorted(_AGGREGATES)}")
    pred = str(c.get("predicate", "")).strip()
    for sym in _PREDICATE_SYMS:
        if pred.startswith(sym):
            try:
                float(pred[len(sym):].strip())
            except ValueError:
                raise CatalogError(
                    f"trigger {t['name']!r}: predicate {pred!r} has no numeric threshold")
            break
    else:
        raise CatalogError(
            f"trigger {t['name']!r}: predicate {pred!r} must start with one of "
            f"{', '.join(_PREDICATE_SYMS)}")
    _check_duration(c.get("window", "1m"), f"trigger {t['name']!r} window")
    _check_duration(t.get("cooldown", "5m"), f"trigger {t['name']!r} cooldown")
    if c.get("aggregate") != "count" and not c.get("field"):
        raise CatalogError(
            f"trigger {t['name']!r}: condition needs a field for aggregate {c['aggregate']!r}")

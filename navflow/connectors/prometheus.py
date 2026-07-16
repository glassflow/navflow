"""Prometheus connector — polls the instant-query API, one Envelope per result series.

Stores every non-null sample (lossless); the view and triggers decide what's interesting.

`discover()` introspects a Prometheus and proposes a source config (which metrics to ingest
raw, a suggested entity key, labels, and type-aware derived suggestions) — deterministically,
no LLM. "Raw ingest" is just a bare-metric-name PromQL, so the proposal is an ordinary config
the poll loop above already understands.
"""
from __future__ import annotations

import re

import httpx

from ..envelope import Envelope, now_utc
from .base import Connector

_BAD = ("NaN", "+Inf", "-Inf")

# Prometheus/runtime internals hidden from discovery by default (still ingestable if asked).
_INTERNAL = re.compile(r"^(go_|process_|prometheus_|scrape_|net_|promhttp_|python_)")
# Labels that make a good entity key, best first. The first present with >1 value wins.
_KEY_PRIORITY = ["service", "tenant", "tenant_id", "namespace", "pod", "app", "instance", "job"]
# Standard/structural labels we don't propose as NavFlow labels.
_LABEL_SKIP = {"le", "instance", "job"}


class PrometheusConnector(Connector):
    # The authoritative config schema — the source of truth every entry path (form, discover,
    # YAML, API) normalizes to. `SPECS["prometheus"].fields` is generated from it.
    CONFIG_SCHEMA = {
        "url": {"type": "string", "required": True, "discover_input": True,
                "help": "Prometheus base URL, e.g. http://localhost:9090"},
        "default_key": {"type": "string", "default": "unknown",
                        "help": "entity key for series that carry no key label"},
        "queries": {
            "type": "list", "required": True,
            "help": "metrics to ingest — each a PromQL query mapped into the envelope",
            "item": {
                "promql": {"type": "string", "required": True,
                           "help": "PromQL (a bare metric name = raw, lossless ingest)"},
                "event_type": {"type": "string", "default": "metric"},
                "field": {"type": "string", "default": "value",
                          "help": "fields.<name> the numeric value is stored under"},
                "text": {"type": "string", "default": "{key} {field}={val}"},
                "key_label": {"type": "string",
                              "help": "series label to read the entity key from, e.g. service"},
            },
        },
    }

    async def poll(self):
        url = self.cfg.config["url"].rstrip("/") + "/api/v1/query"
        default_key = self.cfg.config.get("default_key", "unknown")
        out = []
        async with httpx.AsyncClient(timeout=10) as cx:
            for q in self.cfg.config.get("queries", []):
                try:
                    resp = await cx.get(url, params={"query": q["promql"]})
                    series = resp.json().get("data", {}).get("result", [])
                except Exception:
                    continue
                key_label = q.get("key_label")
                field = q.get("field", "value")
                for s in series:
                    raw = s.get("value", [None, None])[1]
                    if raw in _BAD or raw is None:
                        continue
                    val = float(raw)
                    metric = s.get("metric", {})
                    fallback = metric.get(key_label, default_key) if key_label else default_key
                    labels, key = self.keyed(metric, fallback=fallback)
                    try:
                        text = q.get("text", "{key} {field}={val}").format(
                            key=key, field=field, val=round(val, 3), **metric
                        )
                    except (KeyError, IndexError):
                        text = f"{key} {field}={round(val, 3)}"
                    out.append(Envelope(
                        source=self.cfg.name, source_type=self.cfg.type, key_value=key,
                        event_type=q.get("event_type", "metric"), text=text, event_time=now_utc(),
                        fields={field: val}, payload={"metric": metric, "value": val, "promql": q["promql"]},
                        labels=labels,  # the series' labels; the primary one is the key
                    ))
        return out

    @classmethod
    async def discover(cls, config: dict) -> dict:
        base = config["url"].rstrip("/")
        async with httpx.AsyncClient(timeout=10) as cx:
            async def get(path, **params):
                return (await cx.get(f"{base}{path}", params=params)).json().get("data", {})

            try:
                names = await get("/api/v1/label/__name__/values") or []
                meta = await get("/api/v1/metadata") or {}
            except Exception as e:
                raise ValueError(f"could not reach Prometheus at {base}: {e}")

            app = [n for n in names if not _INTERNAL.search(n)
                   and not n.endswith(("_created", "_info")) and n != "up"]

            # histogram bases (a _bucket implies a histogram; its _count/_sum are components)
            hist_bases = sorted({n[:-7] for n in app if n.endswith("_bucket")})

            def is_hist_part(n):
                return any(n in (b + "_bucket", b + "_count", b + "_sum") for b in hist_bases)

            async def sample(n):
                r = await cx.get(f"{base}/api/v1/query", params={"query": n})
                res = r.json().get("data", {}).get("result", [])
                labels = sorted({k for s in res for k in s.get("metric", {}) if k != "__name__"})
                val = res[0]["value"][1] if res else None
                return labels, len(res), val

            scalars = [n for n in app if not is_hist_part(n)]   # gauges + counters
            label_union, metrics = set(), []
            for n in scalars:
                labels, card, val = await sample(n)
                label_union |= set(labels)
                m = (meta.get(n) or [{}])[0]
                mtype = m.get("type") or ("counter" if n.endswith("_total") else "gauge")
                metrics.append({"name": n, "type": mtype, "help": m.get("help", ""),
                                "series": card, "sample": val, "labels": labels,
                                "ingest": True,
                                "reason": "raw ingest (lossless; rates derivable later)"})
            for b in hist_bases:
                labels, card, _ = await sample(b + "_bucket")
                label_union |= set(labels)
                metrics.append({"name": b, "type": "histogram", "help": (meta.get(b) or [{}])[0].get("help", ""),
                                "series": card, "sample": None, "labels": labels, "ingest": False,
                                "reason": "histogram — ingest a derived quantile (p99) instead of raw buckets"})

            # suggested key: first priority label present, preferring one with >1 value
            present = [l for l in _KEY_PRIORITY if l in label_union]
            key, key_card, key_vals = None, 0, []
            for l in present:
                vals = await get(f"/api/v1/label/{l}/values") or []
                if key is None or (len(vals) > 1 and key_card <= 1):
                    key, key_card, key_vals = l, len(vals), vals
                if len(vals) > 1:
                    break
            key = key or "instance"
            default_key = "api-server" if "api-server" in key_vals else (key_vals[0] if key_vals else "default")

            proposed_labels = sorted(label_union - _LABEL_SKIP - {key})

            # type-aware derived suggestions
            derived = []
            for m in metrics:
                if m["type"] == "counter" and "status" in m["labels"]:
                    derived.append({
                        "id": f"rate_5xx_{m['name']}", "label": "5xx rate",
                        "promql": f'sum(rate({m["name"]}{{status=~"5.."}}[1m])) by ({key})',
                        "event_type": "rate_5xx", "field": "rate_5xx",
                        "reason": f"{m['name']} is a counter with a `status` label"})
            for b in hist_bases:
                derived.append({
                    "id": f"p99_{b}", "label": "p99 latency",
                    "promql": f"histogram_quantile(0.99, sum(rate({b}_bucket[5m])) by (le, {key}))",
                    "event_type": "p99", "field": "p99_ms",
                    "reason": f"{b} is a histogram"})

            # a ready-to-use config: raw scalars + derived. The key is just the primary label
            # (the suggested key, read from each series); default_key covers series without it.
            queries = [{"promql": m["name"], "event_type": m["name"], "field": m["name"],
                        "text": m["name"] + " {key}={val}"}
                       for m in metrics if m["ingest"]]
            queries += [{"promql": d["promql"], "event_type": d["event_type"], "field": d["field"],
                         "text": d["label"] + " {key}={val}"} for d in derived]
            proposed_config = {
                "url": base, "default_key": default_key, "queries": queries,
                "labels": [{"name": key, "field": key, "primary": True}]
                          + [{"name": l, "field": l} for l in proposed_labels],
            }

        return {
            "connector": "prometheus",
            "summary": {"total_metrics": len(names), "relevant": len(metrics),
                        "hidden": len(names) - len(scalars) - len(hist_bases)},
            "suggested_key": {"name": key, "cardinality": key_card,
                              "values_preview": key_vals[:8],
                              "alternatives": [l for l in present if l != key]},
            "proposed_labels": proposed_labels,
            "metrics": metrics,
            "derived_suggestions": derived,
            "proposed_config": proposed_config,
        }

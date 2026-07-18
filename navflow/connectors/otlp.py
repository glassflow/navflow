"""OpenTelemetry (OTLP) connector — a push receiver. Producers (an OTel SDK or Collector) export
OTLP/HTTP JSON to NavFlow's POST /v1/logs (traces/metrics later); nothing is polled.

OTLP nests three layers — resource → scope → record — with the entity-defining data (service.name,
host.name, …) at the *resource* level and the actual log/span at the *record* level. We flatten to
one Envelope per record, fanning the resource attributes down into each. Resource attributes become
labels via the source's `labels` config (default: service.name → the primary key), so one OTLP
source auto-shards into per-service entities.

JSON only for now — OTLP/HTTP JSON is plain JSON (proto3 mapping); gRPC + binary protobuf are a
later transport shim over the same mapping. Two proto3-JSON quirks handled below: AnyValue is a
oneof, and int64/uint64 (timeUnixNano, intValue) arrive as strings.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from ..envelope import Envelope, now_utc
from .base import Connector


def _anyvalue(v):
    """Decode an OTLP AnyValue (a oneof) to a native Python value."""
    if not isinstance(v, dict):
        return v
    if "stringValue" in v:
        return v["stringValue"]
    if "boolValue" in v:
        return v["boolValue"]
    if "intValue" in v:                       # proto3 JSON encodes int64 as a string
        try:
            return int(v["intValue"])
        except (TypeError, ValueError):
            return v["intValue"]
    if "doubleValue" in v:
        return v["doubleValue"]
    if "bytesValue" in v:
        return v["bytesValue"]
    if "arrayValue" in v:
        return [_anyvalue(e) for e in (v["arrayValue"] or {}).get("values", [])]
    if "kvlistValue" in v:
        return _attrs((v["kvlistValue"] or {}).get("values", []))
    return None


def _attrs(kvs) -> dict:
    """OTLP attribute list [{key, value: AnyValue}] → a flat dict (dotted keys kept as-is)."""
    out = {}
    for kv in kvs or []:
        k = kv.get("key")
        if k:
            out[k] = _anyvalue(kv.get("value", {}))
    return out


def _ns_to_dt(ns):
    """OTLP nanosecond timestamp (a string) → aware datetime, or None."""
    try:
        return datetime.fromtimestamp(int(ns) / 1e9, tz=timezone.utc)
    except (TypeError, ValueError):
        return None


def _unpack_logs(body: dict):
    """Flatten OTLP/HTTP logs JSON to (resource_attrs, scope, record) tuples — one per record."""
    for rl in body.get("resourceLogs", []) or []:
        res = _attrs((rl.get("resource") or {}).get("attributes", []))
        for sl in rl.get("scopeLogs", []) or []:
            scope = sl.get("scope") or {}
            for rec in sl.get("logRecords", []) or []:
                yield res, scope, rec


def _unpack_traces(body: dict):
    """Flatten OTLP/HTTP traces JSON to (resource_attrs, scope, span) tuples — one per span."""
    for rs in body.get("resourceSpans", []) or []:
        res = _attrs((rs.get("resource") or {}).get("attributes", []))
        for ss in rs.get("scopeSpans", []) or []:
            scope = ss.get("scope") or {}
            for span in ss.get("spans", []) or []:
                yield res, scope, span


# metric type is a oneof on the Metric object; each holds dataPoints
_METRIC_KINDS = ("gauge", "sum", "histogram", "exponentialHistogram", "summary")


def _unpack_metrics(body: dict):
    """Flatten OTLP/HTTP metrics JSON to (resource_attrs, scope, metric, datapoint, kind) — one
    per data point (a metric can have many points, like Prometheus series)."""
    for rm in body.get("resourceMetrics", []) or []:
        res = _attrs((rm.get("resource") or {}).get("attributes", []))
        for sm in rm.get("scopeMetrics", []) or []:
            scope = sm.get("scope") or {}
            for metric in sm.get("metrics", []) or []:
                kind = next((k for k in _METRIC_KINDS if metric.get(k)), None)
                if not kind:
                    continue
                for dp in (metric[kind] or {}).get("dataPoints", []) or []:
                    yield res, scope, metric, dp, kind


def _dp_value(dp: dict):
    """The scalar value of a data point: the number (gauge/sum) or the count (histogram/summary)."""
    if "asDouble" in dp:
        return dp["asDouble"]
    if "asInt" in dp:
        try:
            return int(dp["asInt"])
        except (TypeError, ValueError):
            return dp["asInt"]
    if "count" in dp:
        try:
            return int(dp["count"])
        except (TypeError, ValueError):
            return dp["count"]
    return None


class OtlpConnector(Connector):
    # Push receiver. Entities come from resource attributes via `labels` (the universal config);
    # an OTLP source is provisioned with service.name → the primary label by default.
    CONFIG_SCHEMA: dict = {}

    async def poll(self):
        return []  # push-only: records arrive via map_otlp from POST /v1/{signal}

    @staticmethod
    def _label_ctx(res: dict) -> dict:
        """Label-extraction context for one record's resource attributes. The canonical field
        namespace is the STORED payload shape — the names the profiler shows and the UI suggests
        (`resourceAttributes.service.name`). Bare wire names (`service.name`) stay resolvable as
        a compatibility alias for specs written before this was normalized."""
        return {**res, "resourceAttributes": res}

    def label_context(self, payload: dict | None) -> dict:
        # retroactive relabel must reproduce ingest exactly: same context, both namespaces
        return self._label_ctx((payload or {}).get("resourceAttributes") or {})

    def map_otlp(self, signal: str, body) -> list[Envelope]:
        if not isinstance(body, dict):
            raise ValueError("OTLP body must be a JSON object")
        if signal == "logs":
            return [self._log_envelope(res, scope, rec) for res, scope, rec in _unpack_logs(body)]
        if signal == "traces":
            return [self._span_envelope(res, scope, sp) for res, scope, sp in _unpack_traces(body)]
        if signal == "metrics":
            return [self._metric_envelope(res, scope, m, dp, kind)
                    for res, scope, m, dp, kind in _unpack_metrics(body)]
        raise ValueError(f"OTLP signal {signal!r} is not supported")

    def _log_envelope(self, res: dict, scope: dict, rec: dict) -> Envelope:
        # labels (and the key) come from the resource attributes, e.g. service.name → service
        labels, key = self.keyed(self._label_ctx(res), fallback="unknown")
        body_val = _anyvalue(rec.get("body", {}))
        text = body_val if isinstance(body_val, str) else json.dumps(body_val, default=str)
        event_time = (_ns_to_dt(rec.get("timeUnixNano"))
                      or _ns_to_dt(rec.get("observedTimeUnixNano")) or now_utc())
        rec_attrs = _attrs(rec.get("attributes", []))
        # numeric record attributes become trigger-usable fields; the rest stay lossless in payload
        fields = {k: v for k, v in rec_attrs.items()
                  if isinstance(v, (int, float)) and not isinstance(v, bool)}
        if rec.get("severityNumber"):
            fields["severityNumber"] = rec["severityNumber"]
        return Envelope(
            source=self.cfg.name, source_type=self.cfg.type, key_value=key,
            event_type=str(rec.get("severityText") or "log"),
            text=(text or "")[:1000], event_time=event_time,
            fields=fields, payload={"resourceAttributes": res, "scope": scope, **rec},
            labels=labels,
        )

    def _span_envelope(self, res: dict, scope: dict, span: dict) -> Envelope:
        labels, key = self.keyed(self._label_ctx(res), fallback="unknown")
        name = span.get("name", "span")
        start, end = span.get("startTimeUnixNano"), span.get("endTimeUnixNano")
        try:
            dur_ms = (int(end) - int(start)) / 1e6
        except (TypeError, ValueError):
            dur_ms = None
        # span status code is an enum — proto3 JSON may encode it as a name or a number
        code = (span.get("status") or {}).get("code")
        is_error = code in (2, "STATUS_CODE_ERROR")
        fields: dict = {}
        if dur_ms is not None:
            fields["duration_ms"] = dur_ms
        if isinstance(code, int):
            fields["status_code"] = code
        elif code in ("STATUS_CODE_ERROR", "STATUS_CODE_OK"):
            fields["status_code"] = 2 if is_error else 1
        text = name + (f" ({dur_ms:.1f}ms)" if dur_ms is not None else "") + (" ERROR" if is_error else "")
        return Envelope(
            source=self.cfg.name, source_type=self.cfg.type, key_value=key,
            event_type="span", text=text[:1000],
            event_time=_ns_to_dt(start) or now_utc(), fields=fields,
            payload={"resourceAttributes": res, "scope": scope, **span,
                     "attributes": _attrs(span.get("attributes", []))},
            labels=labels,
        )

    def _metric_envelope(self, res: dict, scope: dict, metric: dict, dp: dict, kind: str) -> Envelope:
        labels, key = self.keyed(self._label_ctx(res), fallback="unknown")
        name = metric.get("name", "metric")
        unit = metric.get("unit", "")
        value = _dp_value(dp)
        # event_type is the metric name; the scalar lands under `value` (a clean field key, so a
        # view filtered to event_type=<metric> can aggregate it — metric names have dots)
        fields: dict = {}
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            fields["value"] = value
        if isinstance(dp.get("sum"), (int, float)):
            fields["sum"] = dp["sum"]
        text = f"{name}={value}" + (f" {unit}" if unit else "")
        return Envelope(
            source=self.cfg.name, source_type=self.cfg.type, key_value=key,
            event_type=name, text=text[:1000],
            event_time=_ns_to_dt(dp.get("timeUnixNano")) or now_utc(), fields=fields,
            payload={"resourceAttributes": res, "scope": scope, "metricType": kind,
                     "metricName": name, "unit": unit,
                     "attributes": _attrs(dp.get("attributes", [])),
                     **{k: v for k, v in dp.items() if k != "attributes"}},
            labels=labels,
        )

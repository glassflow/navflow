"""OTLP gRPC receiver (:4317) — a thin transport over the same OTLP→Envelope mapping as the
HTTP/JSON path. Each Export RPC's protobuf request is converted to its proto3-JSON dict
(`MessageToDict` — structurally identical to OTLP/HTTP JSON: camelCase keys, enum names, int64
as strings) and handed to `runtime.ingest_otlp`. No mapping logic lives here.

Optional: needs grpcio + opentelemetry-proto (`pip install tares[otlp-grpc]`). The daemon
starts this only if it imports.
"""
from __future__ import annotations

import os

# Quiet grpc's C-core chatter (the "skipping fork() handlers" / "FD from fork parent" INFO lines it
# prints around fork). Must be set before `import grpc` initializes the C-core. Respects an explicit
# override if the operator set one.
os.environ.setdefault("GRPC_VERBOSITY", "ERROR")

import grpc
from google.protobuf.json_format import MessageToDict
from opentelemetry.proto.collector.logs.v1 import (
    logs_service_pb2 as logs_pb, logs_service_pb2_grpc as logs_grpc)
from opentelemetry.proto.collector.metrics.v1 import (
    metrics_service_pb2 as metrics_pb, metrics_service_pb2_grpc as metrics_grpc)
from opentelemetry.proto.collector.trace.v1 import (
    trace_service_pb2 as trace_pb, trace_service_pb2_grpc as trace_grpc)


def _header(context, key: str):
    for k, v in context.invocation_metadata() or ():
        if k == key:
            return v
    return None


class _Base:
    def __init__(self, resolve, ingest_otlp):
        self._resolve = resolve
        self._ingest = ingest_otlp

    async def _handle(self, signal: str, request, context):
        try:
            source = self._resolve(_header(context, "x-tares-source"))
            await self._ingest(source, signal, MessageToDict(request, preserving_proto_field_name=False))
        except KeyError as e:
            await context.abort(grpc.StatusCode.NOT_FOUND, str(e))
        except ValueError as e:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(e))


class LogsService(_Base, logs_grpc.LogsServiceServicer):
    async def Export(self, request, context):
        await self._handle("logs", request, context)
        return logs_pb.ExportLogsServiceResponse()


class TraceService(_Base, trace_grpc.TraceServiceServicer):
    async def Export(self, request, context):
        await self._handle("traces", request, context)
        return trace_pb.ExportTraceServiceResponse()


class MetricsService(_Base, metrics_grpc.MetricsServiceServicer):
    async def Export(self, request, context):
        await self._handle("metrics", request, context)
        return metrics_pb.ExportMetricsServiceResponse()


async def serve(port: int, resolve, ingest_otlp):
    """Start an async gRPC OTLP receiver on `port`; returns the running server (stop on shutdown).
    `resolve(header) -> source name` (may raise KeyError/ValueError); `ingest_otlp(source, signal,
    body)` is the runtime coroutine."""
    server = grpc.aio.server()
    logs_grpc.add_LogsServiceServicer_to_server(LogsService(resolve, ingest_otlp), server)
    trace_grpc.add_TraceServiceServicer_to_server(TraceService(resolve, ingest_otlp), server)
    metrics_grpc.add_MetricsServiceServicer_to_server(MetricsService(resolve, ingest_otlp), server)
    server.add_insecure_port(f"[::]:{port}")
    await server.start()
    return server

"""Client side of MCP — the daemon reaching OUT to external tool servers.

Not to be confused with tares/mcp_server.py (Tares serving its own surface). This module is what
Tares agents use to reach the customer's other tools: connect over streamable HTTP, present the
stored auth header, list tools, call one. stdio is deliberately unsupported: it would mean the
daemon spawning arbitrary commands, which is unacceptable on a hosted cell and a footgun anywhere.
"""
from __future__ import annotations

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

CONNECT_TIMEOUT = 15.0


def _headers(server: dict) -> dict:
    header = (server.get("auth_header") or "").strip() or "Authorization"
    value = (server.get("auth_value") or "").strip()
    return {header: value} if value else {}


async def list_remote_tools(server: dict) -> list[dict]:
    """Connect, initialize, and list the server's tools. Raises on failure — the caller decides
    whether that is a 502 (a test button) or evidence (an agent run)."""
    async with streamablehttp_client(server["url"], headers=_headers(server),
                                     timeout=CONNECT_TIMEOUT) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            res = await session.list_tools()
            return [{"name": t.name, "description": (t.description or "").strip()}
                    for t in res.tools]

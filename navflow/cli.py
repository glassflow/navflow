"""Entry points: `navflow` (the user CLI), `navflowd` (the daemon), `navflow-mcp` (stdio MCP proxy).

`navflow up` is the one command a local install needs: it picks a data home (~/.navflow), points the
daemon's DuckDB + catalog there, and starts the server (API + console UI) on http://127.0.0.1:8787.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

DEFAULT_HOME = Path(os.getenv("NAVFLOW_HOME", str(Path.home() / ".navflow")))


def _warn_if_exposed(host: str) -> None:
    """Loud warning when binding a non-loopback address with no auth token set — the common way to
    accidentally expose your data on the network."""
    loopback = {"127.0.0.1", "localhost", "::1", ""}
    if host not in loopback and not os.getenv("NAVFLOW_AUTH_TOKEN", "").strip():
        print(
            f"\n  ⚠  NavFlow is binding {host} (reachable off this machine) with NO auth token.\n"
            "     Anyone who can reach this port can read your data. Set NAVFLOW_AUTH_TOKEN and put\n"
            "     it behind TLS before exposing it — see https://docs.navflow.ai (Deployment).\n",
            flush=True,
        )


def run_daemon():
    import uvicorn

    from .daemon import make_app

    host = os.getenv("NAVFLOW_HOST", "127.0.0.1")
    port = int(os.getenv("NAVFLOW_PORT", "8787"))
    _warn_if_exposed(host)
    uvicorn.run(make_app(), host=host, port=port)


def run_mcp():
    from .mcp_server import main as mcp_main

    mcp_main()


def _up(args: argparse.Namespace):
    """Start the daemon with a persistent data home, so a fresh `pip install` just works."""
    home = Path(args.data_dir).expanduser()
    home.mkdir(parents=True, exist_ok=True)
    # point the daemon at the data home unless the user already set these explicitly.
    # (the daemon reads these env vars at import time, so set them before run_daemon imports it.)
    os.environ.setdefault("NAVFLOW_DB", str(home / "navflow.duckdb"))
    os.environ.setdefault("NAVFLOW_CATALOG", str(home / "catalog.yaml"))  # seed only; absent is fine
    os.environ["NAVFLOW_HOST"] = args.host
    os.environ["NAVFLOW_PORT"] = str(args.port)

    shown = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
    url = f"http://{shown}:{args.port}"
    print(f"navflow: console at {url}  ·  data in {home}", flush=True)
    if args.open:
        import threading
        import webbrowser
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    run_daemon()


def _mcp(args: argparse.Namespace):
    """Run the MCP server over a network transport (for remote agents). stdio is the default for
    local use and is what the `navflow-mcp` entry point a client spawns uses."""
    os.environ["NAVFLOW_MCP_TRANSPORT"] = args.transport
    os.environ["NAVFLOW_MCP_HOST"] = args.host
    os.environ["NAVFLOW_MCP_PORT"] = str(args.port)
    if args.navflowd:
        os.environ["NAVFLOWD_URL"] = args.navflowd
    target = os.getenv("NAVFLOWD_URL", "http://127.0.0.1:8787")
    path = "/sse" if args.transport == "sse" else "/mcp"
    print(f"navflow-mcp: {args.transport} on http://{args.host}:{args.port}{path}  ->  {target}",
          flush=True)
    run_mcp()


def main():
    p = argparse.ArgumentParser(prog="navflow", description="NavFlow — a data plane for AI agents.")
    sub = p.add_subparsers(dest="cmd")

    up = sub.add_parser("up", help="start the NavFlow daemon (API + console UI)")
    up.add_argument("--host", default=os.getenv("NAVFLOW_HOST", "127.0.0.1"),
                    help="bind address (default 127.0.0.1; use 0.0.0.0 to expose on the network)")
    up.add_argument("--port", type=int, default=int(os.getenv("NAVFLOW_PORT", "8787")))
    up.add_argument("--data-dir", default=str(DEFAULT_HOME),
                    help=f"where to keep the DuckDB + catalog (default {DEFAULT_HOME})")
    up.add_argument("--open", action="store_true", help="open the console in your browser")
    up.set_defaults(func=_up)

    m = sub.add_parser("mcp", help="run the MCP server for remote agents (HTTP transport)")
    m.add_argument("--transport", default="streamable-http", choices=["stdio", "sse", "streamable-http"])
    m.add_argument("--host", default=os.getenv("NAVFLOW_MCP_HOST", "127.0.0.1"))
    m.add_argument("--port", type=int, default=int(os.getenv("NAVFLOW_MCP_PORT", "8788")))
    m.add_argument("--navflowd", default=os.getenv("NAVFLOWD_URL", ""),
                   help="navflowd base URL to proxy to (default http://127.0.0.1:8787)")
    m.set_defaults(func=_mcp)

    args = p.parse_args()
    if not getattr(args, "func", None):
        p.print_help()
        return
    args.func(args)

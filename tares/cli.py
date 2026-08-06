"""Entry points: `tares` (the user CLI), `taresd` (the daemon), `tares-mcp` (stdio MCP proxy).

`tares up` is the one command a local install needs: it picks a data home (~/.tares), points the
daemon's DuckDB + catalog there, and starts the server (API + console UI) on http://127.0.0.1:8787.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

DEFAULT_HOME = Path(os.getenv("TARES_HOME", str(Path.home() / ".tares")))


def _pkg_version() -> str:
    from importlib.metadata import PackageNotFoundError, version
    try:
        return version("tares")
    except PackageNotFoundError:
        return "0+source"   # running from a source checkout without an install


def _warn_if_exposed(host: str) -> None:
    """Loud warning when binding a non-loopback address with no auth token set — the common way to
    accidentally expose your data on the network."""
    loopback = {"127.0.0.1", "localhost", "::1", ""}
    if host not in loopback and not os.getenv("TARES_AUTH_TOKEN", "").strip():
        print(
            f"\n  ⚠  Tares is binding {host} (reachable off this machine) with NO auth token.\n"
            "     Anyone who can reach this port can read your data. Set TARES_AUTH_TOKEN and put\n"
            "     it behind TLS before exposing it — see https://docs.glassflow.ai/tares (Deployment).\n",
            flush=True,
        )


def run_daemon():
    from .config import reject_legacy_db, reject_legacy_env
    reject_legacy_env()
    reject_legacy_db(os.environ.get("TARES_DB", "tares.duckdb"))
    import uvicorn

    from .daemon import make_app

    host = os.getenv("TARES_HOST", "127.0.0.1")
    port = int(os.getenv("TARES_PORT", "8787"))
    _warn_if_exposed(host)
    uvicorn.run(make_app(), host=host, port=port)


def run_mcp():
    from .mcp_server import main as mcp_main

    mcp_main()


_AUTH_GENERATE = "\x00generate"   # sentinel: bare `--auth` (no value) → generate + persist a token


def _resolve_root_token(home: Path, flag) -> str | None:
    """The console/API login credential when auth is ON — or None (auth OFF).

    Three categories of credential in Tares: the ingest URL (a per-source address, not a secret),
    scoped API keys (minted in the console for machines), and THIS — the root login a human uses to
    reach the console. It's bootstrapped at launch, never minted in the UI, and printed to whoever
    ran the command (terminal access == operator). Precedence: an explicit --auth=<token> or the
    TARES_AUTH_TOKEN env var (hosted/scripted, stable), else a token persisted in the data dir
    (generated once on the first bare `--auth`, reused on every restart so you never get locked out
    or have to re-copy it). Auth is OFF unless --auth is passed or the env token is set."""
    env = os.getenv("TARES_AUTH_TOKEN", "").strip()
    if isinstance(flag, str) and flag != _AUTH_GENERATE:
        return flag.strip()                      # explicit --auth=<token>
    if flag is None and not env:
        return None                              # no --auth, no env → auth OFF
    if env:
        return env                               # env token (bare --auth may also be present)
    # bare --auth: reuse the persisted token, or generate and persist one now.
    import secrets
    path = home / "root_token"
    if path.exists() and (tok := path.read_text().strip()):
        return tok
    tok = f"nvf_root_{secrets.token_urlsafe(24)}"
    path.write_text(tok)
    try:
        path.chmod(0o600)                        # best-effort: readable only by the owner
    except OSError:
        pass
    return tok


def _up(args: argparse.Namespace):
    """Start the daemon with a persistent data home, so a fresh `pip install` just works."""
    home = Path(args.data_dir).expanduser()
    home.mkdir(parents=True, exist_ok=True)
    # point the daemon at the data home unless the user already set these explicitly.
    # (the daemon reads these env vars at import time, so set them before run_daemon imports it.)
    os.environ.setdefault("TARES_DB", str(home / "tares.duckdb"))
    os.environ.setdefault("TARES_CATALOG", str(home / "catalog.yaml"))  # seed only; absent is fine
    os.environ["TARES_HOST"] = args.host
    os.environ["TARES_PORT"] = str(args.port)

    # Auth mode. Setting TARES_AUTH_TOKEN is what the daemon's guard keys off, so resolving the
    # root token here and exporting it turns the whole existing enforcement on — nothing else to wire.
    root_token = _resolve_root_token(home, getattr(args, "auth", None))
    if root_token:
        os.environ["TARES_AUTH_TOKEN"] = root_token

    shown = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
    url = f"http://{shown}:{args.port}"
    if root_token:
        # print the login the operator uses — a click-through URL, since they're at the terminal.
        print(f"tares: console at {url}  ·  data in {home}", flush=True)
        print(f"tares: auth ON — log in at {url}/?token={root_token}", flush=True)
    else:
        print(f"tares: console at {url}  ·  data in {home}  ·  auth OFF (open; "
              f"run with --auth to require a login)", flush=True)
    if args.open:
        import threading
        import webbrowser
        open_url = f"{url}/?token={root_token}" if root_token else url
        threading.Timer(1.2, lambda: webbrowser.open(open_url)).start()
    run_daemon()


def _mcp(args: argparse.Namespace):
    """Run the MCP server over a network transport (for remote agents). stdio is the default for
    local use and is what the `tares-mcp` entry point a client spawns uses."""
    os.environ["TARES_MCP_TRANSPORT"] = args.transport
    os.environ["TARES_MCP_HOST"] = args.host
    os.environ["TARES_MCP_PORT"] = str(args.port)
    if args.taresd:
        os.environ["TARESD_URL"] = args.taresd
    target = os.getenv("TARESD_URL", "http://127.0.0.1:8787")
    path = "/sse" if args.transport == "sse" else "/mcp"
    print(f"tares-mcp: {args.transport} on http://{args.host}:{args.port}{path}  ->  {target}",
          flush=True)
    run_mcp()


def main():
    from .config import reject_legacy_env
    reject_legacy_env()
    p = argparse.ArgumentParser(prog="tares", description="Tares — a data plane for AI agents.")
    p.add_argument("--version", action="version", version=f"tares {_pkg_version()}")
    sub = p.add_subparsers(dest="cmd")

    up = sub.add_parser("up", help="start the Tares daemon (API + console UI)")
    up.add_argument("--host", default=os.getenv("TARES_HOST", "127.0.0.1"),
                    help="bind address (default 127.0.0.1; use 0.0.0.0 to expose on the network)")
    up.add_argument("--port", type=int, default=int(os.getenv("TARES_PORT", "8787")))
    up.add_argument("--data-dir", default=str(DEFAULT_HOME),
                    help=f"where to keep the DuckDB + catalog (default {DEFAULT_HOME})")
    up.add_argument("--open", action="store_true", help="open the console in your browser")
    up.add_argument("--auth", nargs="?", const=_AUTH_GENERATE, default=None, metavar="TOKEN",
                    help="require a login for the console + API. Bare --auth generates and persists "
                         "a root token (printed as a login URL each launch); --auth=<token> uses "
                         "yours. Omit for an open local instance.")
    up.set_defaults(func=_up)

    m = sub.add_parser("mcp", help="run the MCP server for remote agents (HTTP transport)")
    m.add_argument("--transport", default="streamable-http", choices=["stdio", "sse", "streamable-http"])
    m.add_argument("--host", default=os.getenv("TARES_MCP_HOST", "127.0.0.1"))
    m.add_argument("--port", type=int, default=int(os.getenv("TARES_MCP_PORT", "8788")))
    m.add_argument("--taresd", default=os.getenv("TARESD_URL", ""),
                   help="taresd base URL to proxy to (default http://127.0.0.1:8787)")
    m.set_defaults(func=_mcp)

    args = p.parse_args()
    if not getattr(args, "func", None):
        p.print_help()
        return
    args.func(args)

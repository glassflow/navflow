"""navflow CLI — `navflow up` wires a data home and starts the daemon (without actually serving)."""
import os, sys, types
from pathlib import Path

import navflow.cli as cli

P = F = 0
def ck(l, c, d=""):
    global P, F; P += 1 if c else 0; F += 0 if c else 1
    print(("  ok   " if c else "  FAIL ") + l + ("" if c else f"  {d}"))


def test_up_wires_data_home(tmp):
    started = {}
    cli.run_daemon = lambda: started.setdefault("ran", True)  # don't actually serve
    for k in ("NAVFLOW_DB", "NAVFLOW_CATALOG"):
        os.environ.pop(k, None)
    args = types.SimpleNamespace(host="127.0.0.1", port=9999, data_dir=str(tmp), open=False)
    cli._up(args)
    ck("creates the data home", Path(tmp).is_dir())
    ck("points DB at the data home", os.environ["NAVFLOW_DB"] == str(Path(tmp) / "navflow.duckdb"), os.environ.get("NAVFLOW_DB"))
    ck("points catalog at the data home", os.environ["NAVFLOW_CATALOG"] == str(Path(tmp) / "catalog.yaml"))
    ck("sets host/port for the daemon", os.environ["NAVFLOW_PORT"] == "9999")
    ck("starts the daemon", started.get("ran") is True)


def test_up_respects_explicit_db():
    cli.run_daemon = lambda: None
    os.environ["NAVFLOW_DB"] = "/custom/path.duckdb"   # user override must win (setdefault)
    cli._up(types.SimpleNamespace(host="0.0.0.0", port=1, data_dir="/tmp/nf_x", open=False))
    ck("explicit NAVFLOW_DB is not overridden", os.environ["NAVFLOW_DB"] == "/custom/path.duckdb")
    os.environ.pop("NAVFLOW_DB", None)


def test_ui_dist_dev_fallback():
    os.environ.pop("NAVFLOW_UI_DIST", None)
    from navflow.daemon import _ui_dist
    ck("dev tree resolves to ui/dist", str(_ui_dist()).endswith("ui/dist"))


def test_parser_builds():
    # no subcommand -> prints help, no crash
    sys.argv = ["navflow"]
    cli.main()
    ck("main() with no args is a no-op (prints help)", True)


test_up_wires_data_home("/tmp/nf_cli_home")
test_up_respects_explicit_db()
test_ui_dist_dev_fallback()
test_parser_builds()
print(f"\n{P} passed, {F} failed")
sys.exit(1 if F else 0)

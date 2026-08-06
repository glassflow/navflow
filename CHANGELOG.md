# Changelog

Notable changes to Tares (formerly NavFlow). Format follows [Keep a Changelog](https://keepachangelog.com/);
the project follows [Semantic Versioning](https://semver.org/).

## [1.0.2] — 2026-08-06

### Changed
- **Documentation moved to <https://docs.glassflow.ai/tares>.** Every link in the README, the
  security policy, the packaging metadata, the CLI's exposure warning and the console now points
  there. Two of them were already wrong: the security policy and the issue template still linked
  `navflow.ai/docs`, and the console's Agents page linked `www.tares.ai`, which does not resolve.
- Repository URLs follow the rename to `glassflow/tares`.

## [1.0.1] — 2026-08-05

### Fixed
- **The 1.0.0 container image was never published** — its Dockerfile still copied `navflow/`, so
  the build failed after the tag was cut. 1.0.0 exists on PyPI but has no image; **1.0.1 is the
  first usable image tag**.
- Everything the rename missed outside `tares/` and `ui/`: the Dockerfile set `NAVFLOW_HOME` (which
  the new guard refuses to start on), both compose files set `NAVFLOW_CATALOG` / `NAVFLOW_AUTH_TOKEN`
  (so self-host compose could not boot at all), and the Claude Code plugin invoked the removed
  `navflow-mcp` entry point.

## [1.0.0] — 2026-08-05

**Breaking. There is no compatibility layer, deliberately.**

### Changed
- **`navflow` is now `tares`** — the Python package and module, the `navflow` / `navflowd` /
  `navflow-mcp` commands (now `tares` / `taresd` / `tares-mcp`), the PyPI project, and the image
  (`ghcr.io/glassflow/tares`). Existing `navflow` releases and image tags stay resolvable; nothing
  new is published under them.
- **Every `NAVFLOW_*` environment variable is now `TARES_*`** — the prefix is the only change, e.g.
  `NAVFLOW_DB` → `TARES_DB`, `NAVFLOW_AUTH_TOKEN` → `TARES_AUTH_TOKEN`, `NAVFLOW_PORT` →
  `TARES_PORT`. The MCP proxy's target is `TARESD_URL`.
- **The daemon refuses to start if any `NAVFLOW_*` variable is set**, printing the mapping. This is
  deliberate and is the one place a breaking rename must be loud: silently ignoring
  `NAVFLOW_DB` would open a database somewhere else and come up healthy and empty.
- **The data file is `tares.duckdb`** (was `navflow.duckdb`), and the default home is `~/.tares`.
  Starting with a `navflow.duckdb` beside a missing `tares.duckdb` is refused, with the `mv` to run
  — indistinguishable from data loss otherwise.

### Upgrading from 0.3.x
Rename your environment variables, `mv navflow.duckdb tares.duckdb`, and use `tares` in place of
`navflow`. The daemon will tell you if you miss one.

## [0.1.4] — 2026-07-03

### Removed
- **`changelog` and `config` connectors** — dummy, demo-only connectors that had outlived their
  use. Also drops the demo api-server's unused `/admin/changelog` and `/admin/config` endpoints and
  renames its fault switch `/admin/inject` → `/demo/inject`.

## [0.1.3] — 2026-07-03

### Added
- **`include_payload` on `read`/`query`** — opt-in flag that returns the full lossless stored
  record as `raw` on each row, alongside the summary `text`. Exposed over HTTP and the MCP
  `read`/`query` tools; covers all connectors.

### Fixed
- **Claude Code plugin install** — publish a root `marketplace.json` (`/plugin marketplace add
  glassflow/navflow`) and fix `plugin.json` load errors on Claude Code 2.1 (duplicate hooks ref,
  missing `ingest_token` default, `navflow_url` required flag hiding its default).
- **Double-ingest for `claude_code`** — the first pushed event flips a poll-mode source to push
  mode, so a source fed by the plugin no longer also tails files and ingests every event twice.

## [0.1.2] — 2026-07-02

### Added
- `navflow --version`.

## [0.1.1] — 2026-07-02

First public (soft-launch) release.

### Added
- **`read(selector, window)` primitive** — a correlated, time-ordered read across *all* sources
  matching a strict-AND conjunction of `label=value` constraints, with no view required. Exposed
  over HTTP (`POST /read`) and MCP (the `read` tool). Views become an optional narrowing lens;
  triggers still attach to a view.
- **Console redesign** — a selector-first **Explore** (pick an entity, add filters, read across
  every source, with a human/agent view toggle), a **⌘K Ask** command palette, a three-act
  navigation, and separate Views / Triggers pages.
- **Agents → Reads** — a client filter (defaults to `mcp`) over the read activity log.

### Changed
- Package and CLI distribution renamed from `navflow-mvp` to **`navflow`**.

Earlier `0.0.x` history is in the git log.

# Changelog

Notable changes to NavFlow. Format follows [Keep a Changelog](https://keepachangelog.com/);
the project follows [Semantic Versioning](https://semver.org/).

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

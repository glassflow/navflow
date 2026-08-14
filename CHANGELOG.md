# Changelog

Notable changes to Tares (formerly NavFlow). Format follows [Keep a Changelog](https://keepachangelog.com/);
the project follows [Semantic Versioning](https://semver.org/).

## [1.4.0] — 2026-08-14

### Added
- **Ask keeps your conversations.** Every conversation is saved on the instance and the Ask page
  is now the familiar AI-chat shell: a sidebar of conversations next to the chat, newest resumed
  automatically when you come back — navigating away, refreshing, or closing the browser loses
  nothing. Start another with **+ New conversation**; delete one from the sidebar. Resumed
  conversations carry their full transcript back into the agent's context. The instance keeps the
  newest 50; the ⌘K palette stays a single column and picks up the same latest conversation.
  Opening an old conversation just reads it — only a sent message or an applied proposal moves it
  to the top.

## [1.3.1] — 2026-08-14

### Fixed
- **Explore no longer sticks at "reading timeline…" in a background tab.** The read is skipped
  while the tab is hidden (deliberately, to save load), but nothing re-fired it when the tab
  became visible — you stared at the spinner until the next 10-second tick. The read now fires
  the moment the tab becomes visible.
- **The Connect page no longer shows the access token in clear text.** The Claude Code snippet
  rendered the real token unmasked the moment the page opened; on a secured instance that is the
  root token on screen. Every credentialed snippet now displays the masked token while the copy
  button carries the real one — which also fixes the other tabs, where copying without hitting
  reveal first copied the mask.

## [1.3.0] — 2026-08-10

### Added
- **Connect → MCP is a client picker.** The tab showed three generic snippets (JSON, Claude Code,
  stdio) and left the translation to the reader. It now asks which client you're connecting —
  Claude Code, Codex CLI, Cursor, Claude Desktop, Other (JSON), stdio — and shows that client's
  exact command with this instance's endpoint and token filled in, mirroring the docs page
  (docs.glassflow.ai/tares/agents). A verify line says what to ask and which tool call to expect.
- **A fresh instance lands on Sources.** Opening the console with zero sources showed an Overview
  of zeros. The first landing of a page load now goes to Sources, where the next step actually is;
  clicking Overview afterwards still works, and a failed source-list load never counts as empty.
- **The trigger page links the webhook contract.** Wiring an external agent to a trigger now points
  at Connect → Webhook (push) — which is deep-linkable as `/connect?tab=push` — for what the
  endpoint receives and how to acknowledge. The webhook tab itself was tightened: a minimal
  receiver example, and a note that built-in Tares agents need no endpoint at all.

### Fixed
- **The webhook tab stated the wrong acknowledge rule.** It said any response below 500 counts as
  delivered; the dispatcher only counts 2xx. It now matches the code: 2xx acknowledges, 5xx and
  transport errors are retried with backoff, a 4xx is recorded as failed and not retried.
- The webhook tab's delivery-history link said "Agents" but pointed at Activity.

## [1.2.1] — 2026-08-07

### Fixed
- **A subscribed Slack channel is no longer presented as an agent.** It sat under "Agents woken by
  this trigger" in a column headed `agent`, but a channel is a destination — it doesn't wake up and
  do anything. The section is now "Where this trigger delivers" and the column is `subscriber`,
  which covers all three kinds honestly: a Tares agent, a connected webhook, and a channel. The
  delete-trigger warning and the trigger's summary line had inherited the same wrong noun.
- **A subscription can be removed from the console.** Subscribing was a one-way door — the
  `/unsubscribe` endpoint and the per-trigger subscription id both existed, and nothing used them.
  Removing affects only that trigger; a subscriber wired to several keeps the rest, and its delivery
  history is kept.
- A Slack row showed the raw channel ID (`#C0BNV121CRX`). It now resolves to the channel name, with
  a lock for a private one, falling back to the id — which is the honest answer when the bot has
  been removed from the channel and the name is no longer knowable.

## [1.2.0] — 2026-08-07

### Added
- **Pick a Slack channel from a list instead of pasting an ID.** Subscribing a trigger to Slack meant
  going to Slack, right-clicking the channel, Copy link, and pulling the ID out of the URL. The
  console now offers the channels the bot can actually post to.

  It lists via `users.conversations`, **not** `conversations.list`, and that distinction is the whole
  design: `conversations.list` returns every public channel including ones the bot was never invited
  to, and posting to one of those fails at the first firing with `not_in_channel` — a subscription
  that can never deliver, which is what `validate_slack_channel` exists to prevent. On a real
  workspace this was the difference between offering 32 channels and offering the 2 that work.

  Because a missing channel now means "the bot isn't in it", the console says so: a line under the
  picker and a Refresh beside it that re-fetches only the channel list, so someone half-way through
  wiring up a trigger doesn't lose it to a page reload. Private channels are included and marked with
  a lock; the value submitted is the channel ID, which survives a rename.

  Needs the `channels:read` and `groups:read` scopes. **Scopes are baked into the token at install**,
  so a token issued before them keeps posting fine but cannot list — the console detects exactly that
  and falls back to the free-text box it always had, with a prompt to reinstall. Nobody loses the
  ability to subscribe.

### Changed
- **Slack alerts no longer unfurl links.** The alert body carries every label on the event, so a
  source with a `host` label — web traffic, CDN logs and deploys nearly always have one — made Slack
  fetch that site and staple a preview card onto the alert. It roughly doubled the height with
  nothing about the incident, read as though Tares were linking somewhere relevant when it was
  echoing a label value, and meant alerting had the side effect of Slack fetching a customer's URLs.
- **A Slack alert now links the firing** (`/dispatches/<id>`) rather than the entity — "what fired
  and what did it carry" is the question the reader has. An agent's *finding* still links the
  entity's timeline, which is what a finding is about. Both require `TARES_PUBLIC_URL`; a link to
  127.0.0.1 is worse than no link.
- **Slack timestamps are readable.** The footer was a raw ISO string with microseconds and a UTC
  offset; it now uses Slack's date token, which renders in each reader's timezone. Event ages read
  `[29m ago]` instead of `[T-1734s]` — in the Slack copy only, since the payload is the agent-facing
  contract and goes out over MCP verbatim.
- **`/tares ask` answers render properly.** Markdown tables arrived as raw pipes plus a `|---|---|`
  row, and `---` rules as three literal dashes. Tables are not an edge case — the assistant is told
  to use small tables where they help — and Slack renders no tables at all, so one becomes an aligned
  monospace block, the only place Slack keeps columns lined up.
- **The last native dropdowns in the console are gone.** A native `<select>`'s open menu is drawn by
  the OS and cannot be themed, so it arrived as a light system popup in the middle of the console.
  The view filter operator, the trigger aggregate, the Explore lens, the poll interval unit, the
  normalize rule kind and the sources status filter all use the app's own picker now.

### Fixed
- The Slack channel field's placeholder promised only "the channel ID", while a lowercase channel
  name has always been accepted too.

## [1.1.1] — 2026-08-07

### Added
- **Vercel sources expose the request (`proxy`) block**: `status_code`, `url`, `method`, `referer`,
  `path_type`, `region` and `cache` join the fields you can build labels and keys from. `url` is
  what the client actually requested — the existing `path` is the *rewritten* value, a Next.js
  segment on prerendered routes (`/tares?_rsc=19hu7` logs as `tares.segments/_head.segment`), so it
  cannot answer which page failed. Label the code as `{"field": "status_code", "type": "number"}` to
  filter `>= 400` and aggregate it in a trigger. Fields are resolved in `label_context()`, so ingest
  and backfill agree. Entries without a `proxy` block (builds) get no request labels rather than
  empty ones.

### Fixed
- **The Vercel connector discarded the HTTP status code.** It was computed in `_map_one` and never
  passed to the envelope — dead since it was written. With no status field to label on, the only
  value in reach containing digits was `path`, so a status label had to be built as a regex over it:
  that fires only when the request path is *literally* `404` (a hit on the 404 page asset, not a
  request that returned 404), names the 404 page instead of the URL that failed, and is empty on
  live traffic.
- **The assistant had to guess the shape of a view filter, and got it wrong.** `propose_view` typed
  `filters` as an array of unconstrained objects, so the shape was stated nowhere the model could
  see it — producing a flat `{"service": "x"}` pair, then `"=="` for the operator, both rejected on
  Apply. The schema now requires `field`, `op` and `value` with `op` as an enum of the operators
  the code validates against (`eq`, `neq`, `contains`, `gt`, `gte`, `lt`, `lte`), which is enforced
  when the tool is called rather than asked for in prose. The prompt gains the matching rule,
  including that a filter `field` may also be one of the built-in columns `event_type`, `source`,
  `text` and `key_value`.
- **A view proposal showed `2 filter(s)` instead of the filters.** That was the one place a bad
  filter could be caught before applying it, and it was showing a count. Cards now render each
  filter, and a malformed one as its raw JSON in a marked chip.

## [1.1.0] — 2026-08-07

### Changed
- **Breaking: `/api/agent/chat` no longer accepts an `X-Anthropic-Key` header.** There is one
  Anthropic key per instance — the environment's `ANTHROPIC_API_KEY`, else the one stored under
  Security — and it is the key the console assistant, `/tares ask` in Slack and trigger-woken
  agents all resolve. The console used to keep a copy in `localStorage` and send it per request, so
  a key added on the Ask page made Ask work while Slack and Tares agents still reported none
  configured, having no browser to read it from. Callers passing the header now get the instance's
  key; a request with no key configured anywhere gets a 400. Stale browser copies are cleared on
  load.
- **Ask and Organize are one assistant.** Organize was Ask with a different system prompt — both
  surfaces posted the same tools to the same endpoint — so the judgement it carried (what makes a
  good entity key, labels come only from real fields, watch for value variants, views key on labels
  rather than raw fields) now governs every proposal Ask makes. Asking Ask to add a label
  previously got an agent with none of it. Organize's full-source sweep survives as a starter
  prompt; `/organize` redirects to `/ask`.
- **The Ask page is readable at length.** The transcript scrolls with the page instead of inside a
  64vh slot; autoscroll follows the tail only while you are at the tail and detaches on a
  deliberate upward scroll; turns are labelled and separated; tool calls draw as a pipeline of
  steps showing what ran, how long it took and what came back; the composer is pinned, takes
  multiple lines, and offers Stop, New and copy-on-hover.
- **The source page says what it already knows.** The labels table gains a `rules` column naming
  which rule rewrites a label's values (`≈ regex`, `≈ 2 renames`, `≈ regex +5`, `≈ none`), from one
  shared summary so the editor and the read-only table cannot describe the same rule differently.
  The entity key is chosen from one dropdown above the table rather than a radio per row.
  `Labels & key` collapses, defaulting to closed. `Fields` lists only what is not already a label.
- Dropdowns are ours. A native `<select>`'s open menu is drawn by the OS and cannot be themed, so
  one macOS menu appeared mid-form beside our own styled inputs. `Picker` replaces it, keeping
  keyboard control, `disabled`, and listbox semantics.

### Fixed
- **A failed tool call in the assistant reported itself as successful.** The `ok` flag was derived
  from the response body starting with `{"error"`, which only ever matched the local unknown-tool
  case — every daemon error path raises `HTTPException` and serializes as `{"detail": …}`, so a 404
  read as a success and the console drew a failed read as a completed step. It now comes from the
  status code.
- **Pressing Stop could break the next question.** A turn stopped before it produced text
  serializes to an empty string, which the Messages API rejects, so the following question failed
  with a warning pointing at nothing.
- **A label rewriting every value looked identical to a pass-through one.** The table computed the
  distinction and styled it with a bare `button.active`, which no CSS rule matched — every
  `.active` rule is scoped to another component. On one instance a rule silently collapsing 237
  distinct values to 2 was invisible from the table.
- The merge panel never said which label it was editing, and a rule that blanks a value rendered as
  a green `ok` badge followed by nothing — indistinguishable from a value that failed to render.
  Blanking is a legitimate rule and is now stated as one.
- Normalize panels no longer expand on load, a long label name no longer pushes its badge onto a
  second line, and three paragraphs describing the columns directly beneath them are gone.

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

---
name: navflow
description: Use when you need cross-source context about this project's systems (recent deploys, logs, metrics, entities, correlated timelines), OR when organizing NavFlow itself — creating sources, labels, and views. NavFlow is the data plane; read it via the navflow MCP tools for one correlated timeline per entity, and author its catalog with the create/derive tools following the rules below.
---

# NavFlow

NavFlow is a data plane for agents: it ingests many sources (logs, metrics, deploys, database rows,
agent sessions) and serves **one correlated, time-ordered timeline per entity** (a service, customer,
session, …). The **navflow** MCP server is connected (this plugin registers it).

## Reading

When a question needs real context about running systems — "what changed before this error", "is
this service healthy", "what has this customer done recently" — read NavFlow instead of guessing:

- Start by discovering what's there: `list_sources`, `catalog_list`, `entities`.
- Read a timeline with `query` (a view + an entity key) or `read` (a `{label: value}` selector).
- Treat the timeline as ground truth for *what happened and when*; cite specific events.

This plugin also streams the current Claude Code session into NavFlow (the `claude_code` source) when
session streaming is enabled, so prior sessions are queryable as a source.

## Authoring: sources, labels, and views

NavFlow's data model has three layers — get them right and correlation just works; guess and it
silently doesn't:

- **Fields** — the *candidate menu*. A source's raw payload is stored losslessly; `source_fields`
  (and `discover_source` for a new source) profiles the fields it actually contains, with coverage
  and top values. Fields are not queryable on their own.
- **Labels** — the *declared axes* you promote from fields (or a const, or a regex over a field).
  Labels are what you filter, group, key, and correlate by. One label is the **primary key**.
- **Views** — correlate one or more sources into a per-entity timeline, keyed by a **label** the
  sources share.

### Rule 1 — Labels must come from real fields (never invent one)

Before choosing a source's labels, call **`source_fields`** (existing source) or use
**`discover_source`**'s `proposed_config` (new source) to see the fields that actually exist. A
label reads from one of three things, all grounded in real data:

- `field`: a profiled field name — must match a field `source_fields` shows, exactly.
- `const`: a fixed value stamped on every event (for a source with no natural field for an axis).
- a **regex** over a field — set `pattern` + `replace` (and/or `map`) on the label to normalize
  messy values. Regex/alias normalization is a first-class feature: use it instead of guessing at a
  clean field. `type: "number"` makes a label aggregatable (for triggers); the primary key must be a
  string.

Never name a `field` that isn't in the profile — it extracts nothing. Set labels by creating the
source (`create_source`) or updating its config with the full `labels` list.

### Rule 2 — Views key/filter on LABELS only, never raw fields

A view's `key_field` (and any filters) must be a **label the chosen sources expose** — not an
arbitrary payload field. If you want to correlate on something that isn't a label yet, **promote it
to a label first** (Rule 1), then `derive` the view keyed by that label. Confirm a source's current
labels with `catalog_describe("source:<name>")` before deriving.

### Rule 3 — To match a label across sources, add a NEW label — don't rename

To join source B to source A on a shared axis (say `service`), source B needs a label **named
`service`** too. Declare a **new** label on B (reading B's matching field) — do **not** try to
rename B's field or existing label. There is no rename; a source's label set is declared whole, so
add the shared-named label to B and keep its others. The values must agree **literally** across
sources for correlation to work — if B's raw values differ (e.g. `checkout-svc` vs `checkout`),
normalize them with `pattern`/`replace`/`map` on B's label so they match A's.

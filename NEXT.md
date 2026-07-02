# NavFlow MVP — next items

What we build next, in order. Each item is pulled from the [design doc](https://app.notion.com/p/glassflow/Design-Doc-36f1c086bb6d812db6f8c232853c04df)
and chosen because the DB-backed catalog + console work made it cheap, and because together they
move the MVP from "infrastructure that works" to "thesis that demos."

Deliberately **not** next (they're the documented expand paths, not MVP work): NATS JetStream,
bronze/silver split (S3 + ClickHouse), `project_id` multi-tenancy, auth, sub-second triggers.

---

## 1. `catalog.describe` — the discovery surface

Design doc §4: the MCP surface has two catalog tools; we only have `catalog_list`.
`describe(handle)` is the prerequisite for everything below — an agent must discover field names
and event types before it can propose a view or write a useful trigger.

- New agent endpoint `GET /catalog/{handle}` with handles like `source:logs`,
  `view:service_timeline`, `trigger:error_spike` (design doc handle convention).
- Returns: the full catalog entry, an **inferred schema** (event types + typed fields, sampled
  from stored events), **freshness** (`last_event_time` + lag seconds, per §6.5), **lineage
  edges** (source → view → trigger, derived from catalog references), and a few **sample
  records**.
- New MCP tool `catalog_describe(handle)`.

## 2. `derive()` — agent-proposed views (the authorship layer)

Design doc success criterion #4: *"at least one agent shapes a derivation the team did not
pre-author."* The doc marks `derive()` post-MVP because the full design needs a Derivation
Engine + materialization; but with the DB-backed live catalog, the **virtual** form
(`persist: false` in §6.9) is nearly free — and it's the validating moment for the whole
agent-defined-model thesis.

- New agent endpoint `POST /derive` and MCP tool
  `derive(sources, key_field, filters?, name?)` → creates a view in the live catalog, returns a
  handle the agent can immediately `query()` by name.
- Views gain optional **filters** (`[{field, op, value}]`, applied on read and in trigger
  eval) — the doc's `predicate` parameter, so a derived view can be narrower than its sources.
- Views gain **`created_by`** (`human` / `agent:<client>`, per §6.5 catalog schema) and
  **usage** (query count + `last_used_at` from the query log — the seed of the doc's
  usage-driven deprecation).
- Console: Views & Triggers shows who authored each view and how much it's used.
- Materialization, cost gates, auto-naming heuristics: still post-MVP.

## 3. `agent_memory` — closing the loop

Design doc journey step 7: the agent writes observations back, and its memory is itself a
navflow source. Success criterion #1 names agent memory as one of the five ingest modes.

- New push connector `memory` (a sibling of `webhook`): payloads
  `{key, content, memory_type?, fields?}` become lossless envelopes with
  `source_type: agent_memory`.
- New agent endpoint `POST /remember` and MCP tool `remember(key, content, memory_type?)` —
  auto-provisions an `agent_memory` source on first write, so the loop closes with zero setup.
- Memory events join correlated reads like any other source: add the memory source to a view
  (or `derive` one) and past observations appear in the timeline the next incident hands the
  agent.
- Skipped (honest collapse): the bi-temporal `valid_at`/`invalid_at` revision semantics of
  §6.3.5 — append-only is the DuckDB-honest form.

---

## Connector discovery (started 2026-06-12)

Onboarding should **introspect and propose, not interrogate** — the friction Ashish hit adding a
Prometheus source by hand (default_key unexplained; having to hand-author derived PromQL like
`rate_5xx`; a JSON-blob field). Deterministic, no LLM (an optional LLM-assist layer is only for
unstructured connectors — webhook payloads, log-line patterns — and is setup-time, never write-path).

- ✅ `PrometheusConnector.discover(config)` — reads `/metadata` + `/label/__name__/values` + a
  per-metric sample; classifies counter/gauge/histogram; ranks a suggested key from the series'
  labels; proposes labels; builds raw-ingest queries (bare metric names) + derived suggestions
  (5xx rate from counters w/ a status label, p99 from histograms); returns a ready `proposed_config`.
- ✅ `POST /api/sources/discover` (dispatches to `REGISTRY[connector].discover`; base returns None).
- ✅ Console **Discover** button + proposal panel on the source form (Apply fills the fields).
- ✅ Verified against the live cookbook Prometheus: 335 metrics → 8 relevant + 1 histogram,
  suggested key `service` (4 entities), derived 5xx-rate + p99. Creating from the proposal keys
  by `service` (4 entities) — the richer model the by-hand `default_key: api-server` threw away.
- Next for discovery: the optional LLM-assist layer for webhook (sample payload → key/labels) and
  docker_logs (sample lines → label_pattern); a structured (non-JSON-blob) metrics checklist UI.

## Canonical connector config (shipped 2026-06-12)

> **Built and tested** (`tests/test_normalize.py`, 19 checks). One source of truth per connector
> so a source set up any way produces the identical YAML.

- Each connector declares `CONFIG_SCHEMA` (universal `labels` merged in); `SPECS` form fields are
  *generated* from it (no parallel definition to drift). Prometheus + webhook migrated; others
  pass through `normalize_config()` unchanged until they declare a schema.
- `normalize_config(connector, raw)` is the single chokepoint every write runs through
  (create/update/test + YAML import): schema-ordered keys, type coercion, required enforced,
  defaults applied-then-omitted (terse), unknown keys rejected. Stored config is canonical →
  export is deterministic → round-trip is a fixed point.
- Verified: API-verbose, API-minimal, and scrambled-YAML inputs all converge to byte-identical
  stored config and YAML. Discover's proposed_config normalizes cleanly too.
- Note: sources created *before* this are grandfathered (config stored as-is) until next
  edit/import. Next: migrate the remaining connectors; a YAML-as-truth `apply` (GitOps) could
  layer on the same schema later.

## After these

- ~~Wire the cookbook agent run against the daemon~~ — **done**: see
  `navflow-cookbooks/cookbooks/01_sre_incident_response/run_navflowd.py` (real webhook push →
  woken agent, cold pull, memory loop; the in-process DataPlane variant remains untouched as
  the dependency-free public demo).
- Query contract completion (§6.8): `predicate`/`limit`/`order` on `query()` itself.
- Dispatch DLQ + manual redeliver from the console (§6.7).
- **Cleanup `type` (signal type) on sources** — now folded into the source/key model below
  (a source is defined by its connector; `type` goes away).

## The source/key model — SHIPPED (2026-06-12)

> **Status: built and tested** (`tests/test_labels.py`, 23 checks). Sources are pipes; labels
> are named axes; entities are `(label, value)` pairs; query/trigger by any label; labels are
> retroactive; `type` is derived from the connector. Console has an **Entities** page and a
> labels editor on the source form. Still parked: the *multi-value* case (bottom of this section).

Resolved the design thread parked on 2026-06-11. The test scenario that drove it: an SRE
agent over a product suite — GitHub commits, logs from several containers (api/ui/gateway),
one Prometheus. The model the MVP and the design doc were missing:

**The mental model**

- **Source = an ingest pipe.** Defined entirely by its connector + config — "how data gets
  in." Health/freshness/poll-status attach here. A source does *not* map to an entity. (This
  subsumes the `type`-cleanup: `type` goes away, identity is the connector.)
- **Label = an important, named field, extracted per event.** Replaces today's single `key`.
  A source can declare several labels (`env`, `app`, `service`, `tenant`). A *fixed* key is
  just the degenerate case — a constant extractor. Mechanically a label is a designated
  `field`; the distinction from an ad-hoc `filter` is *promotion*, not storage — a label is a
  filter that earned a name, an index, and a place in the catalog. Same query engine
  underneath.
- **Entity = a (label, value) pair** — `env=prod`, `app=ui`. First-class and browsable: the
  console gets an Entities page, *faceted* by label, each value clicking through to its
  cross-source timeline. (Not every label names a real "thing" — `service=ui` is an entity,
  `env=prod` is a facet — but the mechanism is uniform; only the UI presentation differs.)
- **Views** no longer need a single `key_field`. A view correlates pipes; the *query* says
  which label(s) to slice by — `query(view, where={env: prod})`, or `{env: prod, app: ui}`.
- **Triggers** group by any label(s): `group_by: [app]` or `[env, app]`; cooldown keyed to
  the tuple. More expressive than today, same machinery.
- **Labels are retroactive.** Because the full original `payload` is kept lossless, a label
  defined today can be computed from data ingested yesterday — backfill into the index, or
  compute at read time. Caveat: only fields that were actually in the data can become labels
  after the fact. (Same move as an agent re-keying existing data via `derive`.)

**Granularity guidance (unchanged, still holds)**: label by the finest entity you'd alert on
/ read about independently (service, not product). Triggers wake narrow; the agent widens on
demand with another `query` (cheap — lossless store).

**Build steps — all done:**
1. ✅ Source config declares `labels: [{name, const|field}]` (logs also take a `label_pattern`
   regex). Per-event extraction in every connector via `Connector.labels_for(context)` —
   `prometheus` reads a series label, `docker_logs` parses the line.
2. ✅ Store: `events.labels` JSON column (migrated in); reads/triggers filter+group by any label;
   `key_value` is the default/primary label.
3. ✅ `/query` + MCP `query` accept `where={label: value, …}`; view `key_field` is now optional.
4. ✅ Entities: `GET /api/entities[?label=]` faceted; console Entities page; `catalog_describe`
   exposes a source's label axes with their observed values.
5. ✅ `type` derived from the connector (`source_type_for`); dropped from the form / YAML
   (accepted-but-ignored on import for backward compat).
6. ✅ Retroactive labels: `store.backfill_labels()` recomputes a source's events' labels from
   their lossless payload on edit.

**Still parked (separate, harder):** the *multi-value* case — one event belonging to several
values of the *same* label (a monorepo commit affecting `app=ui` AND `app=api`). Distinct from
the multi-*label* model above; needs its own pass. Also missing from the design doc (§6.4 has
only a single `key_path`).

A multi-service / multi-tenant cookbook would be the thing that actually exercises all of this
— the current cookbook (everything `key=api-server`) never shows labels earning their keep.

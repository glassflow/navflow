# REDESIGN — console information architecture

Status: proposal (2026-07-01). No code yet. Supersedes the *look* redesign (shipped
`36ff906`), which polished the surface but left the concept model unchanged. This document
rethinks **what each screen is and how the data is presented**, so a first-time viewer can
follow the product in two minutes.

Priority (agreed): **demo legibility first**, without abandoning the daily operator. Hero:
**the correlated entity timeline** — "the exact read an agent gets."

---

## 1. The problem

Today's nav is seven peers pulled from the internal noun model:

    Sources · Ask · Entities · Views & Triggers · Agents(/activity) · Catalog · Settings

Three failures make it hard to explain:

1. **Sources / Entities / Catalog all answer "what data is in here?"** from angles that are
   real to the builder and invisible to a viewer. Catalog even says it shows "the same view an
   agent gets" — which Entities and Views also claim.
2. **The hero isn't in the nav.** "Run the exact read an agent would — one correlated,
   time-ordered timeline" already exists in code, buried as the **5th tab inside Agents**
   (`Activity.tsx` → Playground). The most important screen is the hardest to find.
3. **Two pages do double duty.** "Views & Triggers" crams two concepts into one; "Agents"
   mixes *connecting* an agent with *watching* it (route still named `/activity`).

Root cause: the nav mirrors NavFlow's nouns, not the operator's task flow or a story a
stranger can follow.

---

## 2. The reframe — 6 nouns → a 3-act story

**NavFlow in one line:** *Any AI agent gets one correlated, time-ordered read of any entity
across all your systems — and gets woken when something crosses a line.*

Every operator action is one of three acts. The nav becomes those acts, in order:

| Act | Verb | Answers | Absorbs today |
|---|---|---|---|
| **I · Data in** | connect your systems | "what's flowing in?" | Sources |
| **II · The timeline** ⭐ | see any entity, whole | "what does an agent see?" | Entities + Playground + Catalog's entity view |
| **III · Serve & automate** | hand it to agents; wake them | "how do agents use it?" | Views, Triggers, Agents/Activity |

---

## 3. Navigation — before / after

```
BEFORE (flat, 7)            AFTER (grouped, 3-act story)
  Sources                     DATA IN
  Ask                           ○ Sources          connectors, status, add / discover
  Entities                    THE TIMELINE
  Views & Triggers              ● Explore    ⭐    entity → correlated cross-source timeline
  Agents  (/activity)         SERVE TO AGENTS
  Catalog                       ○ Views            saved reads agents query
  Settings                      ○ Triggers         conditions that wake agents
                                ○ Agents           connect an agent + watch it
                              ────────
                                Ask  (dedicated page + ⌘K overlay)
                                Settings
```

Net: **7 nav items → 5**, grouped into the story, **zero features lost**.

---

## 4. Page-by-page

### ⭐ Explore — the new hero  (merges Entities + Playground + Catalog's entity view)
The screen that carries the whole product. See §5 for the wireframe. Core moves:
- Left: entity picker (today's Entities list — grouped by label, searchable, count + last-seen).
- Main: pick entity + window → the unified, time-ordered, cross-source timeline.
- **`Human view ⇄ Agent view` toggle** — the same read as a readable timeline, or as the exact
  MCP payload. Flipping it *demonstrates* human/agent parity in one gesture.
- **`Save as view`** — turn an exploration into a reusable View (wires Act II → Act III).

### Sources  (mostly as-is)
Reads well already. **Absorbs Catalog's *source* describe** (schema / field coverage /
freshness / sample events) into the source-detail sheet — that data is about a source, so it
lives on the source.

### Views  (split out of "Views & Triggers")
Own page. Framed as *"saved reads — the queries you hand agents."* Keeps author badge, usage
stats, editor sheet.

### Triggers  (the other half)
Own page. *"conditions that wake an agent with a timeline."* Editor already captures the whole
idea (condition → context window → emit); it just stops being a subheading.

### Agents  (connect + activity; route `/activity` → `/agents`)
Tabs: **Connect** (endpoint, token, snippets, tools) · **Reads** (query log) · **Dispatches**
(firings) · **Subscriptions**. The **Playground tab moves to Explore.**

### Ask  (dedicated page **and** ⌘K overlay — see §6)
Kept as a section; *also* summonable from anywhere with ⌘K so you never lose your place.

### Catalog — dissolved
The most redundant page: re-shows entities (→ Explore), source schema/freshness (→ Sources
detail), view/trigger definitions (→ those pages). Its one real idea — the agent's-eye view of
any handle — is delivered better by Explore's Agent-view toggle.

---

## 5. Wireframe — Explore (hero), using live data

Live entities: label `service` = {api-server, user-svc, auth-svc, payment-svc}; label `key` =
50 claude/agent session ids. Views over `service`: `incident_timeline`, `api_server_health`.

### 5a · Human view (default)

```
┌─────────┬──────────────────────────────────────────────────────────────────────────┐
│ nav     │  Explore                                                                   │
│         │  pick an entity — see everything across every source, one timeline         │
│ DATA IN │ ┌────────────────────┬───────────────────────────────────────────────────┐│
│ ○ Sources│ ENTITY               │  api-server                    ◐ Human │ Agent ○   ││
│         │ │ 🔎 filter entities…  │  service · 3,521,599 events · 2 sources            ││
│ TIMELINE│ │                     ├───────────────────────────────────────────────────┤│
│ ● Explore│ ▾ service       (4)  │  lens: incident_timeline ▾    window: 15m 1h [24h] ⋯││
│         │ │   ● api-server       │        api-server_logs · metrics · agent_memory     ││
│ AGENTS  │ │     user-svc         ├───────────────────────────────────────────────────┤│
│ ○ Views │ │     auth-svc         │  T-64s  ▪api-server_logs  INFO GET /metrics → 200   ││
│ ○ Triggers│    payment-svc       │  T-59s  ▪api-server_logs  INFO GET /metrics → 200   ││
│ ○ Agents│ │ ▾ key          (50) │  T-14s  ▪api-server_logs  INFO GET /metrics → 200   ││
│         │ │     596c1a3a…  9,062 │  T-5s   ▪metrics          db_pool_size = 20.0        ││
│ ─────── │ │     6900031b…  4,049 │  T-5s   ▪metrics          dependency_up = 1.0        ││
│ Ask     │ │     dbeeee87…  1,783 │  T-0s   ▪metrics          error_injection_rate = 0.0 ││
│ Settings│ │     …                │  T-0s   ▪metrics          injected_latency_ms = 0.0  ││
│         │ │                     │                                    [ Save as view ↗ ]││
│         │ └────────────────────┴───────────────────────────────────────────────────┘│
└─────────┴──────────────────────────────────────────────────────────────────────────┘
```

Notes
- **Entity picker** = today's Entities page, moved left and made a navigation control instead
  of a standalone table. Grouped by label; primary labels (`service`, `key`) on top.
- **lens** = which View defines the read (a read is always view + key + window). Defaults to
  the broadest View whose `key_field` matches the entity's label; changeable inline. This keeps
  "pick entity → see timeline" simple while staying honest to the data model.
- **Source tag** on every row (`▪api-server_logs`, `▪metrics`) is the proof it's correlated —
  multiple systems interleaved on one clock.
- Rows are the real payload lines, parsed into columns: `T-offset · source · event`.

### 5b · Agent view (toggle flipped) — the money shot

```
│  api-server                                          Human ○ │ Agent ◐   [ copy ⧉ ] │
│  exactly what the agent receives over MCP · incident_timeline · 24h                 │
├────────────────────────────────────────────────────────────────────────────────────┤
│  === incident_timeline · key=api-server · window=24h · ONE NavFlow read ===         │
│  [T-64s] [api-server_logs] INFO:  GET /metrics HTTP/1.1  200 OK                      │
│  [T-59s] [api-server_logs] INFO:  GET /metrics HTTP/1.1  200 OK                      │
│  [T-5s]  [metrics] db_pool_size api-server=20.0                                      │
│  [T-5s]  [metrics] dependency_up api-server=1.0                                      │
│  [T-0s]  [metrics] error_injection_rate api-server=0.0                               │
│  [T-0s]  [metrics] injected_latency_ms api-server=0.0                                │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Same entity, same window — left is for the human, right is the literal bytes the agent reads.
The toggle *is* the "human/agent parity" pitch. This is the frame to point at and say "this is
NavFlow."

---

## 6. Ask — overlay vs dedicated (recommendation: **both**)

"Overlay" = a ⌘K command palette that floats over whatever page you're on, so you can ask a
question without navigating away and losing context. It is an *access method*, not a
replacement for the page.

```
              page dimmed behind ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒
        ┌─ ⌘K ──────────────────────────────────────────────────┐
        │  🔎  Ask your data…                                    │
        ├────────────────────────────────────────────────────────┤
        │  you   why did api-server error-injection go non-zero? │
        │  nav   I read incident_timeline for api-server (24h):  │
        │        error_injection_rate = 0.0 throughout the       │
        │        window; last non-zero was … [open in Explore ↗] │
        ├────────────────────────────────────────────────────────┤
        │  jump to ›  Explore api-server   ·   View incident_…   │
        │                                              ↵ send    │
        └────────────────────────────────────────────────────────┘
                          Esc to close
```

**Recommendation — hybrid, keeps your "dedicated section":**
- **Keep the dedicated Ask page** for long, multi-turn debugging sessions (unchanged).
- **Add the ⌘K overlay** as a fast way to summon that same assistant from Sources / Explore /
  anywhere, with quick "jump to" results that deep-link into Explore. Same engine, two doors.

This is *additive* to what you have; nothing about the current Ask page is removed. If you'd
rather not build the overlay now, Ask simply stays a dedicated page and we revisit later.

---

## 7. Migration map — nothing is lost

| Today | Becomes |
|---|---|
| Sources (+ new/discover/claude-code/detail) | **Sources** (unchanged) + absorbs Catalog *source* describe |
| Entities (table) | **Explore** — left picker |
| Agents ▸ Playground | **Explore** — main timeline + Agent-view toggle |
| Catalog ▸ source describe | **Sources** detail sheet |
| Catalog ▸ entity (label→values) | **Explore** |
| Catalog ▸ view/trigger definition + lineage | **Views** / **Triggers** detail |
| Views & Triggers ▸ Views | **Views** (own page) |
| Views & Triggers ▸ Triggers | **Triggers** (own page) |
| Agents ▸ Connect/Queries/Dispatches/Subscriptions | **Agents** (renamed route, Playground removed) |
| Ask | **Ask** page + ⌘K overlay |

---

## 8. The 4-click demo path this unlocks

1. **Sources** — "GitHub, Postgres, Vercel, OTel — everything flows in, losslessly."
2. **Explore → api-server** — "everything that happened to this service across all systems, one
   timeline." *[flip to Agent view]* "…and this is the exact read an agent gets."
3. **Triggers** — "when 5xx crosses 1%, fire."
4. **Agents → Dispatches** — "the agent got woken with that timeline and started debugging."

Four screens, one sentence each, Act II is the star.

---

## 9. Open questions

- Explore lens default: broadest-matching view, or remember last-used per label?
- Do we keep an entity with **no** matching view (e.g. a bare `key`) readable via a synthetic
  "all sources for this label" lens, or require a View first?
- Build the ⌘K overlay this pass, or ship Explore + the nav regroup first and add Ask-overlay
  after?
```

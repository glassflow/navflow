# PRODUCT

register: product

## Product purpose

NavFlow is a self-hostable data plane for AI agents. It ingests events from a system's
connectors (logs, metrics, deploys, Postgres, Vercel, GitHub, OpenTelemetry), stores them
losslessly in an embedded DuckDB, and serves an agent one correlated, time-ordered read of any
entity over MCP. It also watches: triggers fire on a condition and push the correlated timeline
to a subscribed agent.

The surface in focus here is the **console** (`ui/`), the operator's web UI served by the daemon.
It is a working tool, not a showcase. Design serves the data and the task.

## Users

Developers and operators self-hosting NavFlow. They are terminal-comfortable and technically
fluent. In the console they: add and configure data sources, inspect entities, events, and field
coverage, author views and triggers, and connect coding agents (Claude Code and other MCP
clients). They value density, precision, and reference-grade clarity over hand-holding or
persuasion. They glance at this in a normal-lit room on a wide desktop monitor while wiring up a
system, not in a dim NOC at 2am.

## Brand and tone

Editorial-humanist and technical-reference. Calm, exact, lossless. The voice is declarative
documentation (mechanics, fields, commands), never marketing. The brand mark is three stacked
"flow" bars in a warm orange-to-amber gradient; the display face is a serif (Georgia), data and
identifiers are monospace. Accent is a restrained burnt orange used sparingly for emphasis and
active state, not as decoration.

## Anti-references

- Generic SaaS admin dashboards (icon + heading + stat card grids repeated endlessly).
- Dark "observability cockpit" aesthetics, neon-on-black, glow, heavy charts.
- Gradient-hero / big-number-template landing-page tropes pulled into a tool.
- Hand-holding empty states with illustrations and exclamation points.
- Any second accent color competing with the brand orange (a legacy blue `#5b8def` leaked in and
  should be retired in favor of the accent token).

## Strategic principles

1. **Human/agent parity.** The console shows exactly what an agent sees over MCP. The Catalog
   explorer, field coverage, and Agents → Connect views exist to close that gap. Surfaces should
   reinforce "this is the agent's view, made legible," not hide it.
2. **The data is the hero.** Events, fields, entities, and timelines carry the page. Chrome
   recedes: thin lines, tinted neutrals, generous but rhythmic spacing.
3. **Density with restraint.** Pack real information, but keep one accent and a clear hierarchy so
   it reads as reference, not as a busy panel.
4. **Honest states.** Empty, loading, and error states say what is true and what to do next, in
   the same technical voice as the rest of the product.

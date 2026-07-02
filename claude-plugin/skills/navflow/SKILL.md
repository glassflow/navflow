---
name: navflow
description: Use when you need cross-source context about what's happening in this project's systems — recent deploys, logs, metrics, entities, or correlated timelines. NavFlow is the data plane; query it via the navflow MCP tools to read one correlated, time-ordered timeline for an entity (service, customer, session, …) instead of guessing.
---

# NavFlow

NavFlow is a data plane for agents: it ingests many sources (logs, metrics, deploys, database rows,
agent sessions) and serves **one correlated, time-ordered timeline per entity**.

When a question needs real context about this project's running systems — "what changed before this
error", "is this service healthy", "what has this customer done recently" — prefer reading NavFlow
over guessing.

How to use it:
- The **navflow** MCP server is connected (this plugin registers it). Use its tools to list views and
  query an entity's timeline. Pick the entity key (e.g. a service name, customer id, or session id)
  and a time window, then read the returned timeline.
- Start by discovering what's available (sources, views, entities) before querying.
- Treat the timeline as ground truth for *what happened and when*; cite specific events.

This plugin also streams the current Claude Code session into NavFlow (the `claude_code` source) when
session streaming is enabled, so prior sessions are themselves queryable as a source.

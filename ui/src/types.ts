export interface SourceHealth {
  status: string;
  last_poll_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  consecutive_errors: number;
  polls: number;
  events_since_start: number;
  events_total: number;
  last_ingest: string | null;
}

export interface Source {
  name: string;
  type: string;
  connector: string;
  poll: string;
  config: Record<string, unknown>;
  paused: boolean;
  health: SourceHealth | null;
  ingest_key?: string;   // stable path segment for push endpoints: /ingest/<ingest_key>
}

export interface ConnectorField {
  name: string;
  type: "string" | "number" | "json" | "list" | "bool";
  required: boolean;
  help: string;
  secret?: boolean;          // render as a password input (tokens, DSNs)
  discover_input?: boolean;  // Discover needs this field — shown above the Discover panel
  item?: ConnectorField[];   // for type "list": the sub-fields of each row
}

export interface ConnectorSpec {
  label: string;
  mode: "poll" | "push";
  discover?: boolean;
  poll?: string;   // connector-specific default poll interval (e.g. github: "2m")
  internal?: boolean;   // provisioned by Tares itself (agent findings) — not offered in the UI
  description: string;
  fields: ConnectorField[];
  provides?: { name: string; primary?: boolean; help?: string }[];   // synthesized label fields
}

export interface SourceFieldValue { value: string; events: number; }
export interface SourceField {
  name: string;
  help: string;
  primary_default: boolean;
  coverage: number;
  distinct: number;
  is_label?: boolean;
  is_key?: boolean;
  values: SourceFieldValue[];
}
export interface SourceLabelProfile {
  name: string;
  is_key: boolean;
  coverage: number;
  distinct: number;
  values: SourceFieldValue[];
}
export interface SourceFieldsProfile {
  sampled: number;
  fields: SourceField[];
  labels?: SourceLabelProfile[];
}

// One event in a correlated read: its time offset, source, rendered text, and the labels it
// carries (endpoint, status, …) — so the timeline shows the dimensions you filtered/sliced by.
export interface TimelineEventRow {
  offset: string;
  source: string;
  text: string;
  labels: Record<string, string>;
}

export interface CatalogList {
  sources: { name: string; type: string }[];
  views: { name: string; key_field: string; sources: string[]; created_by: string }[];
  triggers: { name: string; view: string }[];
}
export interface CatalogDescribe {
  handle: string;
  kind: "source" | "view" | "trigger";
  entry: Record<string, unknown>;
  schema?: { event_types?: string[]; fields?: Record<string, string>; sampled_events?: number } & Record<string, unknown>;
  labels?: Record<string, { value: string; events: number; last_ingest?: string }[]>;
  primary_label?: string;
  freshness?: { last_event_time?: string; lag_seconds?: number; events_total?: number; status?: string };
  lineage?: { from: string; to: string; transform: string }[];
  sample?: { key: string; event_type: string; text: string; ingest_time?: string }[];
  subscribers?: number;
}

export interface DiscoverMetric {
  name: string;
  type: string;
  help: string;
  series: number;
  sample: string | null;
  labels: string[];
  ingest: boolean;
  reason: string;
}

export interface ProposedSource {
  connector: string;
  name: string;
  config: Record<string, unknown>;
  summary: string;
  preselect: boolean;
  from: string;
}

export interface EnvScan {
  provider: string;
  summary: { containers: number; proposed: number };
  containers: Array<{ name: string; image: string; ports: string; project: string; service: string }>;
  proposed_sources: ProposedSource[];
  skipped: Array<{ service: string; image: string; reason: string }>;
}

export interface DiscoverProposal {
  connector: string;
  families?: string[];   // prometheus: the metric families (name prefixes) this proposal ingests
  summary: { total_metrics: number; relevant: number; hidden: number; capped?: boolean; families?: number };
  suggested_key: { name: string; cardinality: number; values_preview: string[]; alternatives: string[] };
  proposed_labels: string[];
  metrics: DiscoverMetric[];
  derived_suggestions: { id: string; label: string; promql: string; event_type: string; field: string; reason: string }[];
  proposed_config: { url: string; default_key: string; queries: unknown[]; labels: { name: string; field: string }[] };
}

// A connected agent: subscriptions grouped by endpoint, named deterministically server-side.
export interface AgentInfo {
  name: string;
  endpoint: string;   // masked — the last path segment may carry a secret
  // a Tares agent (in-process), an external webhook, or a Slack channel (slack://channel/<id>)
  kind: "tares" | "connected" | "slack";
  subscriptions: { subscription_id: string; trigger: string; created_at: string | null }[];
  triggers: string[];
  created_by: string[];
  first_seen: string | null;
  delivered_ok_24h: number;     // deliveries in the last 24h — what the roster columns show
  delivered_fail_24h: number;
  delivered_ok_total: number;   // all-time, shown as secondary text so the number isn't lost
  delivered_fail_total: number;
  pending?: number;             // in-flight Tares-agent runs
  last_woken: string | null;
  unhealthy?: boolean;          // the most recent delivery to this endpoint failed
  last_error?: string | null;   // why, when unhealthy
  recent: { at: string | null; ok: boolean | null; trigger: string | null; key: string | null; error?: string | null; dispatch_id?: string }[];
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

// Discover response for table-shaped connectors (postgres): the columns found plus a proposed
// config to review and apply. (Prometheus uses the richer DiscoverProposal above.)
export interface ColumnsProposal {
  connector: string;
  summary: string;
  columns: { name: string; type: string }[];
  proposed_config: Record<string, unknown>;
}

export interface ViewFilter {
  field: string;
  op: "eq" | "neq" | "contains" | "gt" | "lt" | "gte" | "lte";
  value: string | number;
}

export interface ViewUsage {
  queries: number;
  last_used_at: string | null;
}

export interface Entity {
  value: string;
  events: number;
  last_ingest: string | null;
}

export interface LabelFacet {
  label: string;
  primary?: boolean;
  sources: string[];
  high_cardinality?: boolean;   // exceeded the entity cardinality cap — served by a live scan
  values: Entity[];
}

export interface View {
  name: string;
  key_field: string;
  sources: string[];
  filters?: ViewFilter[];
  created_by?: string;
  usage?: ViewUsage | null;
}

export interface TriggerCondition {
  aggregate: string;
  predicate: string;
  window: string;
  field?: string | null;
  group_by?: string[];
}

export interface Trigger {
  name: string;
  view: string;
  condition: TriggerCondition;
  emit: Record<string, unknown>;
  cooldown: string;
  paused?: boolean;   // paused triggers are not evaluated and never fire
}

// A Tares agent is a prompt attached to a trigger: when the trigger fires, the agent takes a
// first look and writes a finding onto the entity's timeline. It's a real agent, configured inside
// Tares rather than connected over a webhook. The prompt is the only field a user edits; enabled
// means it's subscribed to its trigger, exactly like an external agent.
export interface BuiltinAgent {
  name: string;
  trigger: string;
  prompt: string;
  enabled: boolean;
  slack_configured: boolean;   // the webhook URL itself is never sent to the client
  model: string;               // "" = the instance default
  slack_channel: string;       // workspace-bot channel id, "" = none
  webhook_url: string;         // write-back target, "" = none
  webhook_token_configured: boolean;   // the token itself is never sent to the client
  mcp_servers: string[];       // registry names this agent may use
  updated_at?: string;
  last_run?: AgentRun | null;
}

export interface AgentRun {
  id: string;
  agent: string;
  trigger: string;
  dispatch_id: string;
  key: string;
  status: "running" | "ok" | "empty" | "failed" | "capped";
  rounds: number;
  tool_calls: number;
  external_tools?: string[];   // prefixed server__tool names this run called
  started_at: string;
  duration_ms: number | null;
  finding: string | null;
  error: string | null;
}

export interface AgentPreset {
  id: string;
  label: string;
  prompt: string;
}

export interface QueryLogEntry {
  id: string;
  view: string;
  key: string;
  window: string;
  rows_returned: number;
  client: string;
  queried_at: string;
}

export interface DispatchLogEntry {
  dispatch_id: string;
  trigger: string;
  key: string;
  kind: string;
  fired_at: string;
  subscribers: number;
  delivered: number;
  payload: string;
  error?: string | null;   // most recent failed delivery's reason, when delivered < subscribers
}

// One delivery attempt to a specific subscriber, for the dispatch detail page.
export interface DispatchDelivery {
  agent: string;
  endpoint: string;   // masked
  ok: boolean;
  error?: string | null;
  delivered_at: string | null;
}

// A single firing, deep — fetched by id so a linked dispatch page never dead-ends.
export interface DispatchDetail extends DispatchLogEntry {
  deliveries: DispatchDelivery[];
}

export interface Subscription {
  subscription_id: string;
  trigger: string;
  url: string;
  created_at: string;
}

export interface SourceEvent {
  source: string;
  key: string;
  event_type: string;
  text: string;
  event_time: string;
  ingest_time: string;
}

// GET /api/usage — what this instance is using on disk.
// Three things the renderer must respect:
//  · `pct_used` is 0-100, NOT a 0-1 fraction — "warn at 80%" compares against 80.
//  · `pct_used` and `max_bytes` are null unless the operator set TARES_MAX_DB_SIZE (the Helm
//    chart does it for hosted cells), so a self-hosted install has no denominator at all: show
//    absolute bytes and fall back to `disk_free` for headroom. Null is unknown, never 0.
//  · `sources[].bytes` is always null — DuckDB keeps every source in one events table and cannot
//    attribute storage per source. Only the per-source event counts are real.
export interface Usage {
  db_bytes: number;
  wal_bytes: number;
  disk_total: number | null;
  disk_free: number | null;
  max_bytes: number | null;
  pct_used: number | null;
  events: number;
  sources: { name: string; events: number; bytes: number | null }[];
  agent_runs: number;
  dispatch_deliveries: number;
}

export interface TestResult {
  ok: boolean;
  events?: number;
  sample?: string[];
  error?: string;
  note?: string;
}

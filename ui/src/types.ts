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
  type: "string" | "number" | "json" | "list";
  required: boolean;
  help: string;
  item?: ConnectorField[];   // for type "list": the sub-fields of each row
}

export interface ConnectorSpec {
  label: string;
  mode: "poll" | "push";
  discover?: boolean;
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
export interface SourceFieldsProfile { sampled: number; fields: SourceField[]; }

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
  summary: { total_metrics: number; relevant: number; hidden: number };
  suggested_key: { name: string; cardinality: number; values_preview: string[]; alternatives: string[] };
  proposed_labels: string[];
  metrics: DiscoverMetric[];
  derived_suggestions: { id: string; label: string; promql: string; event_type: string; field: string; reason: string }[];
  proposed_config: { url: string; default_key: string; queries: unknown[]; labels: { name: string; field: string }[] };
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

export interface TestResult {
  ok: boolean;
  events?: number;
  sample?: string[];
  error?: string;
  note?: string;
}

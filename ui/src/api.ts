import type {
  CatalogDescribe, CatalogList, ConnectorSpec, DiscoverProposal, DispatchLogEntry, Entity, EnvScan,
  LabelFacet, QueryLogEntry, Source, SourceEvent, SourceFieldsProfile, Subscription, TestResult,
  Trigger, View,
} from "./types";

const TOKEN_KEY = "navflow_token";
export const auth = {
  get: () => localStorage.getItem(TOKEN_KEY) ?? "",
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export function authHeader(): Record<string, string> {
  const t = auth.get();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

const AKEY = "navflow_anthropic_key";
export const anthropicKey = {
  get: () => localStorage.getItem(AKEY) ?? "",
  set: (k: string) => localStorage.setItem(AKEY, k),
  clear: () => localStorage.removeItem(AKEY),
};

function unauthorized() {
  auth.clear();
  window.dispatchEvent(new Event("navflow-auth-required"));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...authHeader(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (res.status === 401) {
    unauthorized();
    throw new Error("authentication required");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => request<{ status: string; readonly: boolean; auth_required: boolean }>("/health"),
  connectors: () => request<Record<string, ConnectorSpec>>("/api/connectors"),

  sources: () => request<Source[]>("/api/sources"),
  source: (name: string) => request<Source>(`/api/sources/${name}`),
  createSource: (body: object) =>
    request<{ ok: boolean; name: string; ingest_key: string | null }>(
      "/api/sources", { method: "POST", body: JSON.stringify(body) }),
  updateSource: (name: string, body: object) =>
    request(`/api/sources/${name}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteSource: (name: string, purge: boolean) =>
    request(`/api/sources/${name}?purge_events=${purge}`, { method: "DELETE" }),
  pauseSource: (name: string) => request(`/api/sources/${name}/pause`, { method: "POST" }),
  resumeSource: (name: string) => request(`/api/sources/${name}/resume`, { method: "POST" }),
  testSource: (body: object) =>
    request<TestResult>("/api/sources/test", { method: "POST", body: JSON.stringify(body) }),
  discoverSource: (connector: string, config: Record<string, unknown>) =>
    request<DiscoverProposal>("/api/sources/discover",
      { method: "POST", body: JSON.stringify({ connector, config }) }),
  discoverEnvironment: (provider = "docker") =>
    request<EnvScan>(`/api/discover/environment?provider=${provider}`),
  claudeCodeStatus: () =>
    request<{ available: boolean; root: string; sessions: number; connected: boolean }>(
      "/api/integrations/claude_code"),
  sourceEvents: (name: string, limit = 50) =>
    request<SourceEvent[]>(`/api/sources/${name}/events?limit=${limit}`),
  sourceFields: (name: string) =>
    request<SourceFieldsProfile>(`/api/sources/${name}/fields`),

  views: () => request<View[]>("/api/views"),
  createView: (body: View) =>
    request("/api/views", { method: "POST", body: JSON.stringify(body) }),
  updateView: (name: string, body: View) =>
    request(`/api/views/${name}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteView: (name: string) => request(`/api/views/${name}`, { method: "DELETE" }),

  triggers: () => request<Trigger[]>("/api/triggers"),
  createTrigger: (body: Trigger) =>
    request("/api/triggers", { method: "POST", body: JSON.stringify(body) }),
  updateTrigger: (name: string, body: Trigger) =>
    request(`/api/triggers/${name}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteTrigger: (name: string) => request(`/api/triggers/${name}`, { method: "DELETE" }),

  queries: (limit = 100) => request<QueryLogEntry[]>(`/api/activity/queries?limit=${limit}`),
  dispatches: (limit = 100) =>
    request<DispatchLogEntry[]>(`/api/activity/dispatches?limit=${limit}`),
  subscriptions: () => request<Subscription[]>("/api/subscriptions"),
  mcpTools: () => request<{ name: string; description: string }[]>("/api/mcp/tools"),

  catalog: () => request<CatalogList>("/catalog"),
  describe: (handle: string) => request<CatalogDescribe>(`/catalog/${handle}`),

  entities: (label?: string) =>
    request<{ labels?: LabelFacet[]; label?: string; sources?: string[]; values?: Entity[] }>(
      label ? `/api/entities?label=${encodeURIComponent(label)}` : "/api/entities"),

  // Raw label-native read across ALL sources — no view. `selector` is a {label: value}
  // conjunction (strict AND). Returns the payload plus the sources that actually contributed.
  read: (selector: Record<string, string>, window: string) =>
    request<{ payload: string; count: number; sources: string[] }>("/read", {
      method: "POST",
      body: JSON.stringify({ selector, window, client: "ui" }),
    }),

  runQuery: (view: string, key: string, window: string) =>
    request<{ payload: string }>("/query", {
      method: "POST",
      body: JSON.stringify({ view, key, window, client: "ui" }),
    }),
  runQueryWhere: (view: string, where: Record<string, string>, window: string) =>
    request<{ payload: string }>("/query", {
      method: "POST",
      body: JSON.stringify({ view, where, window, client: "ui" }),
    }),

  exportYaml: async () => {
    const res = await fetch("/api/catalog/export", { headers: authHeader() });
    if (res.status === 401) {
      unauthorized();
      throw new Error("authentication required");
    }
    return res.text();
  },
  importYaml: (yaml: string, mode: "merge" | "replace") =>
    request<{ sources: number; views: number; triggers: number }>("/api/catalog/import", {
      method: "POST",
      body: JSON.stringify({ yaml, mode }),
    }),
};

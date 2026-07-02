import { useEffect, useMemo, useState } from "react";

import { api } from "../api";
import { Close, Search } from "../components/icons";
import { TimeAgo, usePolling } from "../components/bits";
import type { Trigger, View, ViewFilter } from "../types";

const AGGREGATES = ["max", "min", "sum", "avg", "count", "any"];

// Views and Triggers are two acts of "serve to agents": a view is a saved read; a trigger wakes
// an agent when that read crosses a line. They are separate pages so each concept stands alone.

export function ViewsPage() {
  const { data: views, reload } = usePolling(() => api.views(), 10000);
  const { data: sources } = usePolling(() => api.sources(), 10000);

  return (
    <>
      <h1>Views</h1>
      <p className="subtitle">saved reads — <em>the queries you hand agents</em></p>
      <ViewsSection views={views ?? []} sourceNames={(sources ?? []).map((s) => s.name)} onChange={reload} />
    </>
  );
}

export function TriggersPage() {
  const { data: triggers, reload } = usePolling(() => api.triggers(), 10000);
  const { data: views } = usePolling(() => api.views(), 10000);

  return (
    <>
      <h1>Triggers</h1>
      <p className="subtitle">conditions that <em>wake an agent</em> with a timeline</p>
      <TriggersSection triggers={triggers ?? []} viewNames={(views ?? []).map((v) => v.name)} onChange={reload} />
    </>
  );
}

/** Search-box + count toolbar (matches the other crisp tables). */
function FilterBar({ q, setQ, placeholder, shown, total }: {
  q: string; setQ: (s: string) => void; placeholder: string; shown: number; total: number;
}) {
  return (
    <div className="toolbar">
      <div className="search-box">
        <Search />
        <input type="text" className="search" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <span className="grow" />
      <span className="count">{shown} of {total}</span>
    </div>
  );
}

/** Esc-to-close for an open editor sheet. */
function useEscape(active: boolean, close: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, close]);
}

// ── views ────────────────────────────────────────────────────────────────────

function AuthorBadge({ createdBy }: { createdBy?: string }) {
  const isAgent = (createdBy ?? "human").startsWith("agent");
  return (
    <span className={`badge ${isAgent ? "agent" : "starting"}`}
          title={isAgent ? `proposed by an agent via derive() (${createdBy})` : "authored by a human"}>
      {isAgent ? "agent" : "human"}
    </span>
  );
}

function ViewsSection({ views, sourceNames, onChange }:
  { views: View[]; sourceNames: string[]; onChange: () => void }) {
  const [editing, setEditing] = useState<View | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState<string>();
  const [filtersText, setFiltersText] = useState("");
  const [q, setQ] = useState("");

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return views.filter((v) => !needle ||
      v.name.toLowerCase().includes(needle) ||
      v.key_field.toLowerCase().includes(needle) ||
      v.sources.join(" ").toLowerCase().includes(needle));
  }, [views, q]);

  const close = () => { setEditing(null); setError(undefined); };
  useEscape(!!editing, close);

  const openEditor = (v: View, fresh: boolean) => {
    setEditing({ ...v });
    setIsNew(fresh);
    setError(undefined);
    setFiltersText(v.filters?.length ? JSON.stringify(v.filters, null, 2) : "");
  };

  const parseFilters = (): ViewFilter[] | null => {
    if (!filtersText.trim()) return [];
    try {
      const parsed = JSON.parse(filtersText);
      return Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  };

  const save = async () => {
    if (!editing) return;
    setError(undefined);
    const filters = parseFilters();
    if (filters === null) { setError("filters must be a JSON list of {field, op, value}"); return; }
    const body = { ...editing, filters };
    try {
      if (isNew) await api.createView(body);
      else await api.updateView(editing.name, body);
      close();
      onChange();
    } catch (e) { setError(String((e as Error).message ?? e)); }
  };

  const del = async (name: string) => {
    if (!window.confirm(`Delete view "${name}"?`)) return;
    setError(undefined);
    try { await api.deleteView(name); onChange(); }
    catch (e) { setError(String((e as Error).message ?? e)); }
  };

  return (
    <>
      <div className="pagehead">
        <span />
        <button onClick={() => openEditor({ name: "", key_field: "service", sources: [] }, true)}>
          Add view
        </button>
      </div>
      {error && !editing && <div className="alert error">{error}</div>}

      {!views.length && <div className="empty">no views — agents have nothing to query yet</div>}
      {!!views.length && (
        <>
          <FilterBar q={q} setQ={setQ} placeholder="Filter by name, key, source…" shown={shown.length} total={views.length} />
          <table>
            <thead><tr><th>name</th><th>author</th><th>key field</th><th>sources</th><th>filters</th><th>usage</th><th></th></tr></thead>
            <tbody>
              {shown.map((v) => (
                <tr key={v.name}>
                  <td className="mono">{v.name}</td>
                  <td><AuthorBadge createdBy={v.created_by} /></td>
                  <td className="mono">{v.key_field}</td>
                  <td>{v.sources.map((s) => <span className="chip" key={s}>{s}</span>)}</td>
                  <td className="mono">
                    {(v.filters ?? []).map((f, i) => (
                      <span className="chip" key={i}>{f.field} {f.op} {String(f.value)}</span>
                    ))}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {v.usage
                      ? <>{v.usage.queries} {v.usage.queries === 1 ? "query" : "queries"}
                          {v.usage.last_used_at && <> · <TimeAgo ts={v.usage.last_used_at} /></>}</>
                      : <span className="help">never queried</span>}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <span className="btnrow" style={{ justifyContent: "flex-end" }}>
                      <button onClick={() => openEditor(v, false)}>edit</button>
                      <button className="danger" onClick={() => del(v.name)}>delete</button>
                    </span>
                  </td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={7} className="dim" style={{ textAlign: "center", padding: 24 }}>no views match “{q}”</td></tr>}
            </tbody>
          </table>
        </>
      )}

      {editing && (
        <>
          <div className="sheet-overlay" onClick={close} />
          <aside className="sheet" role="dialog" aria-label="View editor">
            <div className="sheet-head">
              <div className="sheet-title">
                <h2>{isNew ? "New view" : <>Edit <span className="mono">{editing.name}</span></>}</h2>
              </div>
              <button className="sheet-close" onClick={close} aria-label="Close"><Close /></button>
            </div>
            <div className="sheet-body">
              {error && <div className="alert error">{error}</div>}
              <div className="row2">
                <label className="field">
                  <span className="lbl">name</span>
                  <input type="text" value={editing.name} disabled={!isNew}
                         onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                </label>
                <label className="field">
                  <span className="lbl">key field</span>
                  <input type="text" value={editing.key_field}
                         onChange={(e) => setEditing({ ...editing, key_field: e.target.value })} />
                  <span className="help">what the entity key means, e.g. service</span>
                </label>
              </div>
              <div className="field">
                <span className="lbl">sources in this view</span>
                {sourceNames.length === 0 && <span className="help">no sources yet</span>}
                {sourceNames.map((s) => (
                  <label key={s} style={{ display: "inline-flex", gap: 6, marginRight: 16, alignItems: "center" }}>
                    <input type="checkbox" checked={editing.sources.includes(s)}
                           onChange={(e) => setEditing({
                             ...editing,
                             sources: e.target.checked
                               ? [...editing.sources, s]
                               : editing.sources.filter((x) => x !== s),
                           })} />
                    <span className="mono">{s}</span>
                  </label>
                ))}
              </div>
              <label className="field">
                <span className="lbl">filters (optional, JSON)</span>
                <textarea className="code" style={{ minHeight: 70 }} value={filtersText}
                          placeholder={'[{"field": "latency_ms", "op": "gt", "value": 1000}]'}
                          onChange={(e) => setFiltersText(e.target.value)} />
                <span className="help">
                  narrow the view: ops eq · neq · contains · gt · lt · gte · lte; applied on reads and trigger eval
                </span>
              </label>
            </div>
            <div className="sheet-foot">
              <button className="primary" onClick={save}>{isNew ? "Create view" : "Save"}</button>
              <button onClick={close}>Cancel</button>
            </div>
          </aside>
        </>
      )}
    </>
  );
}

// ── triggers ─────────────────────────────────────────────────────────────────

const emptyTrigger = (view: string): Trigger => ({
  name: "", view,
  condition: { aggregate: "max", predicate: "> 1.0", window: "1m", field: "" },
  emit: { kind: "", context_window: "15m" },
  cooldown: "5m",
});

function TriggersSection({ triggers, viewNames, onChange }:
  { triggers: Trigger[]; viewNames: string[]; onChange: () => void }) {
  const [editing, setEditing] = useState<Trigger | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState<string>();
  const [q, setQ] = useState("");

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return triggers.filter((t) => !needle ||
      t.name.toLowerCase().includes(needle) ||
      t.view.toLowerCase().includes(needle) ||
      `${t.condition.aggregate} ${t.condition.field ?? ""} ${t.condition.predicate}`.toLowerCase().includes(needle));
  }, [triggers, q]);

  const close = () => { setEditing(null); setError(undefined); };
  useEscape(!!editing, close);

  const save = async () => {
    if (!editing) return;
    setError(undefined);
    const body: Trigger = {
      ...editing,
      condition: { ...editing.condition, field: editing.condition.field || null },
      emit: { ...editing.emit, kind: editing.emit.kind || editing.name },
    };
    try {
      if (isNew) await api.createTrigger(body);
      else await api.updateTrigger(editing.name, body);
      close();
      onChange();
    } catch (e) { setError(String((e as Error).message ?? e)); }
  };

  const del = async (name: string) => {
    if (!window.confirm(`Delete trigger "${name}"?`)) return;
    setError(undefined);
    try { await api.deleteTrigger(name); onChange(); }
    catch (e) { setError(String((e as Error).message ?? e)); }
  };

  return (
    <>
      <div className="pagehead">
        <span />
        <button disabled={!viewNames.length}
                onClick={() => { setEditing(emptyTrigger(viewNames[0])); setIsNew(true); setError(undefined); }}>
          Add trigger
        </button>
      </div>
      {error && !editing && <div className="alert error">{error}</div>}

      {!triggers.length && <div className="empty">no triggers — nothing wakes agents yet</div>}
      {!!triggers.length && (
        <>
          <FilterBar q={q} setQ={setQ} placeholder="Filter by name, view, condition…" shown={shown.length} total={triggers.length} />
          <table>
            <thead><tr><th>name</th><th>view</th><th>condition</th><th>cooldown</th><th></th></tr></thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.name}>
                  <td className="mono">{t.name}</td>
                  <td className="mono">{t.view}</td>
                  <td className="mono">
                    {t.condition.aggregate}({t.condition.field ?? "*"}) {t.condition.predicate} over {t.condition.window}
                  </td>
                  <td className="mono">{t.cooldown}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <span className="btnrow" style={{ justifyContent: "flex-end" }}>
                      <button onClick={() => {
                        setEditing({ ...t, condition: { ...t.condition }, emit: { ...t.emit } });
                        setIsNew(false);
                        setError(undefined);
                      }}>edit</button>
                      <button className="danger" onClick={() => del(t.name)}>delete</button>
                    </span>
                  </td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={5} className="dim" style={{ textAlign: "center", padding: 24 }}>no triggers match “{q}”</td></tr>}
            </tbody>
          </table>
        </>
      )}

      {editing && (
        <>
          <div className="sheet-overlay" onClick={close} />
          <aside className="sheet" role="dialog" aria-label="Trigger editor">
            <div className="sheet-head">
              <div className="sheet-title">
                <h2>{isNew ? "New trigger" : <>Edit <span className="mono">{editing.name}</span></>}</h2>
              </div>
              <button className="sheet-close" onClick={close} aria-label="Close"><Close /></button>
            </div>
            <div className="sheet-body">
              {error && <div className="alert error">{error}</div>}
              <div className="row2">
                <label className="field">
                  <span className="lbl">name</span>
                  <input type="text" value={editing.name} disabled={!isNew}
                         onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                </label>
                <label className="field">
                  <span className="lbl">view</span>
                  <select value={editing.view} onChange={(e) => setEditing({ ...editing, view: e.target.value })}>
                    {viewNames.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
              </div>
              <div className="row2">
                <label className="field">
                  <span className="lbl">aggregate</span>
                  <select value={editing.condition.aggregate}
                          onChange={(e) => setEditing({ ...editing, condition: { ...editing.condition, aggregate: e.target.value } })}>
                    {AGGREGATES.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span className="lbl">field</span>
                  <input type="text" value={editing.condition.field ?? ""}
                         placeholder="e.g. rate_5xx (empty for count)"
                         onChange={(e) => setEditing({ ...editing, condition: { ...editing.condition, field: e.target.value } })} />
                </label>
              </div>
              <div className="row2">
                <label className="field">
                  <span className="lbl">predicate</span>
                  <input type="text" value={editing.condition.predicate}
                         onChange={(e) => setEditing({ ...editing, condition: { ...editing.condition, predicate: e.target.value } })} />
                  <span className="help">e.g. &gt; 1.0, &gt;= 100, == 0</span>
                </label>
                <label className="field">
                  <span className="lbl">window</span>
                  <input type="text" value={editing.condition.window}
                         onChange={(e) => setEditing({ ...editing, condition: { ...editing.condition, window: e.target.value } })} />
                  <span className="help">detection window, e.g. 1m</span>
                </label>
              </div>
              <div className="row2">
                <label className="field">
                  <span className="lbl">context window</span>
                  <input type="text" value={String(editing.emit.context_window ?? "15m")}
                         onChange={(e) => setEditing({ ...editing, emit: { ...editing.emit, context_window: e.target.value } })} />
                  <span className="help">how much timeline the woken agent receives</span>
                </label>
                <label className="field">
                  <span className="lbl">cooldown</span>
                  <input type="text" value={editing.cooldown}
                         onChange={(e) => setEditing({ ...editing, cooldown: e.target.value })} />
                  <span className="help">minimum gap between firings per key</span>
                </label>
              </div>
            </div>
            <div className="sheet-foot">
              <button className="primary" onClick={save}>{isNew ? "Create trigger" : "Save"}</button>
              <button onClick={close}>Cancel</button>
            </div>
          </aside>
        </>
      )}
    </>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import { Search } from "../components/icons";
import { Combo, TimeAgo, usePolling } from "../components/bits";
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
  const [fRows, setFRows] = useState<Array<{ field: string; op: string; value: string }>>([]);
  const [labelOpts, setLabelOpts] = useState<string[]>([]);   // entity labels/keys — key_field candidates
  const [fieldOpts, setFieldOpts] = useState<string[]>([]);   // every field — for filter rows
  const [q, setQ] = useState("");
  const [confirmDelName, setConfirmDelName] = useState<string | null>(null);

  // Suggest real field/label names from the selected sources, so key_field and filters are
  // picked rather than guessed.
  useEffect(() => {
    if (!editing?.sources.length) { setLabelOpts([]); setFieldOpts([]); return; }
    let live = true;
    Promise.all(editing.sources.map((s) => api.sourceFields(s).catch(() => null)))
      .then((profiles) => {
        if (!live) return;
        const labels = new Set<string>();
        const names = new Set<string>();
        for (const p of profiles) {
          for (const f of p?.fields ?? []) {
            names.add(f.name);
            if (f.is_label || f.is_key) labels.add(f.name);   // only entity axes fit key_field
          }
        }
        // sources created without declared labels flag nothing — fall back to every field
        // rather than suggesting nothing at all
        setLabelOpts(Array.from(labels.size ? labels : names).sort());
        setFieldOpts(Array.from(names).sort());
      });
    return () => { live = false; };
  }, [editing?.sources.join("|")]);

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
    setFRows((v.filters ?? []).map((f) => ({ field: f.field, op: f.op, value: String(f.value) })));
  };

  const NUMERIC_OPS = new Set(["gt", "lt", "gte", "lte"]);
  const buildFilters = (): ViewFilter[] =>
    fRows.filter((r) => r.field.trim())
      .map((r) => ({ field: r.field.trim(), op: r.op as ViewFilter["op"],
                     value: NUMERIC_OPS.has(r.op) ? Number(r.value) : r.value }));

  const save = async () => {
    if (!editing) return;
    setError(undefined);
    const filters = buildFilters();
    const body = { ...editing, filters };
    try {
      if (isNew) await api.createView(body);
      else await api.updateView(editing.name, body);
      close();
      onChange();
    } catch (e) { setError(String((e as Error).message ?? e)); }
  };

  const del = async (name: string) => {
    setError(undefined);
    try { await api.deleteView(name); onChange(); }
    catch (e) { setError(String((e as Error).message ?? e)); }
  };

  return (
    <>
      <div className="pagehead">
        <span />
        <button disabled={!!editing}
                onClick={() => openEditor({ name: "", key_field: "", sources: [] }, true)}>
          Add view
        </button>
      </div>
      {error && !editing && <div className="alert error">{error}</div>}

      {editing && (
        <div className="panel" style={{ marginBottom: 18 }}>
          <div className="pagehead" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>{isNew ? "New view" : <>Edit <span className="mono">{editing.name}</span></>}</h2>
            <button onClick={close}>Cancel</button>
          </div>
          {error && <div className="alert error">{error}</div>}

          <label className="field" style={{ maxWidth: 340 }}>
            <span className="lbl">name</span>
            <input type="text" value={editing.name} disabled={!isNew} placeholder="e.g. service_timeline"
                   onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <span className="help">agents query it by this name</span>
          </label>

          <div className="field">
            <span className="lbl">sources to correlate</span>
            <span className="help" style={{ display: "block", marginTop: 0, marginBottom: 6 }}>
              events from every ticked source merge into one time-ordered timeline
            </span>
            {sourceNames.length === 0 && <span className="help">no sources yet — add one under Sources first</span>}
            {sourceNames.map((s) => (
              <label key={s} style={{ display: "inline-flex", gap: 6, marginRight: 16, marginBottom: 4, alignItems: "center" }}>
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

          <div className="field" style={{ marginTop: 14 }}>
            <span className="lbl">key field</span>
            <span className="help" style={{ display: "block", marginTop: 0, marginBottom: 6 }}>
              the label agents look an entity up by — pick one the ticked sources share
            </span>
            <Combo value={editing.key_field} options={labelOpts}
                   style={{ maxWidth: 340 }}
                   placeholder={labelOpts.length ? `e.g. ${labelOpts[0]}` : "e.g. service"}
                   onChange={(v) => setEditing({ ...editing, key_field: v })} />
            {labelOpts.length > 0 && (
              <div style={{ marginTop: 6 }}>
                {labelOpts.map((f) => (
                  <button key={f} type="button" className="chip"
                          style={{ cursor: "pointer", marginRight: 6,
                                   outline: editing.key_field === f ? "2px solid var(--accent)" : undefined }}
                          onClick={() => setEditing({ ...editing, key_field: f })}>
                    {f}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="field">
            <span className="lbl">filters (optional)</span>
            <span className="help" style={{ display: "block", marginTop: 0, marginBottom: 6 }}>
              narrow what the view returns — applied on reads and trigger evaluation
            </span>
            {fRows.map((r, i) => (
              <div key={i} className="btnrow" style={{ marginBottom: 6, alignItems: "center" }}>
                <Combo value={r.field} options={fieldOpts} placeholder="field"
                       style={{ maxWidth: 200, flex: 1 }}
                       onChange={(v) => setFRows(fRows.map((x, j) => j === i ? { ...x, field: v } : x))} />
                <select value={r.op} style={{ maxWidth: 130 }}
                        onChange={(e) => setFRows(fRows.map((x, j) => j === i ? { ...x, op: e.target.value } : x))}>
                  {["eq", "neq", "contains", "gt", "lt", "gte", "lte"].map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                <input type="text" className="mono" style={{ maxWidth: 180 }} placeholder="value" value={r.value}
                       onChange={(e) => setFRows(fRows.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
                <button type="button" className="danger" onClick={() => setFRows(fRows.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <button type="button" onClick={() => setFRows([...fRows, { field: "", op: "eq", value: "" }])}>
              + Add filter
            </button>
          </div>

          <div className="btnrow">
            <button className="primary" onClick={save}
                    disabled={!editing.name.trim() || !editing.key_field.trim() || !editing.sources.length}>
              {isNew ? "Create view" : "Save"}
            </button>
            <button onClick={close}>Cancel</button>
          </div>
        </div>
      )}

      {!views.length && !editing && <div className="empty">no views — agents have nothing to query yet</div>}
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
                      <button className="danger" onClick={() => setConfirmDelName(v.name)}>delete</button>
                    </span>
                  </td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={7} className="dim" style={{ textAlign: "center", padding: 24 }}>no views match “{q}”</td></tr>}
            </tbody>
          </table>
        </>
      )}

      {confirmDelName && (
        <ConfirmDialog
          title={`Delete view "${confirmDelName}"?`}
          message="Triggers that read this view will stop working. This can't be undone."
          confirmLabel="Delete view" danger
          onCancel={() => setConfirmDelName(null)}
          onConfirm={() => { const n = confirmDelName; setConfirmDelName(null); del(n); }}
        />
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
  const [confirmDelName, setConfirmDelName] = useState<string | null>(null);

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
    setError(undefined);
    try { await api.deleteTrigger(name); onChange(); }
    catch (e) { setError(String((e as Error).message ?? e)); }
  };

  return (
    <>
      <div className="pagehead">
        <span />
        <button disabled={!viewNames.length}
                title={viewNames.length ? undefined : "a trigger watches a view — create a view first"}
                onClick={() => { setEditing(emptyTrigger(viewNames[0])); setIsNew(true); setError(undefined); }}>
          Add trigger
        </button>
      </div>
      {error && !editing && <div className="alert error">{error}</div>}

      {!viewNames.length && (
        <div className="alert">
          A trigger is a condition evaluated over a <strong>view</strong>, and this instance has no
          views yet — <Link to="/views">create a view</Link> first (pick the sources and the entity
          key it correlates by), then come back and add a trigger on it.
        </div>
      )}

      {editing && (
        <div className="panel" style={{ marginBottom: 18 }}>
          <div className="pagehead" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>{isNew ? "New trigger" : <>Edit <span className="mono">{editing.name}</span></>}</h2>
            <button onClick={close}>Cancel</button>
          </div>
          {error && <div className="alert error">{error}</div>}
          <div className="row2">
            <label className="field">
              <span className="lbl">name</span>
              <input type="text" value={editing.name} disabled={!isNew} placeholder="e.g. error_spike"
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
          <div className="btnrow">
            <button className="primary" onClick={save} disabled={!editing.name.trim()}>
              {isNew ? "Create trigger" : "Save"}
            </button>
            <button onClick={close}>Cancel</button>
          </div>
        </div>
      )}

      {!triggers.length && !!viewNames.length && !editing && <div className="empty">no triggers — nothing wakes agents yet</div>}
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
                      <button className="danger" onClick={() => setConfirmDelName(t.name)}>delete</button>
                    </span>
                  </td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={5} className="dim" style={{ textAlign: "center", padding: 24 }}>no triggers match “{q}”</td></tr>}
            </tbody>
          </table>
        </>
      )}

      {confirmDelName && (
        <ConfirmDialog
          title={`Delete trigger "${confirmDelName}"?`}
          message="It will stop firing. This can't be undone."
          confirmLabel="Delete trigger" danger
          onCancel={() => setConfirmDelName(null)}
          onConfirm={() => { const n = confirmDelName; setConfirmDelName(null); del(n); }}
        />
      )}
    </>
  );
}

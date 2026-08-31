import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import { Search } from "../components/icons";
import { EmptyState, ErrorState, Picker, TimeAgo, usePolling } from "../components/bits";
import type { Trigger, View } from "../types";

// Views and Triggers are two acts of "serve to agents": a view is a saved read; a trigger wakes
// an agent when that read crosses a line. They are separate pages so each concept stands alone.

export function ViewsPage() {
  const { data: views, error, reload } = usePolling(() => api.views(), 10000);
  const { data: triggers } = usePolling(() => api.triggers(), 15000);

  return (
    <>
      <h1>Views</h1>
      <p className="subtitle">saved reads; <em>the queries you hand agents</em></p>
      <ViewsSection views={views ?? []} triggers={triggers ?? []} loadError={error} onChange={reload} />
    </>
  );
}

export function TriggersPage() {
  const { data: triggers, error, reload } = usePolling(() => api.triggers(), 10000);
  const { data: views, error: viewsError } = usePolling(() => api.views(), 10000);

  return (
    <>
      <h1>Triggers</h1>
      <p className="subtitle">conditions that <em>wake an agent</em> with a timeline</p>
      {/* Either fetch failing is enough to make "no triggers" / "no views yet" a lie. */}
      <TriggersSection triggers={triggers ?? []} viewNames={(views ?? []).map((v) => v.name)}
                       loadError={error ?? viewsError} onChange={reload} />
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

// ── views ────────────────────────────────────────────────────────────────────

function ViewsSection({ views, triggers, loadError, onChange }:
  { views: View[]; triggers: Trigger[]; loadError?: string; onChange: () => void }) {
  const [error, setError] = useState<string>();
  const [q, setQ] = useState("");
  const [source, setSource] = useState("all");
  const [trigger, setTrigger] = useState("all");
  const [confirmDelName, setConfirmDelName] = useState<string | null>(null);

  const sourceOptions = useMemo(
    () => Array.from(new Set(views.flatMap((v) => v.sources))).sort(), [views]);
  const triggerOptions = useMemo(
    () => Array.from(new Set(triggers.map((t) => t.name))).sort(), [triggers]);
  const watchedBy = useMemo(() => {
    const t = triggers.find((x) => x.name === trigger);
    return t?.view;
  }, [triggers, trigger]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return views.filter((v) =>
      (source === "all" || v.sources.includes(source)) &&
      (trigger === "all" || v.name === watchedBy) &&
      (!needle || v.name.toLowerCase().includes(needle)));
  }, [views, q, source, trigger, watchedBy]);

  const del = async (name: string) => {
    setError(undefined);
    try { await api.deleteView(name); onChange(); }
    catch (e) { setError(String((e as Error).message ?? e)); }
  };

  return (
    <>
      <div className="pagehead">
        <span />
        <Link className="btn primary" to="/views/new">Add view</Link>
      </div>
      {error && <div className="alert error">{error}</div>}
      {loadError && <ErrorState error={loadError} what="views" onRetry={onChange} />}

      {!views.length && !loadError && (
        <EmptyState>no views; agents have nothing to query yet</EmptyState>
      )}
      {!!views.length && (
        <>
          <div className="toolbar">
            <div className="search-box">
              <Search />
              <input type="text" className="search" placeholder="Filter by name…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <Picker value={source} onChange={setSource} ariaLabel="filter by source"
                    style={{ width: 180 }}
                    options={["all", ...sourceOptions]}
                    labels={{ all: "All sources" }} />
            <Picker value={trigger} onChange={setTrigger} ariaLabel="filter by trigger"
                    style={{ width: 180 }}
                    options={["all", ...triggerOptions]}
                    labels={{ all: "All triggers" }} />
            <span className="grow" />
            <span className="count">{shown.length} of {views.length}</span>
          </div>
          <table>
            <thead><tr><th>name</th><th>key field</th><th>sources</th><th>filters</th><th>usage</th><th></th></tr></thead>
            <tbody>
              {shown.map((v) => (
                <tr key={v.name}>
                  <td className="mono"><Link to={`/views/${encodeURIComponent(v.name)}`}>{v.name}</Link></td>
                  <td className="mono">{v.key_field}</td>
                  <td>
                    {v.sources.slice(0, 2).map((s) => <span className="chip" key={s}>{s}</span>)}
                    {v.sources.length > 2 && (
                      <span className="chip dim" title={v.sources.slice(2).join(", ")}>
                        +{v.sources.length - 2} more</span>
                    )}
                  </td>
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
                    <span className="btnrow" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                      <Link className="btn" to={`/triggers/new?view=${encodeURIComponent(v.name)}`}
                            title="create a trigger watching this view">+ trigger</Link>
                      <Link className="btn" to={`/views/${encodeURIComponent(v.name)}?edit=1`}>edit</Link>
                      <button className="danger" onClick={() => setConfirmDelName(v.name)}>delete</button>
                    </span>
                  </td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={6} className="dim" style={{ textAlign: "center", padding: 24 }}>no views match the filter</td></tr>}
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

function TriggersSection({ triggers, viewNames, loadError, onChange }:
  { triggers: Trigger[]; viewNames: string[]; loadError?: string; onChange: () => void }) {
  const [error, setError] = useState<string>();
  const [q, setQ] = useState("");
  const [confirmDelName, setConfirmDelName] = useState<string | null>(null);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return triggers.filter((t) => !needle ||
      t.name.toLowerCase().includes(needle) ||
      t.view.toLowerCase().includes(needle) ||
      `${t.condition.aggregate}${t.condition.field ?? ""}${t.condition.predicate}`.toLowerCase().includes(needle));
  }, [triggers, q]);

  const del = async (name: string) => {
    setError(undefined);
    try { await api.deleteTrigger(name); onChange(); }
    catch (e) { setError(String((e as Error).message ?? e)); }
  };

  const togglePause = async (t: Trigger) => {
    setError(undefined);
    try { await (t.paused ? api.resumeTrigger(t.name) : api.pauseTrigger(t.name)); onChange(); }
    catch (e) { setError(String((e as Error).message ?? e)); }
  };

  return (
    <>
      <div className="pagehead">
        <span />
        <Link className="btn primary" to="/triggers/new"
              style={!viewNames.length ? { pointerEvents: "none", opacity: 0.5 } : undefined}
              title={viewNames.length ? undefined : "a trigger watches a view; create a view first"}>
          Add trigger
        </Link>
      </div>
      {error && <div className="alert error">{error}</div>}
      {loadError && <ErrorState error={loadError} what="triggers" onRetry={onChange} />}

      {!viewNames.length && !loadError && (
        <div className="alert">
          A trigger is a condition evaluated over a <strong>view</strong>, and this instance has no
          views yet; <Link to="/views/new">create a view</Link> first (pick the sources and the
          entity key it correlates by), then come back and add a trigger on it.
        </div>
      )}
      {!triggers.length && !!viewNames.length && !loadError && (
        <EmptyState>no triggers; nothing wakes agents yet</EmptyState>
      )}
      {!!triggers.length && (
        <>
          <FilterBar q={q} setQ={setQ} placeholder="Filter by name, view, condition…" shown={shown.length} total={triggers.length} />
          <table>
            <thead><tr><th>name</th><th>view</th><th>condition</th><th>cooldown</th><th></th></tr></thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.name} style={t.paused ? { opacity: 0.55 } : undefined}>
                  <td className="mono">
                    <Link to={`/triggers/${encodeURIComponent(t.name)}`}>{t.name}</Link>
                    {t.paused && <span className="badge starting" style={{ marginLeft: 8 }} title="paused; not evaluated, never fires until resumed">paused</span>}
                  </td>
                  <td className="mono"><Link to={`/views/${encodeURIComponent(t.view)}`}>{t.view}</Link></td>
                  <td className="mono">
                    {t.condition.aggregate}({t.condition.field ?? "*"}) {t.condition.predicate} over {t.condition.window}
                  </td>
                  <td className="mono">{t.cooldown}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <span className="btnrow" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                      <Link className="btn" to={`/triggers/${encodeURIComponent(t.name)}`}>agents</Link>
                      <button onClick={() => togglePause(t)} title={t.paused ? "resume evaluation" : "stop evaluating and firing this trigger"}>{t.paused ? "resume" : "pause"}</button>
                      <Link className="btn" to={`/triggers/${encodeURIComponent(t.name)}?edit=1`}>edit</Link>
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

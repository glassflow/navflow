import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import { Search } from "../components/icons";
import { TimeAgo, usePolling } from "../components/bits";
import type { Trigger, View } from "../types";

// Views and Triggers are two acts of "serve to agents": a view is a saved read; a trigger wakes
// an agent when that read crosses a line. They are separate pages so each concept stands alone.

export function ViewsPage() {
  const { data: views, reload } = usePolling(() => api.views(), 10000);

  return (
    <>
      <h1>Views</h1>
      <p className="subtitle">saved reads — <em>the queries you hand agents</em></p>
      <ViewsSection views={views ?? []} onChange={reload} />
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
      <TriggersSection triggers={triggers ?? []} viewNames={(views ?? []).map((v) => v.name)}
                       onChange={reload} />
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

function AuthorBadge({ createdBy }: { createdBy?: string }) {
  const isAgent = (createdBy ?? "human").startsWith("agent");
  return (
    <span className={`badge ${isAgent ? "agent" : "starting"}`}
          title={isAgent ? `proposed by an agent via derive() (${createdBy})` : "authored by a human"}>
      {isAgent ? "agent" : "human"}
    </span>
  );
}

function ViewsSection({ views, onChange }:
  { views: View[]; onChange: () => void }) {
  const [error, setError] = useState<string>();
  const [q, setQ] = useState("");
  const [confirmDelName, setConfirmDelName] = useState<string | null>(null);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return views.filter((v) => !needle ||
      v.name.toLowerCase().includes(needle) ||
      v.key_field.toLowerCase().includes(needle) ||
      v.sources.join(" ").toLowerCase().includes(needle));
  }, [views, q]);

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

      {!views.length && <div className="empty">no views — agents have nothing to query yet</div>}
      {!!views.length && (
        <>
          <FilterBar q={q} setQ={setQ} placeholder="Filter by name, key, source…" shown={shown.length} total={views.length} />
          <table>
            <thead><tr><th>name</th><th>author</th><th>key field</th><th>sources</th><th>filters</th><th>usage</th><th></th></tr></thead>
            <tbody>
              {shown.map((v) => (
                <tr key={v.name}>
                  <td className="mono"><Link to={`/views/${encodeURIComponent(v.name)}`}>{v.name}</Link></td>
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
                      <Link className="btn" to={`/triggers/new?view=${encodeURIComponent(v.name)}`}
                            title="create a trigger watching this view">+ trigger</Link>
                      <Link className="btn" to={`/views/${encodeURIComponent(v.name)}?edit=1`}>edit</Link>
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

function TriggersSection({ triggers, viewNames, onChange }:
  { triggers: Trigger[]; viewNames: string[]; onChange: () => void }) {
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

  return (
    <>
      <div className="pagehead">
        <span />
        <Link className="btn primary" to="/triggers/new"
              style={!viewNames.length ? { pointerEvents: "none", opacity: 0.5 } : undefined}
              title={viewNames.length ? undefined : "a trigger watches a view — create a view first"}>
          Add trigger
        </Link>
      </div>
      {error && <div className="alert error">{error}</div>}

      {!viewNames.length && (
        <div className="alert">
          A trigger is a condition evaluated over a <strong>view</strong>, and this instance has no
          views yet — <Link to="/views/new">create a view</Link> first (pick the sources and the
          entity key it correlates by), then come back and add a trigger on it.
        </div>
      )}
      {!triggers.length && !!viewNames.length && <div className="empty">no triggers — nothing wakes agents yet</div>}
      {!!triggers.length && (
        <>
          <FilterBar q={q} setQ={setQ} placeholder="Filter by name, view, condition…" shown={shown.length} total={triggers.length} />
          <table>
            <thead><tr><th>name</th><th>view</th><th>condition</th><th>cooldown</th><th></th></tr></thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.name}>
                  <td className="mono"><Link to={`/triggers/${encodeURIComponent(t.name)}`}>{t.name}</Link></td>
                  <td className="mono"><Link to={`/views/${encodeURIComponent(t.view)}`}>{t.view}</Link></td>
                  <td className="mono">
                    {t.condition.aggregate}({t.condition.field ?? "*"}) {t.condition.predicate} over {t.condition.window}
                  </td>
                  <td className="mono">{t.cooldown}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <span className="btnrow" style={{ justifyContent: "flex-end" }}>
                      <Link className="btn" to={`/triggers/${encodeURIComponent(t.name)}`}>agents</Link>
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

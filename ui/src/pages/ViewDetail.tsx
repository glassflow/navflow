import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { api } from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import ViewEditor from "../components/ViewEditor";
import { ErrorState, TimeAgo, usePolling } from "../components/bits";

// The home of one view: read-only by default (definition, usage, watching triggers), with
// in-place editing via the Edit button (?edit=1 opens it directly, e.g. from the list).
export default function ViewDetail() {
  const { name = "" } = useParams();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [editing, setEditing] = useState(params.get("edit") === "1");
  const [confirmDel, setConfirmDel] = useState(false);
  const [delErr, setDelErr] = useState<string>();
  const { data: views, error, reload } = usePolling(() => api.views(), 10000);
  // Error kept: this drives what the DELETE dialog says is at stake, and a failed load must not
  // read as "no triggers watch this view".
  const { data: triggers, error: triggersError } = usePolling(() => api.triggers(), 10000);
  const { data: sources } = usePolling(() => api.sources(), 15000);

  if (error) return <div className="alert error">{error}</div>;
  if (!views) return <div className="dim">loading…</div>;
  const view = views.find((v) => v.name === name);
  if (!view) {
    return (
      <div className="alert error">
        no view named <span className="mono">{name}</span> — see <Link to="/views">Views</Link>
      </div>
    );
  }
  const watchers = (triggers ?? []).filter((t) => t.view === name);

  return (
    <>
      <div className="pagehead">
        <div>
          <h1><span className="mono">{view.name}</span></h1>
          <p className="subtitle">
            one read returns the correlated timeline of a <span className="mono">{view.key_field}</span>
          </p>
        </div>
        <span className="btnrow">
          <Link className="btn" to={`/triggers/new?view=${encodeURIComponent(view.name)}`}>+ trigger</Link>
          {!editing && <button className="primary" onClick={() => setEditing(true)}>Edit</button>}
          {!editing && <button className="danger" onClick={() => setConfirmDel(true)}>Delete</button>}
        </span>
      </div>

      {delErr && <div className="alert error">{delErr}</div>}

      {editing && (
        <ViewEditor initial={view} sourceNames={(sources ?? []).map((x) => x.name)}
                    onSaved={() => { setEditing(false); reload(); }}
                    onCancel={() => setEditing(false)} />
      )}

      {!editing && (
      <div className="panel">
        <table>
          <tbody>
            <tr><td className="help" style={{ width: 140 }}>key field</td>
                <td className="mono">{view.key_field}</td></tr>
            <tr><td className="help">sources</td>
                <td>{view.sources.map((s) => (
                  <Link key={s} to={`/sources/${s}`} className="chip mono">{s}</Link>))}</td></tr>
            <tr><td className="help">filters</td>
                <td className="mono">
                  {(view.filters ?? []).length
                    ? (view.filters ?? []).map((f, i) => (
                        <span className="chip" key={i}>{f.field} {f.op} {String(f.value)}</span>))
                    : <span className="help">none — everything the sources carry</span>}
                </td></tr>
            <tr><td className="help">author</td>
                <td>{(view.created_by ?? "human").startsWith("agent")
                      ? <span className="badge agent">agent</span>
                      : <span className="badge starting">human</span>}</td></tr>
            <tr><td className="help">usage</td>
                <td>{view.usage?.queries
                      ? <>{view.usage.queries} quer{view.usage.queries === 1 ? "y" : "ies"}
                          {view.usage.last_used_at && <> · last <TimeAgo ts={view.usage.last_used_at} /></>}</>
                      : <span className="help">never queried</span>}</td></tr>
          </tbody>
        </table>
      </div>
      )}

      <h2>Triggers watching this view</h2>
      {triggersError && <ErrorState error={triggersError} what="the triggers watching this view" />}
      {!triggersError && watchers.length === 0 && (
        <p className="help" style={{ whiteSpace: "normal" }}>
          none — <Link to={`/triggers/new?view=${encodeURIComponent(view.name)}`}>create one</Link> to
          wake agents when a condition trips on this timeline
        </p>
      )}
      {watchers.length > 0 && (
        <table>
          <thead><tr><th>trigger</th><th>condition</th><th>cooldown</th></tr></thead>
          <tbody>
            {watchers.map((t) => (
              <tr key={t.name}>
                <td className="mono"><Link to={`/triggers/${encodeURIComponent(t.name)}`}>{t.name}</Link></td>
                <td className="mono">
                  {t.condition.aggregate}({t.condition.field ?? "*"}) {t.condition.predicate} over {t.condition.window}
                </td>
                <td className="mono">{t.cooldown}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {confirmDel && (
        <ConfirmDialog
          title={`Delete view ${view.name}?`}
          message={triggersError
            // A failed load must never produce the calmer of the two messages — see TriggerDetail.
            ? `Couldn’t check which triggers watch this view (${triggersError}) — deleting may break more than is shown here. This can’t be undone.`
            : watchers.length
              ? `${watchers.length} trigger(s) watch this view and will stop working. Agents querying it will start failing.`
              : "Agents querying this view will start failing. This can't be undone."}
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmDel(false)}
          onConfirm={async () => {
            setDelErr(undefined);
            try { await api.deleteView(view.name); nav("/views"); }
            catch (e) { setDelErr(String((e as Error).message ?? e)); setConfirmDel(false); }
          }}
        />
      )}
    </>
  );
}

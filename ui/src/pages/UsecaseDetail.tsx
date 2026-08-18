import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { api } from "../api";
import { ErrorState, TimeAgo, usePolling } from "../components/bits";
import ConfirmDialog from "../components/ConfirmDialog";
import type { UsecaseObject, UsecaseSummary } from "../types";

// One use case instance: what it created, what it has done lately, and the actions on the whole
// (pause, resume, edit, delete). The objects are ordinary; this page is the combined view of them,
// so every row links out to the object's own page. A hand-deleted object shows as missing with a
// Repair button that re-creates it from the plan.

const OBJECT_ROUTE: Record<UsecaseObject["kind"], (name: string) => string> = {
  source: (n) => `/sources/${encodeURIComponent(n)}`,
  view: (n) => `/views/${encodeURIComponent(n)}`,
  trigger: (n) => `/triggers/${encodeURIComponent(n)}`,
  agent: (n) => `/agents/${encodeURIComponent(n)}`,
  mcp_server: () => "/mcp-servers",
};
const KIND_LABEL: Record<UsecaseObject["kind"], string> = {
  source: "source", view: "view", trigger: "trigger", agent: "agent", mcp_server: "MCP server",
};
const KIND_ORDER: UsecaseObject["kind"][] = ["source", "view", "trigger", "mcp_server", "agent"];

function statusClass(s: string | undefined) {
  return s === "active" || s === "ok" ? "ok"
    : s === "paused" || s === "running" || s === "empty" ? "paused"
    : "error";
}

// A PR link the recipe found in a finding, or the first github.com URL in the finding text.
function prLink(r: { pr_url?: string | null; finding?: string | null }): string | undefined {
  if (r.pr_url) return r.pr_url;
  const m = r.finding?.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
  return m?.[0];
}

export default function UsecaseDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { data: s, error, reload } = usePolling(() => api.usecaseSummary(id), 10000);
  const [actionError, setActionError] = useState<string>();
  const [confirmDel, setConfirmDel] = useState(false);
  const [purge, setPurge] = useState(false);
  const [busyKey, setBusyKey] = useState<string>();

  const act = (fn: () => Promise<unknown>) => async () => {
    setActionError(undefined);
    try { await fn(); reload(); } catch (e) { setActionError(String((e as Error).message ?? e)); }
  };
  const repair = async (key: string) => {
    setBusyKey(key); setActionError(undefined);
    try { await api.repairUsecase(id, key); reload(); }
    catch (e) { setActionError(String((e as Error).message ?? e)); }
    setBusyKey(undefined);
  };
  const remove = async () => {
    setConfirmDel(false);
    try { await api.deleteUsecase(id, purge); navigate("/usecases", { replace: true }); }
    catch (e) { setActionError(String((e as Error).message ?? e)); }
  };

  if (error && !s) return <ErrorState error={error} what="this use case" onRetry={reload} />;
  if (!s) return <div className="dim">loading…</div>;

  const objects = [...s.objects].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const missing = objects.filter((o) => o.missing);
  const sourceObjects = objects.filter((o) => o.kind === "source");
  const repos = s.repos;
  const runs = s.runs;
  const p = s.params as Record<string, unknown>;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>{s.name}</h1>
          <p className="subtitle">
            {s.recipe_title} · <span className={`badge ${statusClass(s.status)}`}>{s.status}</span>
            {s.status === "paused" && <span className="help" style={{ marginLeft: 8 }}>sources keep ingesting; the trigger and agent are off</span>}
          </p>
        </div>
        <div className="btnrow">
          {s.status === "paused"
            ? <button onClick={act(() => api.resumeUsecase(id))}>Resume</button>
            : <button onClick={act(() => api.pauseUsecase(id))}>Pause</button>}
          <Link className="btn" to={`/usecases/new/${encodeURIComponent(s.recipe)}?edit=${encodeURIComponent(id)}`}>Edit</Link>
          <button className="danger" onClick={() => { setPurge(false); setConfirmDel(true); }}>Delete</button>
        </div>
      </div>

      {error && <ErrorState error={error} what="the latest state" onRetry={reload} />}
      {actionError && <div className="alert error">{actionError}</div>}
      {s.last_error && s.status === "error" && (
        <div className="alert error"><strong>Last error</strong> · <span className="mono">{s.last_error}</span></div>
      )}
      {s.summary_error && <div className="alert warn">summary unavailable: <span className="mono">{s.summary_error}</span></div>}
      {missing.length > 0 && (
        <div className="alert warn">
          {missing.length} object{missing.length === 1 ? " was" : "s were"} deleted by hand. Repair re-creates
          {missing.length === 1 ? " it" : " them"} from the plan; or leave as is if that was the intent.
        </div>
      )}

      <div className="cards">
        <div className="card"><div className="k">repos</div><div className="v">{repos ? repos.length : sourceObjects.length}</div></div>
        <div className="card"><div className="k">runs shown</div><div className="v">{runs ? runs.length : <span className="dim">—</span>}</div></div>
        <div className="card">
          <div className="k">pull requests</div>
          <div className="v">{s.prs ? <>{s.prs.open ?? 0} <small>open</small> {s.prs.merged ?? 0} <small>merged</small></> : <span className="dim">—</span>}</div>
        </div>
        <div className="card"><div className="k">trigger last fired</div><div className="v" style={{ fontSize: 15 }}><TimeAgo ts={s.trigger_last_fired ?? null} /></div></div>
        <div className="card"><div className="k">created</div><div className="v" style={{ fontSize: 15 }}><TimeAgo ts={s.created_at} /></div></div>
      </div>

      {typeof p.context_repo === "string" && (
        <p className="help" style={{ marginTop: -6 }}>
          keeps <a href={`https://github.com/${p.context_repo}`} target="_blank" rel="noreferrer" className="mono">{p.context_repo}</a>
          {typeof p.context_path === "string" && <> under <span className="mono">{p.context_path}</span></>} current
          {p.write_mode === "commit_to_branch" ? ", committing straight to the branch" : " through pull requests"}
        </p>
      )}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Repos</h2>
        {repos && repos.length > 0 ? (
          <table>
            <thead><tr><th>repo</th><th>branch</th><th>last commit</th><th>events</th><th>source</th></tr></thead>
            <tbody>
              {repos.map((r) => (
                <tr key={r.repo}>
                  <td className="mono">{r.repo}</td>
                  <td className="mono">{r.branch || <span className="dim">default</span>}</td>
                  <td><TimeAgo ts={r.last_commit ?? null} /></td>
                  <td>{r.events ?? <span className="dim">—</span>}</td>
                  <td>{r.source ? <Link to={`/sources/${encodeURIComponent(r.source)}`} className="mono">{r.source}</Link> : <span className="dim">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : sourceObjects.length > 0 ? (
          <table>
            <thead><tr><th>source</th><th>state</th></tr></thead>
            <tbody>
              {sourceObjects.map((o) => (
                <tr key={o.key}>
                  <td>{o.missing ? <span className="mono">{o.name}</span> : <Link to={OBJECT_ROUTE.source(o.name)} className="mono">{o.name}</Link>}</td>
                  <td>{o.missing
                    ? <button onClick={() => repair(o.key)} disabled={busyKey === o.key}>{busyKey === o.key ? "repairing…" : "Repair"}</button>
                    : o.customized ? <span className="help">customized</span> : <span className="badge ok">ok</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="empty">no sources yet</div>}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Runs</h2>
        {runs && runs.length > 0 ? (
          <table>
            <thead><tr><th>when</th><th>repo</th><th>status</th><th>rounds</th><th>result</th></tr></thead>
            <tbody>
              {runs.map((r, i) => {
                const link = prLink(r);
                return (
                  <tr key={r.id ?? i}>
                    <td style={{ whiteSpace: "nowrap" }}><TimeAgo ts={r.started_at ?? null} /></td>
                    <td className="mono">{r.key ?? ""}</td>
                    <td><span className={`badge ${statusClass(r.status)}`}>{r.status ?? "?"}</span></td>
                    <td>{r.rounds ?? "?"}{r.max_rounds ? `/${r.max_rounds}` : ""}</td>
                    <td>
                      {link ? <a href={link} target="_blank" rel="noreferrer">pull request</a>
                        : r.finding ? <span className="help">{r.finding.slice(0, 120)}</span>
                        : <span className="dim">—</span>}
                      {r.agent && <> · <Link to={`/agents/${encodeURIComponent(r.agent)}`} className="help">agent</Link></>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="empty">
            no runs yet; the agent runs when the trigger fires
            {objects.find((o) => o.kind === "agent" && !o.missing) && (
              <>; see <Link to={OBJECT_ROUTE.agent(objects.find((o) => o.kind === "agent")!.name)}>the agent</Link> for its history</>
            )}
          </div>
        )}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>What it created</h2>
        <p className="help" style={{ marginTop: 0 }}>
          Ordinary objects, on their normal pages. Edit them there; the use case keeps your version.
        </p>
        <table>
          <thead><tr><th>kind</th><th>name</th><th>state</th><th aria-label="actions" /></tr></thead>
          <tbody>
            {objects.map((o) => (
              <tr key={o.kind + o.key}>
                <td className="help">{KIND_LABEL[o.kind]}</td>
                <td>{o.missing ? <span className="mono dim">{o.name}</span> : <Link to={OBJECT_ROUTE[o.kind](o.name)} className="mono">{o.name}</Link>}</td>
                <td>{o.missing ? <span className="badge error">missing</span> : o.customized ? <span className="help">customized</span> : <span className="badge ok">ok</span>}</td>
                <td>
                  {o.missing && (
                    <div className="btnrow" style={{ justifyContent: "flex-end" }}>
                      <button onClick={() => repair(o.key)} disabled={busyKey === o.key}>{busyKey === o.key ? "repairing…" : "Repair"}</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="panel uc-how">
        <summary>How it works</summary>
        <ol className="help" style={{ margin: "8px 0 0", paddingLeft: 20 }}>
          <li>Each source repo is a commits source keyed by repo; the view puts every repo on its own timeline.</li>
          <li>The trigger fires when commits land, once per repo per cooldown, with the recent commits attached.</li>
          <li>The agent reads each diff through the GitHub MCP server, updates that repo's page in the context repo, and writes a finding on the timeline.</li>
          <li>Pause stops the trigger and agent; sources keep ingesting so the timeline stays complete.</li>
        </ol>
      </details>

      {s.log && s.log.length > 0 && (
        <details className="panel uc-how">
          <summary>History</summary>
          <table style={{ marginTop: 8 }}>
            <tbody>
              {s.log.map((l, i) => (
                <tr key={i}>
                  <td style={{ whiteSpace: "nowrap" }}><TimeAgo ts={l.at} /></td>
                  <td className="mono">{l.action}</td>
                  <td className="help">{l.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {confirmDel && (
        <ConfirmDialog
          title={`Delete ${s.name}?`}
          message="Deletes the sources, view, trigger, MCP server and agent this use case created. Events already stored stay unless you purge them."
          confirmLabel="Delete use case" danger onConfirm={remove} onCancel={() => setConfirmDel(false)}>
          <label className="check" style={{ marginTop: 10, display: "block" }}>
            <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />{" "}
            also purge the events its sources ingested
          </label>
        </ConfirmDialog>
      )}
    </>
  );
}

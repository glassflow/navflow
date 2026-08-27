import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { api } from "../api";
import { ErrorState, Picker, TimeAgo, usePolling } from "../components/bits";
import ConfirmDialog from "../components/ConfirmDialog";
import type { Recipe, RecipeActionOption, UsecaseObject, UsecaseSummary } from "../types";
import InfoDialog, { HelpButton } from "../components/InfoDialog";
import { ProposalsPanel, SessionsPanel } from "../components/ChallengerSessions";

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

const HOW_IT_WORKS: Record<string, string[]> = {
  shared_code_context: [
    "Each source repo is a commits source keyed by repo; the view puts every repo on its own timeline.",
    "The trigger fires when commits land, once per repo per cooldown, with the recent commits attached.",
    "The agent reads each diff through the GitHub MCP server, updates the context repo, and writes a finding on the timeline.",
    "Pause stops the trigger and agent; sources keep ingesting so the timeline stays complete.",
  ],
  ai_sre_demo: [
    "Three sources keyed by service: Prometheus metrics, the api-server's container logs, and the alerts Prometheus's own rules fire.",
    "The service_timeline view merges them on one clock; Explore shows exactly what an agent reads.",
    "The incident trigger fires when an alert event lands (Prometheus keeps owning alerting; nothing is re-thresholded).",
    "incident-first-look wakes with the correlated timeline and writes an incident note back onto it. Cause an incident above and watch it happen.",
  ],
  challenger_workflow: [
    "In Claude Code, /tares:challenger marks the session; the plugin then runs Codex on the plan when you leave plan mode and on every commit, and blocks on P1/P2 findings until fixed or waived.",
    "The plugin streams the session, with every Codex review, into the claude_code source, keyed by session.",
    "When the session ends, the trigger fires and the summarizer reads the whole session and writes a summary with memory proposals.",
    "Accept a proposal below to store it as project memory; the plugin gives it to Claude at the start of the next session on that project.",
  ],
  default: [
    "The use case created ordinary sources, views, triggers and agents; see Configuration for the list.",
    "Pause stops the trigger and agent; sources keep ingesting so the timeline stays complete.",
  ],
};

export default function UsecaseDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { data: s, error, reload } = usePolling(() => api.usecaseSummary(id), 10000);
  const [actionError, setActionError] = useState<string>();
  const [tab, setTab] = useState<"runs" | "config" | "sessions">(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    return t === "config" || t === "sessions" ? t : "runs";
  });
  const [confirmDel, setConfirmDel] = useState(false);
  const [purge, setPurge] = useState(false);
  const [busyKey, setBusyKey] = useState<string>();
  const [recipe, setRecipe] = useState<Recipe>();
  const [actionArgs, setActionArgs] = useState<Record<string, string>>({});
  const [actionMsg, setActionMsg] = useState<string>();
  const [actionBusy, setActionBusy] = useState<string>();
  const [actionHelp, setActionHelp] = useState(false);
  // a use case with sessions opens on them unless the URL asked for a tab
  useEffect(() => {
    if (s?.sessions && !new URLSearchParams(window.location.search).get("tab")) setTab("sessions");
  }, [!!s?.sessions]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!s?.recipe) return;
    api.recipes().then((r) => setRecipe(r.recipes.find((x) => x.key === s.recipe))).catch(() => {});
  }, [s?.recipe]);
  const opts = (o?: (string | RecipeActionOption)[]): RecipeActionOption[] =>
    (o ?? []).map((x) => (typeof x === "string" ? { value: x } : x));
  const runActionWith = async (name: string, args: Record<string, unknown>) => {
    setActionBusy(name); setActionError(undefined); setActionMsg(undefined);
    try { const r = await api.usecaseAction(id, name, args); setActionMsg(r.message); reload(); }
    catch (e) { setActionError(String((e as Error).message ?? e)); }
    setActionBusy(undefined);
  };
  const runAction = (name: string, params?: Record<string, { options?: (string | RecipeActionOption)[] }>) => {
    const args: Record<string, unknown> = {};
    for (const [k, spec] of Object.entries(params ?? {})) args[k] = actionArgs[`${name}.${k}`] ?? opts(spec.options)[0]?.value;
    return runActionWith(name, args);
  };

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
        <div className="card"><div className="k">{repos ? "repos" : "sources"}</div><div className="v">{repos ? repos.length : sourceObjects.length}</div></div>
        <div className="card"><div className="k">runs</div><div className="v">{typeof s.runs_total === "number" ? <>{s.runs_total} {typeof s.runs_ok === "number" && <small>{s.runs_ok} ok</small>}</> : runs ? runs.length : <span className="dim">—</span>}</div></div>
        {(s.prs || typeof s.prs_opened === "number") && <div className="card">
          <div className="k">pull requests</div>
          <div className="v">{s.prs ? <>{s.prs.open ?? 0} <small>open</small> {s.prs.merged ?? 0} <small>merged</small></> : typeof s.prs_opened === "number" ? <>{s.prs_opened} <small>opened</small></> : <span className="dim">—</span>}</div>
        </div>}
        <div className="card"><div className="k">trigger last fired</div><div className="v" style={{ fontSize: 15 }}><TimeAgo ts={s.trigger_last_fired ?? s.last_fired ?? null} /></div></div>
        <div className="card"><div className="k">created</div><div className="v" style={{ fontSize: 15 }}><TimeAgo ts={s.created_at} /></div></div>
      </div>


      <details className="panel uc-how" style={{ marginBottom: 14 }}>
        <summary>How it works</summary>
        <ol className="help" style={{ margin: "8px 0 0", paddingLeft: 20 }}>
          {(HOW_IT_WORKS[s.recipe] ?? HOW_IT_WORKS.default).map((t) => <li key={t}>{t}</li>)}
        </ol>
      </details>

      {recipe?.actions && recipe.actions.length > 0 && (
        <div className="panel" style={{ marginBottom: 14 }}>
          {recipe.actions.some((a) => a.intro) && (
            <p className="help" style={{ margin: "0 0 10px" }}>
              {recipe.actions.find((a) => a.intro)?.intro}
              <HelpButton onClick={() => setActionHelp(true)} label="What do these do?" />
            </p>
          )}
          <div className="uc-actions">
            {recipe.actions.map((a) => (
              <span key={a.name} className="uc-actions" title={a.help}>
                {Object.entries(a.params ?? {}).map(([k, spec]) => {
                  const o = opts(spec.options);
                  if (!o.length) {
                    // free-form parameter: a text field; known values (the sessions on this page) are
                    // offered as suggestions, anything else can still be typed
                    const suggestions = k === "session" ? (s.sessions ?? []) : [];
                    const listId = `${a.name}-${k}-suggestions`;
                    return (
                      <span key={k}>
                        <input type="text" placeholder={spec.label ?? k} aria-label={spec.label ?? k}
                               list={suggestions.length ? listId : undefined}
                               value={actionArgs[`${a.name}.${k}`] ?? ""} style={{ width: 300 }}
                               onChange={(e) => setActionArgs({ ...actionArgs, [`${a.name}.${k}`]: e.target.value })} />
                        {suggestions.length > 0 && (
                          <datalist id={listId}>
                            {suggestions.map((x) => (
                              <option key={x.session} value={x.session}>
                                {[x.project, x.branch, x.ended ? "ended" : "live"].filter(Boolean).join(" · ")}
                              </option>
                            ))}
                          </datalist>
                        )}
                      </span>
                    );
                  }
                  return (
                    <Picker key={k} value={actionArgs[`${a.name}.${k}`] ?? o[0]?.value ?? ""}
                            onChange={(v) => setActionArgs({ ...actionArgs, [`${a.name}.${k}`]: v })}
                            options={o.map((x) => x.value)}
                            labels={Object.fromEntries(o.map((x) => [x.value, x.label ?? x.value]))}
                            ariaLabel={spec.label ?? k} style={{ width: 200 }} />
                  );
                })}
                <button className="primary" disabled={!!actionBusy || s.status !== "active"} onClick={() => runAction(a.name, a.params)}>
                  {actionBusy === a.name ? "working…" : a.label}
                </button>
              </span>
            ))}
            {actionMsg && <span className="help">{actionMsg}</span>}
          </div>
          {(() => {
            const cur = recipe.actions.find((a) => a.params?.scenario);
            const o = cur ? opts(cur.params!.scenario.options) : [];
            const sel = cur ? (actionArgs[`${cur.name}.scenario`] ?? o[0]?.value) : undefined;
            const h = o.find((x) => x.value === sel)?.help;
            return h ? <p className="help" style={{ margin: "8px 0 0" }}>{h}</p> : null;
          })()}
        </div>
      )}

      {actionHelp && recipe?.actions && (
        <InfoDialog title="Causing an incident" onClose={() => setActionHelp(false)}>
          {recipe.actions.filter((a) => a.intro).map((a) => <p key={a.name} className="help" style={{ margin: 0 }}>{a.intro}</p>)}
          {recipe.actions.filter((a) => a.params?.scenario).map((a) => (
            <table key={a.name} className="perm-table">
              <thead><tr><th>scenario</th><th>what happens</th></tr></thead>
              <tbody>
                {opts(a.params!.scenario.options).map((x) => (
                  <tr key={x.value}><td className="mono">{x.value}</td><td>{x.help ?? ""}</td></tr>
                ))}
              </tbody>
            </table>
          ))}
          <ul className="help" style={{ margin: 0, paddingLeft: 18 }}>
            {recipe.actions.filter((a) => a.help).map((a) => <li key={a.name}><strong>{a.label}</strong>: {a.help}</li>)}
          </ul>
          {recipe.actions.find((a) => a.docs)?.docs && (
            <p className="help" style={{ margin: 0 }}>
              Walkthrough: <a href={recipe.actions.find((a) => a.docs)!.docs!.url} target="_blank" rel="noreferrer">{recipe.actions.find((a) => a.docs)!.docs!.label}</a>
            </p>
          )}
        </InfoDialog>
      )}

      <div className="tabs">
        {s.sessions && <button className={tab === "sessions" ? "active" : ""} onClick={() => setTab("sessions")}>Sessions</button>}
        <button className={tab === "runs" ? "active" : ""} onClick={() => setTab("runs")}>Runs</button>
        <button className={tab === "config" ? "active" : ""} onClick={() => setTab("config")}>Configuration</button>
      </div>

      {tab === "sessions" && s.sessions && (
        <SessionsPanel sessions={s.sessions} view={s.names?.view ?? "challenger_session"}
                       onSummarize={s.status === "active" ? (sid) => { setActionArgs({ ...actionArgs, "summarize.session": sid }); return runActionWith("summarize", { session: sid }); } : undefined}
                       busy={actionBusy === "summarize"} message={actionMsg} />
      )}

      {tab === "runs" && (<>
      {runs && <ProposalsPanel runs={runs} />}
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Runs</h2>
        {runs && runs.some((r) => r.first_look) && (
          <p className="help" style={{ marginTop: 0 }}>
            Runs marked <span className="badge">first look</span> ran once when the use case started, over each repo's
            recent commits, so the context repo starts current. Every later run is the trigger firing on new commits.
          </p>
        )}
        {runs && runs.length > 0 ? (
          <table>
            <thead><tr><th>when</th><th>{s.sessions ? "session" : "repo"}</th><th>status</th><th>rounds</th><th>result</th></tr></thead>
            <tbody>
              {runs.map((r, i) => {
                const link = prLink(r);
                return (
                  <tr key={r.id ?? i}>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {r.agent && r.id
                        ? <Link to={`/agents/${encodeURIComponent(r.agent)}?run=${encodeURIComponent(r.id)}`}><TimeAgo ts={r.started_at ?? null} /></Link>
                        : <TimeAgo ts={r.started_at ?? null} />}
                    </td>
                    <td className="mono">{r.repo ?? r.key ?? ""}</td>
                    <td>
                      <span className={`badge ${statusClass(r.status)}`}>{r.status ?? "?"}</span>
                      {r.first_look && <span className="badge" style={{ marginLeft: 6 }}>first look</span>}
                    </td>
                    <td>{r.rounds ?? "?"}{r.max_rounds ? `/${r.max_rounds}` : ""}</td>
                    <td>
                      {link ? <a href={link} target="_blank" rel="noreferrer">pull request</a>
                        : r.finding ? <span className="help">{r.finding.slice(0, 120)}</span>
                        : <span className="dim">—</span>}
                      {r.agent && r.id && <> · <Link to={`/agents/${encodeURIComponent(r.agent)}?run=${encodeURIComponent(r.id)}`} className="help">open run</Link></>}
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

      </>)}

      {tab === "config" && (<>
      {s.sources && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Sources</h2>
          <table>
            <thead><tr><th>source</th><th>events</th><th>last event</th></tr></thead>
            <tbody>
              {Object.entries(s.sources).map(([name, st]) => (
                <tr key={name}>
                  <td><Link to={`/sources/${encodeURIComponent(name)}`} className="mono">{name}</Link></td>
                  <td>{st.events}</td>
                  <td><TimeAgo ts={st.last ?? null} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {s.guide && <p className="help" style={{ marginBottom: 0 }}>Walkthrough: <a href={s.guide} target="_blank" rel="noreferrer">{s.guide}</a></p>}
        </div>
      )}
      {(s.context_repo || typeof p.context_repo === "string") && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Context repo</h2>
          <table>
            <thead><tr><th>repo</th><th>branch</th><th>path</th><th>pages</th><th>writes as</th></tr></thead>
            <tbody>
              <tr>
                <td><a href={`https://github.com/${s.context_repo ?? p.context_repo}`} target="_blank" rel="noreferrer" className="mono">{String(s.context_repo ?? p.context_repo)}</a></td>
                <td className="mono">{String(s.context_branch ?? p.context_branch ?? "main")}</td>
                <td className="mono">{String(s.context_path ?? p.context_path ?? "") || "/"}</td>
                <td>{p.layout === "per_repo" ? "one page per source repo plus an index" : "the repo's existing pages, updated in place"}</td>
                <td>{(s.write_mode ?? p.write_mode) === "commit_to_branch" ? "commits straight to the branch" : "pull requests"}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {!s.sources && (
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Source repos</h2>
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
      )}

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

      {s.log && s.log.length > 0 && (
        <details className="panel uc-how">
          <summary>Change history</summary>
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
      </>)}



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

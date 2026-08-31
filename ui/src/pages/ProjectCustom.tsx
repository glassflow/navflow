import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api } from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import TriggerEditor from "../components/TriggerEditor";
import ViewEditor from "../components/ViewEditor";
import { ErrorState, TimeAgo, usePolling } from "../components/bits";
import AgentForm from "../components/AgentForm";
import { RunsTable } from "./AgentDetail";
import type { ProjectSummary } from "../types";

// The reimagined page for hand-assembled projects (template "custom") ONLY; every other project
// keeps the existing page. Everything a project really is, on one page, driven entirely by
// existing APIs: Setup (sources, views and triggers, the latter two editable in place), Firings
// (every dispatch across the project's triggers, with who it went to), Agents (runs and
// configuration inline, exactly like the agent's own page).

const fmtCond = (t: { condition: { aggregate: string; field?: string | null; predicate: string; window: string } }) =>
  `${t.condition.aggregate}(${t.condition.field || "*"}) ${t.condition.predicate} over ${t.condition.window}`;

export default function ProjectCustom({ s, id, reload }: {
  s: ProjectSummary; id: string; reload: () => void;
}) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"setup" | "firings" | "agents">("setup");
  const [focusDispatch, setFocusDispatch] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [confirmDel, setConfirmDel] = useState(false);
  const [purge, setPurge] = useState(false);

  const names = (kind: string) => s.objects.filter((o) => o.kind === kind).map((o) => o.name);
  const { data: sources } = usePolling(() => api.sources(), 10000);
  const { data: views, reload: reloadViews } = usePolling(() => api.views(), 10000);
  const { data: triggers, reload: reloadTriggers } = usePolling(() => api.triggers(), 10000);
  const { data: dispatches, error: dispatchesError } = usePolling(() => api.dispatches(100), 10000);
  const { data: roster } = usePolling(() => api.agents(), 15000);
  const { data: slack } = usePolling(() => api.slackChannels(), 60000);

  const mySources = (sources ?? []).filter((x) => names("source").includes(x.name));
  const myViews = (views ?? []).filter((x) => names("view").includes(x.name));
  const myTriggers = (triggers ?? []).filter((x) => names("trigger").includes(x.name));
  const triggerNames = new Set(myTriggers.map((t) => t.name));
  const firings = (dispatches ?? []).filter((d) => triggerNames.has(d.trigger));

  // Who a trigger delivers to, from the roster (kind + subscribed triggers). The slack id is
  // resolved to a channel name when the bot still sees it, like the trigger page does.
  const channelLabel = (raw: string) => {
    const cid = raw.replace(/^#/, "");
    const hit = (slack?.channels ?? []).find((c) => c.id === cid);
    return hit ? (hit.is_private ? `🔒 ${hit.name}` : `#${hit.name}`) : raw;
  };
  const subscribers = (trigger: string) => (roster?.agents ?? []).filter((a) => a.triggers.includes(trigger));

  const act = (fn: () => Promise<unknown>) => async () => {
    setActionError(undefined);
    try { await fn(); reload(); } catch (e) { setActionError(String((e as Error).message ?? e)); }
  };

  const openInAgents = (dispatchId: string) => { setFocusDispatch(dispatchId); setTab("agents"); };
  // the trigger card lives on the Setup tab; switch there, then scroll once it is rendered
  const showTrigger = (name: string) => {
    setTab("setup");
    setTimeout(() => document.getElementById(`trigger-${name}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>{s.name}</h1>
          <p className="subtitle">
            From existing objects · <span className={`badge ${s.status === "active" ? "ok" : s.status === "paused" ? "paused" : "error"}`}>{s.status}</span>
            {s.status === "paused" && <span className="help" style={{ marginLeft: 8 }}>sources keep ingesting; the triggers and agents are off</span>}
          </p>
        </div>
        <div className="btnrow">
          {s.status === "paused"
            ? <button onClick={act(() => api.resumeProject(id))}>Resume</button>
            : <button onClick={act(() => api.pauseProject(id))}>Pause</button>}
          <Link className="btn" to={`/projects/new/custom?edit=${encodeURIComponent(id)}`}>Edit</Link>
          <button className="danger" onClick={() => { setPurge(false); setConfirmDel(true); }}>Delete</button>
        </div>
      </div>

      {actionError && <div className="alert error">{actionError}</div>}
      {s.last_error && s.status === "error" && (
        <div className="alert error"><strong>Last error</strong> · <span className="mono">{s.last_error}</span></div>
      )}

      <div className="tabs" style={{ marginTop: 6 }}>
        <button className={tab === "setup" ? "active" : ""} onClick={() => setTab("setup")}>Setup</button>
        <button className={tab === "firings" ? "active" : ""} onClick={() => setTab("firings")}>Firings</button>
        <button className={tab === "agents" ? "active" : ""} onClick={() => { setFocusDispatch(undefined); setTab("agents"); }}>Agents</button>
      </div>

      {tab === "setup" && (
        <>
          <h2>Sources</h2>
          {mySources.length ? (
            <table>
              <thead><tr><th>source</th><th>type</th><th>status</th><th className="num">events</th><th>last ingest</th></tr></thead>
              <tbody>
                {mySources.map((x) => (
                  <tr key={x.name} className="clickable" onClick={() => navigate(`/sources/${encodeURIComponent(x.name)}`)}>
                    <td className="mono">{x.name}</td>
                    <td><span className="chip">{x.connector}</span></td>
                    <td>{x.paused ? <span className="badge paused">paused</span>
                      : x.health?.last_error ? <span className="badge error" title={x.health.last_error}>error</span>
                      : <span className="badge ok">ok</span>}</td>
                    <td className="num">{(x.health?.events_total ?? 0).toLocaleString()}</td>
                    <td><TimeAgo ts={x.health?.last_ingest ?? null} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="help">none in this project</p>}

          <h2 style={{ marginTop: 24 }}>Views</h2>
          {myViews.map((v) => <ViewPanel key={v.name} v={v} sourceNames={(sources ?? []).map((x) => x.name)} onSaved={() => { reloadViews(); reload(); }} />)}
          {!myViews.length && <p className="help">none in this project</p>}

          <h2 style={{ marginTop: 24 }}>Triggers</h2>
          {myTriggers.map((t) => (
            <TriggerPanel key={t.name} t={t}
                          viewInProject={myViews.some((v) => v.name === t.view)}
                          lastFired={firings.find((d) => d.trigger === t.name)?.fired_at ?? null}
                          onSaved={() => { reloadTriggers(); reload(); }} />
          ))}
          {!myTriggers.length && <p className="help">none in this project</p>}
        </>
      )}

      {tab === "firings" && (
        <>
          {dispatchesError && <ErrorState error={dispatchesError} what="the firings" />}
          {firings.length ? (
            <table>
              <thead><tr><th>when</th><th>trigger</th><th>entity</th><th>delivered</th><th>agent</th><th>Slack</th></tr></thead>
              <tbody>
                {firings.map((d) => {
                  const subs = subscribers(d.trigger);
                  const tares = subs.filter((a) => a.kind === "tares");
                  const chans = subs.filter((a) => a.kind === "slack");
                  return (
                    <tr key={d.dispatch_id}>
                      <td style={{ whiteSpace: "nowrap" }}><TimeAgo ts={d.fired_at} /></td>
                      <td className="mono">{d.trigger}</td>
                      <td className="mono">{d.key}</td>
                      <td>{d.delivered} of {d.subscribers}
                        {d.error && <span className="help" title={d.error}> · {d.error.slice(0, 60)}</span>}</td>
                      <td>{tares.length
                        ? tares.map((a) => (
                            <a key={a.name} href="#agents" onClick={(e) => { e.preventDefault(); openInAgents(d.dispatch_id); }}
                               className="mono" title="open this firing's run below">{a.name}</a>))
                        : <span className="dim">—</span>}</td>
                      <td>{chans.length
                        ? chans.map((a) => <span key={a.name} className="chip">{channelLabel(a.endpoint || a.name)}</span>)
                        : <span className="dim">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : !dispatchesError && <p className="help">no firings yet across this project's triggers</p>}
        </>
      )}

      {tab === "agents" && (
        <>
          {names("agent").map((n) => (
            <AgentSection key={n} name={n} focusDispatch={focusDispatch}
                          triggerInProject={names("trigger")}
                          onShowTrigger={showTrigger} />))}
          {!names("agent").length && <p className="help">no agents in this project</p>}
        </>
      )}

      {confirmDel && (
        <ConfirmDialog title={`Delete project ${s.name}?`}
          message="Removes the project. Its objects stay in place, no longer part of a project. Events already stored stay unless you purge them."
          confirmLabel="Delete project" danger
          onConfirm={async () => {
            try { await api.deleteProject(id, purge); navigate("/projects", { replace: true }); }
            catch (e) { setActionError(String((e as Error).message ?? e)); setConfirmDel(false); }
          }}
          onCancel={() => setConfirmDel(false)}>
          <label style={{ display: "block", marginTop: 8 }}>
            <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />{" "}
            also purge the events its sources ingested
          </label>
        </ConfirmDialog>
      )}
    </>
  );
}

// One view, as its own page shows it (key field, sources, filters, author, usage), with the same
// in-place editor. "+ trigger" preselects this view on the trigger form.
function ViewPanel({ v, sourceNames, onSaved }: {
  v: import("../types").View; sourceNames: string[]; onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="panel" id={`view-${v.name}`} style={{ marginBottom: 12, scrollMarginTop: 16 }}>
      <div className="pagehead" style={{ marginBottom: 8 }}>
        <div>
          <h3 style={{ margin: 0 }}><span className="mono">{v.name}</span></h3>
          <p className="subtitle" style={{ margin: "2px 0 0" }}>
            one read returns the correlated timeline of a <span className="mono">{v.key_field}</span>
          </p>
        </div>
        <span className="btnrow">
          <Link className="btn" to={`/triggers/new?view=${encodeURIComponent(v.name)}`}>+ trigger</Link>
          {!editing && <button className="primary" onClick={() => setEditing(true)}>Edit</button>}
        </span>
      </div>
      {editing ? (
        <ViewEditor initial={v} sourceNames={sourceNames}
                    onSaved={() => { setEditing(false); onSaved(); }}
                    onCancel={() => setEditing(false)} />
      ) : (
        <table>
          <tbody>
            <tr><td className="help" style={{ width: 140 }}>key field</td><td className="mono">{v.key_field}</td></tr>
            <tr><td className="help">sources</td>
                <td>{v.sources.map((x) => <Link key={x} to={`/sources/${encodeURIComponent(x)}`} className="chip mono">{x}</Link>)}</td></tr>
            <tr><td className="help">filters</td>
                <td className="mono">{(v.filters ?? []).length
                  ? (v.filters ?? []).map((f, i) => <span className="chip" key={i}>{f.field} {f.op} {String(f.value)}</span>)
                  : <span className="help">none; everything the sources carry</span>}</td></tr>
            <tr><td className="help">author</td>
                <td>{(v.created_by ?? "human").startsWith("agent")
                  ? <span className="badge agent">agent</span> : <span className="badge starting">human</span>}</td></tr>
            <tr><td className="help">usage</td>
                <td>{v.usage?.queries
                  ? <>{v.usage.queries} quer{v.usage.queries === 1 ? "y" : "ies"}
                      {v.usage.last_used_at && <> · last <TimeAgo ts={v.usage.last_used_at} /></>}</>
                  : <span className="help">never queried</span>}</td></tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

// One trigger, as its own page shows it, with the same in-place editor and its last firing.
function TriggerPanel({ t, viewInProject, lastFired, onSaved }: {
  t: import("../types").Trigger; viewInProject: boolean; lastFired: string | null; onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="panel" id={`trigger-${t.name}`} style={{ marginBottom: 12, scrollMarginTop: 16 }}>
      <div className="pagehead" style={{ marginBottom: 8 }}>
        <div>
          <h3 style={{ margin: 0 }}><span className="mono">{t.name}</span></h3>
          <p className="subtitle" style={{ margin: "2px 0 0" }}>
            fires when the condition trips, delivering to every subscriber
          </p>
        </div>
        <span className="btnrow">
          {!editing && <button className="primary" onClick={() => setEditing(true)}>Edit</button>}
        </span>
      </div>
      {editing ? (
        <TriggerEditor initial={t}
                       onSaved={() => { setEditing(false); onSaved(); }}
                       onCancel={() => setEditing(false)} />
      ) : (
        <table>
          <tbody>
            <tr><td className="help" style={{ width: 140 }}>watches</td>
                <td>{viewInProject
                  // the view is right above on this page, editable there; scroll, don't navigate
                  ? <a href={`#view-${t.view}`} className="chip mono" title="the view, above on this page"
                       onClick={(e) => { e.preventDefault(); document.getElementById(`view-${t.view}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{t.view}</a>
                  : <Link to={`/views/${encodeURIComponent(t.view)}`} className="chip mono">{t.view}</Link>}</td></tr>
            <tr><td className="help">condition</td><td className="mono">{fmtCond(t)}</td></tr>
            <tr><td className="help">context window</td>
                <td className="mono">{String(t.emit?.context_window ?? "15m")}
                    <span className="help"> · timeline the woken agent receives</span></td></tr>
            <tr><td className="help">cooldown</td>
                <td className="mono">{t.cooldown}<span className="help"> · minimum gap between firings per entity</span></td></tr>
            <tr><td className="help">last fired</td>
                <td>{lastFired ? <TimeAgo ts={lastFired} /> : <span className="dim">never</span>}</td></tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

// One agent, inline and whole: the overview rows and runs from its own page, the configuration
// table beneath, and in-place editing with the same form. A firing row on the Firings tab lands
// here with that firing's run open.
function AgentSection({ name, focusDispatch, triggerInProject, onShowTrigger }: {
  name: string; focusDispatch?: string; triggerInProject: string[]; onShowTrigger: (t: string) => void;
}) {
  const [openRun, setOpenRun] = useState<string>();
  const [editing, setEditing] = useState(false);
  const { data, error, reload } = usePolling(() => api.builtinAgents(), 10000);
  const { data: runs, error: runsError } = usePolling(() => api.builtinAgentRuns(name, 50), 10000);
  const [err, setErr] = useState<string>();
  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <div className="dim">loading…</div>;
  const agent = data.agents.find((a) => a.name === name);
  if (!agent) return <div className="alert error">no Tares agent named <span className="mono">{name}</span></div>;
  const lastRun = runs?.[0];
  const toggle = async () => {
    setErr(undefined);
    try {
      if (agent.enabled) await api.disableBuiltinAgent(name); else await api.enableBuiltinAgent(name);
      reload();
    } catch (e) { setErr(String((e as Error).message ?? e)); }
  };
  return (
    <div style={{ marginBottom: 28 }}>
      <div className="pagehead" style={{ marginBottom: 8 }}>
        <div>
          <h2 style={{ margin: 0 }}><span className="mono">{agent.name}</span>{" "}<span className="badge">Tares agent</span></h2>
        </div>
        <span className="btnrow">
          <button onClick={toggle}>{agent.enabled ? "Disable" : "Enable"}</button>
          {!editing && <button className="primary" onClick={() => setEditing(true)}>Edit</button>}
          <Link className="btn" to={`/agents/${encodeURIComponent(name)}`}>Open its page</Link>
        </span>
      </div>
      {err && <div className="alert error">{err}</div>}
      {editing ? (
        <AgentForm initial={agent}
                   triggers={[agent.trigger]}
                   presets={data.presets} models={data.models} defaultModel={data.default_model}
                   slackWorkspace={data.slack_workspace}
                   defaultMaxRounds={data.default_max_rounds}
                   defaultMaxRoundsWithMcp={data.default_max_rounds_with_mcp}
                   maxRoundsLimit={data.max_rounds_limit}
                   onSaved={() => { setEditing(false); reload(); }}
                   onCancel={() => setEditing(false)} />
      ) : (
        <div className="panel" style={{ marginBottom: 12 }}>
          <table>
            <tbody>
              <tr><td className="help" style={{ width: 150 }}>status</td>
                  <td>{agent.enabled ? <span className="badge ok">enabled</span> : <span className="badge">disabled</span>}
                      {!data.key_configured && <span className="help"> · no Anthropic key; add one under Settings</span>}</td></tr>
              <tr><td className="help">wakes on</td>
                  <td>{triggerInProject.includes(agent.trigger)
                        // the trigger card is on the Setup tab of this page; go there, not away
                        ? <a href={`#trigger-${agent.trigger}`} className="chip mono" title="the trigger, on the Setup tab"
                             onClick={(e) => { e.preventDefault(); onShowTrigger(agent.trigger); }}>{agent.trigger}</a>
                        : <Link to={`/triggers/${encodeURIComponent(agent.trigger)}`} className="chip mono">{agent.trigger}</Link>}
                      <span className="help"> · the trigger that runs this agent</span></td></tr>
              <tr><td className="help">model</td>
                  <td><span className="mono">{agent.model || data.default_model}</span>
                      {!agent.model && <span className="help"> · instance default</span>}</td></tr>
              <tr><td className="help">max rounds</td>
                  <td><span className="mono">{agent.effective_max_rounds}</span></td></tr>
              <tr><td className="help">budget</td>
                  <td>{agent.budget_usd
                    ? <><span className="mono">${agent.budget_usd}</span><span className="help"> · lifetime spend cap</span></>
                    : <span className="dim">—</span>}</td></tr>
              <tr><td className="help">last woken</td>
                  <td>{lastRun ? <><TimeAgo ts={lastRun.started_at} /> for <span className="mono">{lastRun.key}</span></> : <span className="dim">never</span>}</td></tr>
              <tr><td className="help">delivers findings to</td>
                  <td>
                    <span className="chip">the entity's timeline<span className="help"> · always</span></span>{" "}
                    {agent.slack_channel && <span className="chip">Slack channel<span className="help"> · workspace bot</span></span>}{" "}
                    {!agent.slack_channel && agent.slack_configured && <span className="chip">Slack webhook<span className="help"> · legacy</span></span>}{" "}
                    {agent.webhook_url && <span className="chip mono" title={agent.webhook_url}>write-back webhook</span>}
                    {!agent.slack_channel && !agent.slack_configured && !agent.webhook_url &&
                      <span className="help"> · nothing else configured</span>}
                  </td></tr>
              <tr><td className="help">prompt</td>
                  <td><pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0, maxHeight: 180, overflow: "auto" }}>{agent.prompt}</pre></td></tr>
            </tbody>
          </table>
        </div>
      )}
      <h3 style={{ margin: "12px 0 6px" }}>Runs</h3>
      <RunsTable runs={runs} runsError={runsError} agent={agent}
                 focusDispatch={focusDispatch} focusRun={undefined}
                 openRun={openRun} setOpenRun={setOpenRun} />
    </div>
  );
}

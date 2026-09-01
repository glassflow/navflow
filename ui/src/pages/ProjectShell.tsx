import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api } from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import TriggerEditor from "../components/TriggerEditor";
import ViewEditor from "../components/ViewEditor";
import { Combo, Picker, ErrorState, TimeAgo, usePolling } from "../components/bits";
import AgentForm from "../components/AgentForm";
import InfoDialog, { HelpButton } from "../components/InfoDialog";
import { ProposalsPanel, SessionsPanel } from "../components/ChallengerSessions";
import { RunsTable } from "./AgentDetail";
import type { ProjectSummary, Template, RecipeActionOption } from "../types";

// The page for every project: what a project really is, on one page, driven by the live APIs
// plus the template's summary. Setup (sources, views and triggers, the latter two editable in
// place, plus whatever the template declares as panels), Events, Firings (every dispatch across
// the project's triggers, with who it went to), Agents (runs and configuration inline, exactly
// like the agent's own page), and Sessions when the template reports them. Template-specific
// content arrives as data (actions, facts, panels, cards), never as template-specific markup.


const fmtCond = (t: { condition: { aggregate: string; field?: string | null; predicate: string; window: string } }) =>
  `${t.condition.aggregate}(${t.condition.field || "*"}) ${t.condition.predicate} over ${t.condition.window}`;

export default function ProjectShell({ s, id, reload, template }: {
  s: ProjectSummary; id: string; reload: () => void; template?: Template;
}) {
  const navigate = useNavigate();
  const custom = s.template === "custom";
  // ?tab= deep links win; otherwise a project with sessions opens on them
  const [tab, setTab] = useState<"setup" | "events" | "firings" | "agents" | "sessions">(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "setup" || t === "events" || t === "firings" || t === "agents" || (t === "sessions" && s.sessions)) return t;
    return s.sessions ? "sessions" : "setup";
  });
  const [busyKey, setBusyKey] = useState<string>();
  const [actionArgs, setActionArgs] = useState<Record<string, string>>({});
  const [actionMsg, setActionMsg] = useState<string>();
  const [actionBusy, setActionBusy] = useState<string>();
  const [actionHelp, setActionHelp] = useState(false);
  const [focusDispatch, setFocusDispatch] = useState<string>();
  const [openEvent, setOpenEvent] = useState<number>();
  const [actionError, setActionError] = useState<string>();
  const [confirmDel, setConfirmDel] = useState(false);
  const [purge, setPurge] = useState(false);

  const names = (kind: string) => s.objects.filter((o) => o.kind === kind).map((o) => o.name);
  const { data: sources } = usePolling(() => api.sources(), 10000);
  const { data: views, reload: reloadViews } = usePolling(() => api.views(), 10000);
  const { data: triggers, reload: reloadTriggers } = usePolling(() => api.triggers(), 10000);
  const { data: dispatches, error: dispatchesError } = usePolling(() => api.dispatches(100), 10000);
  const { data: roster, reload: reloadRoster } = usePolling(() => api.agents(), 15000);
  const { data: slack } = usePolling(() => api.slackChannels(), 60000);
  // the cheap read: the newest stored rows per source, merged on the client; no filtering, no
  // label unpacking, so it stays fast however big the sources get
  const { data: recent } = usePolling(
    () => Promise.all(names("source").map((n) => api.sourceEvents(n, 30).catch(() => [])))
      .then((lists) => lists.flat().sort((a, b) => (b.ingest_time > a.ingest_time ? 1 : -1)).slice(0, 50)),
    10000);

  const mySources = (sources ?? []).filter((x) => names("source").includes(x.name));
  const myViews = (views ?? []).filter((x) => names("view").includes(x.name));
  const myTriggers = (triggers ?? []).filter((x) => names("trigger").includes(x.name));
  const triggerNames = new Set(myTriggers.map((t) => t.name));
  const firings = (dispatches ?? []).filter((d) => triggerNames.has(d.trigger));
  // Consecutive firings of the same trigger that reached nobody collapse into one row: dozens of
  // identical "0 of 0" lines say one thing — nobody is subscribed — so say it once, with a count.
  const firingRows: (typeof firings[number] & { repeats?: number })[] = [];
  for (const d of firings) {
    const prev = firingRows[firingRows.length - 1];
    if (prev && prev.trigger === d.trigger && prev.subscribers === 0 && d.subscribers === 0) {
      prev.repeats = (prev.repeats ?? 1) + 1;
    } else {
      firingRows.push({ ...d });
    }
  }

  // Who a trigger delivers to, from the roster (kind + subscribed triggers). The slack id is
  // resolved to a channel name when the bot still sees it, like the trigger page does.
  const channelLabel = (raw: string) => {
    const cid = raw.replace(/^#/, "");
    const hit = (slack?.channels ?? []).find((c) => c.id === cid);
    return hit ? (hit.is_private ? `🔒 ${hit.name}` : `#${hit.name}`) : raw;
  };
  const subscribers = (trigger: string) => (roster?.agents ?? []).filter((a) => a.triggers.includes(trigger));

  // subscriber management for the project's triggers (Slack, webhooks; Tares agents wire via
  // their own creation flow). One row per subscription, so remove is exact.
  const [adding, setAdding] = useState<null | "webhook" | "slack">(null);
  const [subTrigger, setSubTrigger] = useState("");
  const [subUrl, setSubUrl] = useState("");
  const [subChannel, setSubChannel] = useState("");
  const [subBusy, setSubBusy] = useState(false);
  const [subMsg, setSubMsg] = useState<string>();
  const [unsub, setUnsub] = useState<{ id: string; label: string } | null>(null);
  const channels = slack?.channels ?? [];
  const subRows = (roster?.agents ?? []).flatMap((a) =>
    a.subscriptions.filter((sub) => triggerNames.has(sub.trigger))
      .map((sub) => ({ a, sub })));
  const addSubscription = async (url: string) => {
    const t = subTrigger || myTriggers[0]?.name;
    if (!t) return;
    setSubBusy(true); setSubMsg(undefined);
    try {
      await api.subscribe(t, url);
      setSubUrl(""); setSubChannel(""); setAdding(null); reload();
    } catch (e) { setSubMsg(String((e as Error).message ?? e)); }
    setSubBusy(false);
  };

  const act = (fn: () => Promise<unknown>) => async () => {
    setActionError(undefined);
    try { await fn(); reload(); } catch (e) { setActionError(String((e as Error).message ?? e)); }
  };
  const opts = (o?: (string | RecipeActionOption)[]): RecipeActionOption[] =>
    (o ?? []).map((x) => (typeof x === "string" ? { value: x } : x));
  const runActionWith = async (name: string, args: Record<string, unknown>) => {
    setActionBusy(name); setActionError(undefined); setActionMsg(undefined);
    try { const r = await api.projectAction(id, name, args); setActionMsg(r.message); reload(); }
    catch (e) { setActionError(String((e as Error).message ?? e)); }
    setActionBusy(undefined);
  };
  const runAction = (name: string, params?: Record<string, { options?: (string | RecipeActionOption)[] }>) => {
    const args: Record<string, unknown> = {};
    for (const [k, spec] of Object.entries(params ?? {})) args[k] = actionArgs[`${name}.${k}`] ?? opts(spec.options)[0]?.value;
    return runActionWith(name, args);
  };
  const repair = async (key: string) => {
    setBusyKey(key); setActionError(undefined);
    try { await api.repairProject(id, key); reload(); }
    catch (e) { setActionError(String((e as Error).message ?? e)); }
    setBusyKey(undefined);
  };
  const missing = s.objects.filter((o) => o.missing);

  const openInAgents = (dispatchId: string) => { setFocusDispatch(dispatchId); setTab("agents"); };
  // a project agent's home is the Agents tab of this page; switch there and scroll to it
  const openAgentTab = (name: string) => {
    setFocusDispatch(undefined); setTab("agents");
    setTimeout(() => document.getElementById(`agent-${name}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };
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
            {s.template_title} · <span className={`badge ${s.status === "active" ? "ok" : s.status === "paused" ? "paused" : "error"}`}>{s.status}</span>
            {s.status === "paused" && <span className="help" style={{ marginLeft: 8 }}>sources keep ingesting; the triggers and agents are off</span>}
          </p>
        </div>
        <div className="btnrow">
          {s.status === "paused"
            ? <button onClick={act(() => api.resumeProject(id))}>Resume</button>
            : <button onClick={act(() => api.pauseProject(id))}>Pause</button>}
          <Link className="btn" to={`/projects/new/${custom ? "custom" : encodeURIComponent(s.template)}?edit=${encodeURIComponent(id)}`}>Edit</Link>
          <button className="danger" onClick={() => { setPurge(false); setConfirmDel(true); }}>Delete</button>
        </div>
      </div>

      {actionError && <div className="alert error">{actionError}</div>}
      {s.last_error && s.status === "error" && (
        <div className="alert error"><strong>Last error</strong> · <span className="mono">{s.last_error}</span></div>
      )}
      {s.summary_error && <div className="alert warn">summary unavailable: <span className="mono">{s.summary_error}</span></div>}
      {missing.length > 0 && (
        <div className="alert warn">
          {missing.length} object{missing.length === 1 ? " was" : "s were"} deleted by hand.{" "}
          {custom
            ? "Edit the project to drop it from the list, or create it again under the same name."
            : <>Repair re-creates{missing.length === 1 ? " it" : " them"} from the plan; or leave as is if that was the intent.{" "}
                {missing.map((o) => (
                  <button key={o.key} onClick={() => repair(o.key)} disabled={busyKey === o.key} style={{ marginLeft: 6 }}>
                    {busyKey === o.key ? "repairing…" : `Repair ${o.name}`}</button>
                ))}</>}
        </div>
      )}

      <div className="cards">
        <div className="card"><div className="k">runs</div>
          <div className="v">{typeof s.runs_total === "number"
            ? <>{s.runs_total} {typeof s.runs_ok === "number" && s.runs_total > 0 && <small>{s.runs_ok} ok</small>}</>
            : <span className="dim">—</span>}</div></div>
        {(s.cards ?? []).map((c) => (
          <div className="card" key={c.label}><div className="k">{c.label}</div><div className="v">{String(c.value)}</div></div>
        ))}
        <div className="card"><div className="k">trigger last fired</div>
          <div className="v" style={{ fontSize: 15 }}><TimeAgo ts={s.trigger_last_fired ?? null} /></div></div>
        <div className="card"><div className="k">created</div>
          <div className="v" style={{ fontSize: 15 }}><TimeAgo ts={s.created_at} /></div></div>
      </div>

      {template?.actions && template.actions.length > 0 && (
        <div className="panel" style={{ marginBottom: 14 }}>
          {template.actions.some((a) => a.intro) && (
            <p className="help" style={{ margin: "0 0 10px" }}>
              {template.actions.find((a) => a.intro)?.intro}
              <HelpButton onClick={() => setActionHelp(true)} label="What do these do?" />
            </p>
          )}
          <div className="uc-actions">
            {template.actions.map((a) => (
              <span key={a.name} className="uc-actions" title={a.help}>
                {Object.entries(a.params ?? {}).map(([k, spec]) => {
                  const o = opts(spec.options);
                  if (!o.length) {
                    const suggestions = k === "session" ? (s.sessions ?? []) : [];
                    return (
                      <Combo key={k} value={actionArgs[`${a.name}.${k}`] ?? ""} placeholder={spec.label ?? k}
                             options={suggestions.map((x) => x.session)} style={{ width: 340 }}
                             hints={Object.fromEntries(suggestions.map((x) => [x.session,
                               [x.repo, x.branch, x.ended ? "ended" : "live"].filter(Boolean).join(" · ")]))}
                             onChange={(v) => setActionArgs({ ...actionArgs, [`${a.name}.${k}`]: v })} />
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
            const cur = template.actions.find((a) => a.params?.scenario);
            const o = cur ? opts(cur.params!.scenario.options) : [];
            const sel = cur ? (actionArgs[`${cur.name}.scenario`] ?? o[0]?.value) : undefined;
            const h = o.find((x) => x.value === sel)?.help;
            return h ? <p className="help" style={{ margin: "8px 0 0" }}>{h}</p> : null;
          })()}
        </div>
      )}
      {actionHelp && template?.actions && (
        <InfoDialog title="What the actions do" onClose={() => setActionHelp(false)}>
          {template.actions.filter((a) => a.intro).map((a) => <p key={a.name} className="help" style={{ margin: 0 }}>{a.intro}</p>)}
          {template.actions.filter((a) => a.params?.scenario).map((a) => (
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
            {template.actions.filter((a) => a.help).map((a) => <li key={a.name}><strong>{a.label}</strong>: {a.help}</li>)}
          </ul>
          {template.actions.find((a) => a.docs)?.docs && (
            <p className="help" style={{ margin: 0 }}>
              Walkthrough: <a href={template.actions.find((a) => a.docs)!.docs!.url} target="_blank" rel="noreferrer">{template.actions.find((a) => a.docs)!.docs!.label}</a>
            </p>
          )}
        </InfoDialog>
      )}

      <div className="tabs" style={{ marginTop: 6 }}>
        {s.sessions && <button className={tab === "sessions" ? "active" : ""} onClick={() => setTab("sessions")}>Sessions</button>}
        <button className={tab === "setup" ? "active" : ""} onClick={() => setTab("setup")}>Setup</button>
        <button className={tab === "events" ? "active" : ""} onClick={() => setTab("events")}>Events</button>
        <button className={tab === "firings" ? "active" : ""} onClick={() => setTab("firings")}>Firings</button>
        <button className={tab === "agents" ? "active" : ""} onClick={() => { setFocusDispatch(undefined); setTab("agents"); }}>Agents</button>
      </div>

      {tab === "sessions" && s.sessions && (
        <>
          <SessionsPanel sessions={s.sessions} view={s.names?.view ?? "challenger_session"}
                         onSummarize={s.status === "active"
                           ? (sid) => { setActionArgs({ ...actionArgs, "summarize.session": sid }); return runActionWith("summarize", { session: sid }); }
                           : undefined}
                         busy={actionBusy === "summarize"} message={actionMsg} />
          {s.runs && <ProposalsPanel runs={s.runs} />}
        </>
      )}

      {tab === "setup" && (
        <>
          {(s.panels ?? []).map((pn) => (
            <div className="panel" key={pn.title} style={{ marginBottom: 12 }}>
              <h3 style={{ margin: "0 0 8px" }}>{pn.title}</h3>
              <table>
                <tbody>
                  {pn.rows.map((row) => (
                    <tr key={row.label}>
                      <td className="help" style={{ width: 150 }}>{row.label}</td>
                      <td className={row.mono ? "mono" : undefined}>
                        {row.url
                          ? <a href={row.url} target="_blank" rel="noreferrer">{String(row.value)}</a>
                          : String(row.value)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

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
          {myViews.map((v) => (
            <ViewPanel key={v.name} v={v} sourceNames={(sources ?? []).map((x) => x.name)}
                       watchers={(triggers ?? []).filter((t) => t.view === v.name).length}
                       onSaved={() => { reloadViews(); reload(); }} />))}
          {!myViews.length && <p className="help">none in this project</p>}

          <h2 style={{ marginTop: 24 }}>Triggers</h2>
          {myTriggers.map((t) => (
            <TriggerPanel key={t.name} t={t}
                          viewInProject={myViews.some((v) => v.name === t.view)}
                          lastFired={firings.find((d) => d.trigger === t.name)?.fired_at ?? null}
                          onSaved={() => { reloadTriggers(); reload(); }} />
          ))}
          {!myTriggers.length && <p className="help">none in this project</p>}

          {names("mcp_server").length > 0 && (
            <>
              <h2 style={{ marginTop: 24 }}>MCP servers</h2>
              <p style={{ margin: "4px 0 0" }}>
                {names("mcp_server").map((n) => (
                  <Link key={n} to="/mcp-servers" className="chip mono">{n}</Link>))}
              </p>
            </>
          )}

          <div className="pagehead" style={{ marginTop: 24 }}>
            <h2 style={{ margin: 0 }}>Subscribers</h2>
            <span className="btnrow">
              <Link className="btn" to={`/agents/new?trigger=${encodeURIComponent(subTrigger || myTriggers[0]?.name || "")}`}>Add a Tares agent</Link>
              <button type="button" onClick={() => { setAdding(adding === "slack" ? null : "slack"); setSubMsg(undefined); }}>Add Slack channel</button>
              <button type="button" onClick={() => { setAdding(adding === "webhook" ? null : "webhook"); setSubMsg(undefined); }}>Add webhook</button>
            </span>
          </div>
          {subRows.length ? (
            <table>
              <thead><tr><th>subscriber</th><th>wakes on</th><th>delivered</th><th aria-label="actions" /></tr></thead>
              <tbody>
                {subRows.map(({ a, sub }) => (
                  <tr key={sub.subscription_id}>
                    <td>
                      {a.kind === "tares"
                        ? names("agent").includes(a.name)
                          ? <a href="#agents" onClick={(e) => { e.preventDefault(); openAgentTab(a.name); }}><strong>{a.name}</strong></a>
                          : <Link to={`/agents/${encodeURIComponent(a.name)}`}><strong>{a.name}</strong></Link>
                        : a.kind === "slack"
                        ? <strong>{channelLabel(a.name)}</strong>
                        : <strong>{a.name}</strong>}
                      <span className="chip" style={{ marginLeft: 8 }}>
                        {a.kind === "tares" ? "Tares agent" : a.kind === "slack" ? "Slack" : "webhook"}</span>
                      {a.kind === "connected" && <span className="mono dim" style={{ marginLeft: 8 }}>{a.endpoint}</span>}
                    </td>
                    <td>
                      <a href={`#trigger-${sub.trigger}`} className="chip mono"
                         onClick={(e) => { e.preventDefault(); document.getElementById(`trigger-${sub.trigger}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{sub.trigger}</a>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {a.delivered_ok_total
                        ? <>{a.delivered_ok_total} · last <TimeAgo ts={a.last_woken} /></>
                        : <span className="dim">none yet</span>}
                      {a.delivered_fail_total > 0 && <span style={{ color: "var(--err)" }}> · {a.delivered_fail_total} failed</span>}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button className="danger"
                              onClick={() => setUnsub({ id: sub.subscription_id, label: a.kind === "slack" ? channelLabel(a.name) : a.name })}>
                        remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="help">nobody is subscribed to this project's triggers yet</p>}
          {adding && (
            <div className="panel" style={{ marginTop: 10 }}>
              {myTriggers.length > 1 && (
                <label className="field">
                  <span className="lbl">trigger</span>
                  <Picker value={subTrigger || myTriggers[0]?.name || ""} onChange={setSubTrigger}
                          ariaLabel="trigger to subscribe to"
                          options={myTriggers.map((t) => t.name)} />
                </label>
              )}
              {adding === "webhook" ? (
                <label className="field">
                  <span className="lbl">webhook URL</span>
                  <input type="text" className="mono" autoFocus placeholder="https://your-agent.example.com/hook"
                         value={subUrl} onChange={(e) => setSubUrl(e.target.value)} />
                  <span className="help">your agent's endpoint; it gets POSTed the timeline on every firing · <Link to="/connect?tab=push">what it receives</Link></span>
                </label>
              ) : (
                <label className="field">
                  <span className="lbl">channel</span>
                  {channels.length > 0 ? (
                    <Picker value={subChannel} onChange={setSubChannel} ariaLabel="Slack channel"
                            options={["", ...channels.map((c) => c.id)]}
                            labels={{ "": "choose a channel…",
                                      ...Object.fromEntries(channels.map((c) => [c.id, c.is_private ? `🔒 ${c.name}` : `#${c.name}`])) }} />
                  ) : (
                    <input type="text" className="mono" autoFocus placeholder="C0123456789, or the channel's lowercase name"
                           value={subChannel} onChange={(e) => setSubChannel(e.target.value)} />
                  )}
                  <span className="help">the workspace bot posts every firing there; add the bot to the channel in Slack first</span>
                </label>
              )}
              <div className="btnrow">
                <button className="primary" disabled={subBusy || (adding === "webhook" ? !subUrl.trim() : !subChannel.trim())}
                        onClick={() => addSubscription(adding === "webhook"
                          ? subUrl.trim()
                          : `slack://channel/${(channels.length ? subChannel : subChannel.trim().replace(/^#/, ""))}`)}>
                  {subBusy ? "…" : "Subscribe"}
                </button>
                <button type="button" onClick={() => setAdding(null)}>Cancel</button>
              </div>
              {subMsg && <p className="help" style={{ margin: "6px 0 0" }}>{subMsg}</p>}
            </div>
          )}

          {s.log && s.log.length > 0 && (
            <details style={{ marginTop: 24 }}>
              <summary style={{ cursor: "pointer" }}><h2 style={{ display: "inline", marginLeft: 6 }}>Change history</h2></summary>
              <table style={{ marginTop: 10 }}>
                <tbody>
                  {s.log.map((l, i) => (
                    <tr key={i}>
                      <td style={{ whiteSpace: "nowrap", width: 90, verticalAlign: "top" }}><TimeAgo ts={l.at} /></td>
                      <td className="mono" style={{ whiteSpace: "nowrap", width: 90, verticalAlign: "top" }}>{l.action}</td>
                      <td className="help" style={{ overflowWrap: "anywhere" }}>{l.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </>
      )}

      {tab === "events" && (
        recent === undefined ? <div className="dim">loading…</div>
        : recent.length ? (
          <table>
            <thead><tr><th style={{ width: 110 }}>when</th><th>source</th><th>entity</th><th>type</th><th>event</th></tr></thead>
            <tbody>
              {recent.map((e, i) => {
                const long = e.text.length > 160;
                const open = openEvent === i;
                return (
                  <tr key={i} className={long ? "clickable" : undefined}
                      onClick={() => long && setOpenEvent(open ? undefined : i)}
                      title={long && !open ? "click for the whole event" : undefined}>
                    <td style={{ whiteSpace: "nowrap", verticalAlign: "top" }}><TimeAgo ts={e.ingest_time} /></td>
                    <td style={{ verticalAlign: "top" }} onClick={(ev) => ev.stopPropagation()}>
                      <Link to={`/sources/${encodeURIComponent(e.source)}`} className="mono">{e.source}</Link></td>
                    <td className="mono" style={{ verticalAlign: "top" }}>{e.key}</td>
                    <td style={{ verticalAlign: "top" }}><span className="chip">{e.event_type}</span></td>
                    <td className="mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                      {open || !long ? e.text : e.text.slice(0, 160)}
                      {long && !open && <span className="dim"> … ▸</span>}
                      {open && <span className="dim"> ▾</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="help">nothing ingested yet across this project's sources</p>
      )}

      {tab === "firings" && (
        <>
          {dispatchesError && <ErrorState error={dispatchesError} what="the firings" />}
          {firings.length ? (
            <table>
              <thead><tr><th>when</th><th>trigger</th><th>entity</th><th>delivered to</th></tr></thead>
              <tbody>
                {firingRows.map((d) => {
                  const subs = subscribers(d.trigger);
                  const partial = d.subscribers > 0 && d.delivered < d.subscribers;
                  return (
                    <tr key={d.dispatch_id}>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <Link to={`/dispatches/${encodeURIComponent(d.dispatch_id)}`} title="the firing's detail page">
                          <TimeAgo ts={d.fired_at} /></Link></td>
                      <td>{triggerNames.has(d.trigger)
                        ? <a href={`#trigger-${d.trigger}`} className="mono" title="the trigger, on the Setup tab"
                             onClick={(e) => { e.preventDefault(); showTrigger(d.trigger); }}>{d.trigger}</a>
                        : <span className="mono">{d.trigger}</span>}</td>
                      <td className="mono">{d.key}</td>
                      <td>{d.subscribers === 0
                        ? <><span className="badge error">nobody subscribed</span>
                            {(d.repeats ?? 1) > 1 && <span className="help"> · {d.repeats} firings like this</span>}</>
                        : subs.length === 0
                        ? <span className={`badge ${partial ? "error" : "ok"}`}>{d.delivered} of {d.subscribers}</span>
                        : subs.map((a) => a.kind === "tares"
                            ? <a key={a.name} href="#agents" className="chip mono"
                                 onClick={(e) => { e.preventDefault(); openInAgents(d.dispatch_id); }}
                                 title={partial ? (d.error ?? "not every delivery succeeded") : "delivered · open this firing's run below"}
                                 style={{ marginRight: 4, color: partial ? "var(--err)" : "var(--ok, #2e7d43)" }}>{a.name}</a>
                            : <span key={a.name} className="chip"
                                    title={partial ? (d.error ?? "not every delivery succeeded") : "delivered"}
                                    style={{ marginRight: 4, color: partial ? "var(--err)" : "var(--ok, #2e7d43)" }}>
                                {a.kind === "slack" ? channelLabel(a.name) : a.name}</span>)}</td>
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

      {unsub && (
        <ConfirmDialog title={`Stop delivering to ${unsub.label}?`}
          message="This trigger stops delivering to it; anything else it is subscribed to is unaffected, and its delivery history is kept."
          confirmLabel="Remove" danger
          onConfirm={async () => {
            const u = unsub; setUnsub(null);
            try { await api.unsubscribe(u.id); reloadRoster(); reload(); }
            catch (e) { setActionError(String((e as Error).message ?? e)); }
          }}
          onCancel={() => setUnsub(null)} />
      )}

      {confirmDel && (
        <ConfirmDialog title={`Delete project ${s.name}?`}
          message={custom
            ? "Removes the project. Its objects stay in place, no longer part of a project. Events already stored stay unless you purge them."
            : "Deletes the sources, views, triggers and agents this project created. Events already stored stay unless you purge them."}
          confirmLabel="Delete project" danger
          onConfirm={async () => {
            try { await api.deleteProject(id, purge); navigate("/projects", { replace: true }); }
            catch (e) { setActionError(String((e as Error).message ?? e)); setConfirmDel(false); }
          }}
          onCancel={() => setConfirmDel(false)}>
          <label style={{ display: "block", marginTop: 8 }}>
            <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />{" "}
            {custom
              ? "also purge the events its sources ingested"
              : "also purge the events its sources ingested and its triggers' firings"}
          </label>
        </ConfirmDialog>
      )}
    </>
  );
}

// One view, as its own page shows it (key field, sources, filters, author, usage), with the same
// in-place editor. "+ trigger" preselects this view on the trigger form.
function ViewPanel({ v, sourceNames, watchers, onSaved }: {
  v: import("../types").View; sourceNames: string[]; watchers: number; onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [err, setErr] = useState<string>();
  return (
    <div className="panel" id={`view-${v.name}`} style={{ marginBottom: 12, scrollMarginTop: 16 }}>
      <div className="pagehead" style={{ marginBottom: 8 }}>
        <div>
          <h3 style={{ margin: 0 }}><span className="mono">{v.name}</span></h3>
        </div>
        <span className="btnrow">
          <Link className="btn" to={`/triggers/new?view=${encodeURIComponent(v.name)}`}>+ trigger</Link>
          {!editing && <button className="primary" onClick={() => setEditing(true)}>Edit</button>}
          {!editing && <button className="danger" onClick={() => setConfirmDel(true)}>Delete</button>}
        </span>
      </div>
      {err && <div className="alert error">{err}</div>}
      {confirmDel && (
        <ConfirmDialog title={`Delete view ${v.name}?`}
          message={watchers
            ? `${watchers} trigger(s) watch this view and will stop working. Agents querying it will start failing.`
            : "Agents querying this view will start failing. This can't be undone."}
          confirmLabel="Delete" danger
          onConfirm={async () => {
            try { await api.deleteView(v.name); onSaved(); }
            catch (e) { setErr(String((e as Error).message ?? e)); }
            setConfirmDel(false);
          }}
          onCancel={() => setConfirmDel(false)} />
      )}
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
  const [confirmDel, setConfirmDel] = useState(false);
  const [err, setErr] = useState<string>();
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
          {!editing && <button className="danger" onClick={() => setConfirmDel(true)}>Delete</button>}
        </span>
      </div>
      {err && <div className="alert error">{err}</div>}
      {confirmDel && (
        <ConfirmDialog title={`Delete trigger ${t.name}?`}
          message="Nothing will fire on this condition any more; its subscribers stop being woken. This can't be undone."
          confirmLabel="Delete" danger
          onConfirm={async () => {
            try { await api.deleteTrigger(t.name); onSaved(); }
            catch (e) { setErr(String((e as Error).message ?? e)); }
            setConfirmDel(false);
          }}
          onCancel={() => setConfirmDel(false)} />
      )}
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
    <div style={{ marginBottom: 28 }} id={`agent-${name}`}>
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

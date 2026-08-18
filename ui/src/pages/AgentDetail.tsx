import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { api } from "../api";
import AgentForm from "../components/AgentForm";
import ConfirmDialog from "../components/ConfirmDialog";
import { ErrorState, TimeAgo, usePolling } from "../components/bits";
import type { AgentRun } from "../types";

// Everything about one Tares agent: its prompt, wiring, and — the part that doesn't belong on the
// trigger page — its output. Each run shows when it was woken, which firing woke it, and the finding
// rendered as markdown. External (connected) agents are not managed here; they live in the roster.

function statusBadge(r: AgentRun) {
  if (r.status === "ok") return <span className="badge ok">ok</span>;
  if (r.status === "running") return <span className="badge starting">running</span>;
  // "empty"/"capped"/"exhausted" ran and declined to conclude, hit the daily cap, or ran out of
  // rounds. Not failures.
  const cls = r.status === "failed" ? "error" : "";
  return <span className={`badge ${cls}`}>{r.status}</span>;
}

export default function AgentDetail() {
  // A dispatch page links here as ?dispatch=<id>: that run opens, highlights, and scrolls into
  // view, so "what did the agent do with this firing" is one click.

  const { name = "" } = useParams();
  const [search] = useSearchParams();
  const focusDispatch = search.get("dispatch") ?? undefined;
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [err, setErr] = useState<string>();

  const { data, error, reload } = usePolling(() => api.builtinAgents(), 10000);
  const { data: runs, error: runsError } = usePolling(() => api.builtinAgentRuns(name, 20), 10000);
  const { data: triggers } = usePolling(() => api.triggers(), 30000);

  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <div className="dim">loading…</div>;

  const agent = data.agents.find((a) => a.name === name);
  if (!agent) {
    return (
      <div className="alert error">
        no Tares agent named <span className="mono">{name}</span>. Connected (external) agents are
        listed under <Link to="/deliveries">Deliveries</Link>. See <Link to="/agents">Agents</Link>.
      </div>
    );
  }

  const toggle = async () => {
    setErr(undefined);
    try {
      if (agent.enabled) await api.disableBuiltinAgent(agent.name);
      else await api.enableBuiltinAgent(agent.name);
      reload();
    } catch (e) { setErr(String((e as Error).message ?? e)); }
  };

  const lastRun = runs?.[0];

  return (
    <>
      <div className="pagehead">
        <div>
          <h1><span className="mono">{agent.name}</span>{" "}
            <span className="badge">Tares agent</span></h1>
          <p className="subtitle">a prompt that takes a first look when its trigger fires</p>
        </div>
        {!editing && (
          <span className="btnrow">
            <button className="primary" onClick={toggle}>{agent.enabled ? "Disable" : "Enable"}</button>
            <button onClick={() => setEditing(true)}>Edit</button>
            <button className="danger" onClick={() => setConfirmDel(true)}>Delete</button>
          </span>
        )}
      </div>

      {err && <div className="alert error">{err}</div>}

      {editing ? (
        <AgentForm
          initial={agent}
          triggers={(triggers ?? []).map((t) => t.name)}
          presets={data.presets}
          models={data.models}
          defaultModel={data.default_model}
          slackWorkspace={data.slack_workspace}
          defaultMaxRounds={data.default_max_rounds}
          defaultMaxRoundsWithMcp={data.default_max_rounds_with_mcp}
          maxRoundsLimit={data.max_rounds_limit}
          onSaved={() => { setEditing(false); reload(); }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <div className="panel">
            <table>
              <tbody>
                <tr>
                  <td className="help" style={{ width: 150 }}>status</td>
                  <td>
                    {agent.enabled ? <span className="badge ok">enabled</span> : <span className="badge">disabled</span>}
                    {!data.key_configured
                      ? <span className="help"> · no Anthropic key: set one under <Link to="/settings">Settings</Link> to run</span>
                      : <span className="help"> · key from <span className="mono">{data.key_source}</span></span>}
                  </td>
                </tr>
                <tr><td className="help">wakes on</td>
                    <td><Link to={`/triggers/${encodeURIComponent(agent.trigger)}`} className="mono">{agent.trigger}</Link>
                        <span className="help"> · the trigger that runs this agent</span></td></tr>
                <tr><td className="help">writes to</td>
                    <td><Link to="/sources/findings" className="mono">findings</Link>
                        <span className="help"> · one finding per run, on the entity's timeline</span></td></tr>
                <tr><td className="help">last woken</td>
                    <td>{lastRun
                      ? <><TimeAgo ts={lastRun.started_at} /> for <span className="mono">{lastRun.key}</span>
                          {lastRun.dispatch_id && <> · <Link to={`/dispatches/${encodeURIComponent(lastRun.dispatch_id)}`}>the firing</Link></>}</>
                      : <span className="dim">never</span>}</td></tr>
                <tr><td className="help">model</td>
                    <td><span className="mono">{agent.model || data.default_model}</span>
                        {!agent.model && <span className="help"> · instance default</span>}</td></tr>
                <tr><td className="help">max rounds</td>
                    <td><span className="mono">{agent.effective_max_rounds}</span>
                        {!agent.max_rounds && <span className="help"> · default{agent.mcp_servers.length ? " for an agent with external MCP servers" : ""}</span>}</td></tr>
                <tr><td className="help">Slack</td>
                    <td>{agent.slack_channel
                      ? <><span className="badge ok">channel</span> <span className="help">posted by the workspace bot</span></>
                      : agent.slack_configured
                        ? <><span className="badge ok">webhook</span> <span className="help">legacy per-agent webhook</span></>
                        : <span className="dim">—</span>}</td></tr>
                <tr><td className="help">write-back</td>
                    <td>{agent.webhook_url
                      ? <><span className="mono">{agent.webhook_url}</span>
                          {agent.webhook_token_configured
                            ? <span className="badge ok" style={{ marginLeft: 8 }}>bearer auth</span>
                            : <span className="help"> · no auth</span>}</>
                      : <span className="dim">—</span>}</td></tr>
                <tr><td className="help">prompt</td>
                    <td><pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{agent.prompt}</pre></td></tr>
              </tbody>
            </table>
          </div>

          <h2>Runs &amp; findings</h2>
          {runsError && <ErrorState error={runsError} what="this agent’s runs" />}
          {!runsError && !runs?.length && <p className="help">none yet; this agent runs when <span className="mono">{agent.trigger}</span> fires</p>}
          {runs?.map((r, i) => {
            const header = (
              <>
                {statusBadge(r)}{" "}
                <span className="mono">{r.key}</span>{" "}
                <span className="help">
                  · <TimeAgo ts={r.started_at} />
                  {r.dispatch_id && <> · <Link to={`/dispatches/${encodeURIComponent(r.dispatch_id)}`}>firing</Link></>}
                  {r.rounds ? ` · ${r.rounds}${r.max_rounds ? `/${r.max_rounds}` : ""} round${r.rounds === 1 && !r.max_rounds ? "" : "s"}` : ""}
                  {r.duration_ms != null ? ` · ${(r.duration_ms / 1000).toFixed(1)}s` : ""}
                </span>
                {(r.external_tools ?? []).length > 0 && (
                  <span style={{ marginLeft: 8 }}>
                    {[...new Set(r.external_tools)].map((t) => (
                      <span key={t} className="chip mono" title="external MCP tool this run called"
                            style={{ marginRight: 4 }}>{t}</span>
                    ))}
                  </span>
                )}
              </>
            );
            const exhaustedNote = r.status === "exhausted" && (
              <p className="help" style={{ margin: "8px 0 0" }}>
                ran out of rounds before concluding ({r.rounds}{r.max_rounds ? `/${r.max_rounds}` : ""});
                raise max rounds under Edit, Advanced.
                {r.finding ? " What it had so far:" : ""}
              </p>
            );
            const body = r.finding
              ? <>{exhaustedNote}<div className="md" style={{ marginTop: 8 }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{r.finding}</ReactMarkdown>
                </div></>
              : exhaustedNote || <p className="help" style={{ margin: "8px 0 0" }}>
                  {r.status === "running" ? "investigating…" : (r.error ?? "no finding")}
                </p>;
            // Newest run expanded by default; older ones collapse so the page stays readable as
            // runs accumulate. <details> keeps it dependency-free and keyboard-accessible.
            const focused = !!focusDispatch && r.dispatch_id === focusDispatch;
            return (
              <details className="panel" key={r.id} open={i === 0 || focused}
                       style={focused ? { outline: "2px solid var(--accent)" } : undefined}
                       ref={(el) => { if (el && focused) el.scrollIntoView({ block: "center" }); }}>
                <summary style={{ cursor: "pointer", listStyle: "revert" }}>{header}</summary>
                {body}
              </details>
            );
          })}
        </>
      )}

      {confirmDel && (
        <ConfirmDialog
          title={`Delete agent ${agent.name}?`}
          message="Findings already written stay on their timelines; this stops new ones. This can't be undone."
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmDel(false)}
          onConfirm={async () => {
            try { await api.deleteBuiltinAgent(agent.name); nav("/agents"); }
            catch (e) { setErr(String((e as Error).message ?? e)); setConfirmDel(false); }
          }}
        />
      )}
    </>
  );
}

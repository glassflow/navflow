import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { api } from "../api";
import AgentForm from "../components/AgentForm";
import ConfirmDialog from "../components/ConfirmDialog";
import { TimeAgo, usePolling } from "../components/bits";
import type { AgentRun } from "../types";

// Everything about one NavFlow agent: its prompt, wiring, and — the part that doesn't belong on the
// trigger page — its output. Each run shows when it was woken, which firing woke it, and the finding
// rendered as markdown. External (connected) agents are not managed here; they live in the roster.

function statusBadge(r: AgentRun) {
  if (r.status === "ok") return <span className="badge ok">ok</span>;
  if (r.status === "running") return <span className="badge starting">running</span>;
  // "empty"/"capped" ran and declined to conclude, or hit the daily cap — not failures.
  const cls = r.status === "failed" ? "error" : "";
  return <span className={`badge ${cls}`}>{r.status}</span>;
}

export default function AgentDetail() {
  const { name = "" } = useParams();
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [err, setErr] = useState<string>();

  const { data, error, reload } = usePolling(() => api.builtinAgents(), 10000);
  const { data: runs } = usePolling(() => api.builtinAgentRuns(name, 20), 10000);
  const { data: triggers } = usePolling(() => api.triggers(), 30000);

  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <div className="dim">loading…</div>;

  const agent = data.agents.find((a) => a.name === name);
  if (!agent) {
    return (
      <div className="alert error">
        no NavFlow agent named <span className="mono">{name}</span>. Connected (external) agents are
        listed under <Link to="/activity">Activity</Link>. See <Link to="/agents">Agents</Link>.
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
            <span className="badge">NavFlow agent</span></h1>
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
                      ? <span className="help"> — no Anthropic key: set one under <Link to="/security">Security</Link> to run</span>
                      : <span className="help"> — key from <span className="mono">{data.key_source}</span></span>}
                  </td>
                </tr>
                <tr><td className="help">wakes on</td>
                    <td><Link to={`/triggers/${encodeURIComponent(agent.trigger)}`} className="mono">{agent.trigger}</Link>
                        <span className="help"> — the trigger that runs this agent</span></td></tr>
                <tr><td className="help">writes to</td>
                    <td><Link to="/sources/findings" className="mono">findings</Link>
                        <span className="help"> — one finding per run, on the entity's timeline</span></td></tr>
                <tr><td className="help">last woken</td>
                    <td>{lastRun
                      ? <><TimeAgo ts={lastRun.started_at} /> for <span className="mono">{lastRun.key}</span>
                          {lastRun.dispatch_id && <> · <Link to={`/dispatches/${encodeURIComponent(lastRun.dispatch_id)}`}>the firing</Link></>}</>
                      : <span className="dim">never</span>}</td></tr>
                <tr><td className="help">Slack</td>
                    <td>{agent.slack_configured ? <span className="badge ok">configured</span> : <span className="dim">—</span>}</td></tr>
                <tr><td className="help">prompt</td>
                    <td><pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{agent.prompt}</pre></td></tr>
              </tbody>
            </table>
          </div>

          <h2>Runs &amp; findings</h2>
          {!runs?.length && <p className="help">none yet — this agent runs when <span className="mono">{agent.trigger}</span> fires</p>}
          {runs?.map((r, i) => {
            const header = (
              <>
                {statusBadge(r)}{" "}
                <span className="mono">{r.key}</span>{" "}
                <span className="help">
                  · <TimeAgo ts={r.started_at} />
                  {r.dispatch_id && <> · <Link to={`/dispatches/${encodeURIComponent(r.dispatch_id)}`}>firing</Link></>}
                  {r.rounds ? ` · ${r.rounds} round${r.rounds === 1 ? "" : "s"}` : ""}
                  {r.duration_ms != null ? ` · ${(r.duration_ms / 1000).toFixed(1)}s` : ""}
                </span>
              </>
            );
            const body = r.finding
              ? <div className="md" style={{ marginTop: 8 }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{r.finding}</ReactMarkdown>
                </div>
              : <p className="help" style={{ margin: "8px 0 0" }}>
                  {r.status === "running" ? "investigating…" : (r.error ?? "no finding")}
                </p>;
            // Newest run expanded by default; older ones collapse so the page stays readable as
            // runs accumulate. <details> keeps it dependency-free and keyboard-accessible.
            return (
              <details className="panel" key={r.id} open={i === 0}>
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

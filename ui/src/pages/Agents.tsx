import { Link, useNavigate } from "react-router-dom";

import { api } from "../api";
import { AgentsRoster } from "./Activity";
import { TimeAgo, usePolling } from "../components/bits";
import type { AgentRun } from "../types";

// The home for every agent a trigger can wake: Tares agents (configured here, run in-process) and
// connected agents (external, reached over a webhook). Tares agents are created and managed on
// this page; connected agents are listed from the roster and connected from a trigger's page.

function runBadge(r: AgentRun | null | undefined) {
  if (!r) return <span className="dim">never run</span>;
  if (r.status === "ok") return <span className="badge ok">ok</span>;
  if (r.status === "running") return <span className="badge starting">running</span>;
  const cls = r.status === "failed" ? "error" : "";
  return <span className={`badge ${cls}`} title={r.error ?? undefined}>{r.status}</span>;
}

export default function Agents() {
  const nav = useNavigate();
  const { data, error } = usePolling(() => api.builtinAgents(), 10000);

  if (error) return <div className="alert error">{error}</div>;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Agents</h1>
          <p className="subtitle">
            everything your triggers can wake — <strong>Tares agents</strong> that run in-process,
            and <strong>connected agents</strong> reached over a webhook
          </p>
        </div>
        <button className="primary" onClick={() => nav("/agents/new")}>Create Tares agent</button>
      </div>

      {data && !data.key_configured && (
        <div className="alert">
          No Anthropic key configured — agents can be created but not enabled. Set one under{" "}
          <Link to="/security">Security</Link>.
        </div>
      )}

      <h2>Tares agents</h2>
      {!data ? <div className="dim">loading…</div>
        : data.agents.length === 0 ? (
          <div className="panel">
            <p className="help" style={{ whiteSpace: "normal", marginTop: 0 }}>
              No Tares agents yet. Create one here, or from a trigger's page — it reads the same
              correlated timeline your external agents receive and writes what it found back into
              Tares, so the next agent to read that entity already has the conclusion.
            </p>
            <button className="primary" onClick={() => nav("/agents/new")}>Create Tares agent</button>
          </div>
        ) : (
          <table>
            <thead><tr><th>agent</th><th>trigger</th><th>status</th><th>last run</th><th>finding</th></tr></thead>
            <tbody>
              {data.agents.map((a) => (
                <tr key={a.name} className="clickable"
                    onClick={() => nav(`/agents/${encodeURIComponent(a.name)}`)}>
                  <td><Link to={`/agents/${encodeURIComponent(a.name)}`}><strong>{a.name}</strong></Link></td>
                  <td><Link to={`/triggers/${encodeURIComponent(a.trigger)}`} className="mono">{a.trigger}</Link></td>
                  <td>{a.enabled ? <span className="badge ok">enabled</span> : <span className="badge">disabled</span>}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {runBadge(a.last_run)}{a.last_run && <> <TimeAgo ts={a.last_run.started_at} /></>}
                  </td>
                  <td style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {a.last_run?.finding ?? <span className="dim">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      <h2 style={{ marginTop: 28 }}>Connected agents</h2>
      <p className="help" style={{ margin: "0 0 10px", whiteSpace: "normal" }}>
        external agents subscribed to a trigger's webhook. Connect one from a{" "}
        <Link to="/triggers">trigger's</Link> page.
      </p>
      <AgentsRoster only="connected" />
    </>
  );
}

import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { api } from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import TriggerEditor from "../components/TriggerEditor";
import { TimeAgo, usePolling } from "../components/bits";

// The home of one trigger: condition, the agents it wakes (wire more here), recent firings.
// Read-only by default; Edit swaps in the editor in place (?edit=1 opens it directly).
export default function TriggerDetail() {
  const { name = "" } = useParams();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [editing, setEditing] = useState(params.get("edit") === "1");
  const [confirmDel, setConfirmDel] = useState(false);
  const [delErr, setDelErr] = useState<string>();
  const { data: triggers, error, reload } = usePolling(() => api.triggers(), 10000);
  const { data: agents } = usePolling(() => api.agents(), 10000);
  const { data: dispatches } = usePolling(() => api.dispatches(100), 10000);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();

  if (error) return <div className="alert error">{error}</div>;
  if (!triggers) return <div className="dim">loading…</div>;
  const trigger = triggers.find((t) => t.name === name);
  if (!trigger) {
    return (
      <div className="alert error">
        no trigger named <span className="mono">{name}</span> — see <Link to="/triggers">Triggers</Link>
      </div>
    );
  }
  const wired = (agents?.agents ?? []).filter((a) => a.triggers.includes(name));
  const firings = (dispatches ?? []).filter((d) => d.trigger === name).slice(0, 10);

  return (
    <>
      <div className="pagehead">
        <div>
          <h1><span className="mono">{trigger.name}</span></h1>
          <p className="subtitle">
            watches <Link to={`/views/${encodeURIComponent(trigger.view)}`} className="mono">{trigger.view}</Link>
            {" "}— fires when the condition trips, waking every subscribed agent
          </p>
        </div>
        {!editing && (
          <span className="btnrow">
            <button className="primary" onClick={() => setEditing(true)}>Edit</button>
            <button className="danger" onClick={() => setConfirmDel(true)}>Delete</button>
          </span>
        )}
      </div>

      {delErr && <div className="alert error">{delErr}</div>}

      {editing && (
        <TriggerEditor initial={trigger}
                       onSaved={() => { setEditing(false); reload(); }}
                       onCancel={() => setEditing(false)} />
      )}

      {!editing && (
        <div className="panel">
          <table>
            <tbody>
              <tr><td className="help" style={{ width: 150 }}>condition</td>
                  <td className="mono">
                    {trigger.condition.aggregate}({trigger.condition.field || "*"}){" "}
                    {trigger.condition.predicate} over {trigger.condition.window}
                  </td></tr>
              <tr><td className="help">context window</td>
                  <td className="mono">{String(trigger.emit?.context_window ?? "15m")}
                      <span className="help"> — timeline the woken agent receives</span></td></tr>
              <tr><td className="help">cooldown</td>
                  <td className="mono">{trigger.cooldown}
                      <span className="help"> — minimum gap between firings per entity</span></td></tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="pagehead" style={{ marginTop: 20 }}>
        <h2 style={{ margin: 0 }}>Agents woken by this trigger</h2>
        <Link className="btn primary" to={`/agents/new?trigger=${encodeURIComponent(name)}`}>
          Add a NavFlow agent
        </Link>
      </div>
      {wired.length > 0 ? (
        <table style={{ marginBottom: 10 }}>
          <thead><tr><th>agent</th><th>kind</th><th>endpoint</th><th className="num">delivered</th><th className="num">failed</th><th>status</th></tr></thead>
          <tbody>
            {wired.map((a) => (
              <tr key={a.name}>
                <td>{a.kind === "navflow"
                  ? <Link to={`/agents/${encodeURIComponent(a.name)}`}><strong>{a.name}</strong></Link>
                  : <Link to={`/activity?agent=${encodeURIComponent(a.name)}`}><strong>{a.name}</strong></Link>}</td>
                <td>{a.kind === "navflow"
                  ? <span className="badge">NavFlow</span>
                  : <span className="badge push">connected</span>}</td>
                <td className="mono">{a.endpoint}</td>
                <td className="num">{a.delivered_ok}</td>
                <td className="num" style={a.delivered_fail ? { color: "var(--err)" } : undefined}>{a.delivered_fail}</td>
                <td>
                  {a.pending
                    ? <span className="badge starting">running</span>
                    : a.unhealthy
                    ? <span className="badge error" title={a.last_error ?? "last delivery failed"}>failing{a.last_error ? `: ${a.last_error}` : ""}</span>
                    : a.delivered_ok > 0 ? <span className="badge ok">ok</span> : <span className="dim">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="help" style={{ whiteSpace: "normal" }}>
          none yet — add a NavFlow agent above, or connect an external agent's webhook below
        </p>
      )}
      <p className="help" style={{ margin: "4px 0" }}>
        or connect an external agent — its webhook gets POSTed the timeline on every firing:
      </p>
      <div className="btnrow" style={{ alignItems: "center", maxWidth: 720 }}>
        <input type="text" className="mono" style={{ flex: 1 }}
               placeholder="https://your-agent.example.com/hook" value={url}
               onChange={(e) => setUrl(e.target.value)} />
        <button className="primary" disabled={!url.trim() || busy} onClick={async () => {
          setBusy(true); setMsg(undefined);
          try {
            const r = await api.subscribe(name, url.trim());
            setMsg(`✓ subscribed (${r.subscription_id})`);
            setUrl("");
          } catch (e) { setMsg(`⚠️ ${String((e as Error).message ?? e)}`); }
          setBusy(false);
        }}>Subscribe</button>
      </div>
      {msg && <p className="help">{msg}</p>}

      <h2>Recent firings</h2>
      {firings.length === 0 && <p className="help">none yet</p>}
      {firings.length > 0 && (
        <table>
          <thead><tr><th>fired</th><th>entity</th><th className="num">subscribers</th><th className="num">delivered</th><th>error</th></tr></thead>
          <tbody>
            {firings.map((d) => {
              const failed = d.subscribers > d.delivered;
              return (
              <tr key={d.dispatch_id} className="clickable"
                  onClick={() => nav(`/dispatches/${encodeURIComponent(d.dispatch_id)}`)}>
                <td style={{ whiteSpace: "nowrap" }}><Link to={`/dispatches/${encodeURIComponent(d.dispatch_id)}`}><TimeAgo ts={d.fired_at} /></Link></td>
                <td className="mono">{d.key}</td>
                <td className="num">{d.subscribers}</td>
                <td className="num" style={failed ? { color: "var(--err)" } : undefined}>{d.delivered}</td>
                <td className="mono" style={{ color: "var(--err)" }} title={d.error ?? undefined}>{failed ? (d.error ?? "delivery failed") : ""}</td>
              </tr>
            ); })}
          </tbody>
        </table>
      )}

      {confirmDel && (
        <ConfirmDialog
          title={`Delete trigger ${trigger.name}?`}
          message={wired.length
            ? `${wired.length} agent(s) are woken by this trigger and will stop receiving it. This can't be undone.`
            : "This stops the condition from being evaluated. This can't be undone."}
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmDel(false)}
          onConfirm={async () => {
            setDelErr(undefined);
            try { await api.deleteTrigger(trigger.name); nav("/triggers"); }
            catch (e) { setDelErr(String((e as Error).message ?? e)); setConfirmDel(false); }
          }}
        />
      )}
    </>
  );
}

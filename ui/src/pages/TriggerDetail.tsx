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
  const [channel, setChannel] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const { data: caps } = usePolling(() => api.capabilities(), 60000);

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
          <thead><tr><th>agent</th><th>kind</th><th>endpoint</th><th className="num">delivered (24h)</th><th className="num">failed (24h)</th><th>status</th></tr></thead>
          <tbody>
            {wired.map((a) => (
              <tr key={a.name}>
                <td>{a.kind === "navflow"
                  ? <Link to={`/agents/${encodeURIComponent(a.name)}`}><strong>{a.name}</strong></Link>
                  : <Link to={`/activity?agent=${encodeURIComponent(a.name)}`}><strong>{a.name}</strong></Link>}</td>
                <td>{a.kind === "navflow"
                  ? <span className="badge">NavFlow</span>
                  : a.kind === "slack"
                  ? <span className="badge">Slack</span>
                  : <span className="badge push">connected</span>}</td>
                <td className="mono">{a.endpoint}</td>
                <td className="num" title={`${a.delivered_ok_total} delivered all time`}>
                  {a.delivered_ok_24h}
                  {a.delivered_ok_total !== a.delivered_ok_24h && <span className="dim"> / {a.delivered_ok_total}</span>}
                </td>
                <td className="num" style={a.delivered_fail_24h ? { color: "var(--err)" } : undefined}
                    title={`${a.delivered_fail_total} failed all time`}>
                  {a.delivered_fail_24h}
                  {a.delivered_fail_total !== a.delivered_fail_24h && <span className="dim"> / {a.delivered_fail_total}</span>}
                </td>
                <td>
                  {a.pending
                    ? <span className="badge starting">running</span>
                    : a.unhealthy
                    ? <span className="badge error" title={a.last_error ?? "last delivery failed"}>failing{a.last_error ? `: ${a.last_error}` : ""}</span>
                    : a.delivered_ok_total > 0 ? <span className="badge ok">ok</span> : <span className="dim">—</span>}
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

      {/* A Slack channel is the same thing as the webhook above — one more subscription row —
          so it lives here rather than in a Slack-shaped corner of the app. */}
      <p className="help" style={{ margin: "10px 0 4px" }}>
        or post every firing to a <strong>Slack channel</strong> — retried and logged like any
        other delivery:
      </p>
      <div className="btnrow" style={{ alignItems: "center", maxWidth: 720 }}>
        <input type="text" className="mono" style={{ flex: 1 }}
               placeholder="C0123456789 — the channel ID, from Slack's “Copy link”"
               value={channel} onChange={(e) => setChannel(e.target.value)} />
        <button className="primary" disabled={!channel.trim() || busy} onClick={async () => {
          setBusy(true); setMsg(undefined);
          try {
            const r = await api.subscribe(name, `slack://channel/${channel.trim().replace(/^#/, "")}`);
            setMsg(`✓ subscribed (${r.subscription_id})`);
            setChannel("");
          } catch (e) { setMsg(`⚠️ ${String((e as Error).message ?? e)}`); }
          setBusy(false);
        }}>Subscribe channel</button>
      </div>
      {caps && caps.slack_configured === false && (
        <p className="help" style={{ margin: "4px 0", whiteSpace: "normal" }}>
          no Slack bot token is configured yet — add one under{" "}
          <Link to="/security">Security</Link>, and invite the bot to the channel.
        </p>
      )}
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

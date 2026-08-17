import { Link, useParams } from "react-router-dom";

import { api } from "../api";
import { TimeAgo, usePolling } from "../components/bits";

// One firing, deep — the page behind a dispatch_id. Fetched by id so links from the Agents tab
// (or anywhere) always resolve, unlike the capped dispatches list. Shows the per-subscriber
// delivery attempts (who got it, who failed and why) plus the full payload the agent received.
export default function DispatchDetail() {
  const { id = "" } = useParams();
  const { data: d, error } = usePolling(() => api.dispatch(id), 10000);

  if (error) {
    return (
      <div className="alert error">
        {/unknown dispatch/i.test(error) ? <>no dispatch <span className="mono">{id}</span></> : error}
        {" "}· see <Link to="/deliveries">Deliveries</Link>
      </div>
    );
  }
  if (!d) return <div className="dim">loading…</div>;

  const failed = d.subscribers > d.delivered;
  let payload = d.payload;
  try { payload = JSON.stringify(JSON.parse(d.payload), null, 2); } catch { /* keep raw */ }

  return (
    <>
      <div className="pagehead">
        <div>
          <p className="subtitle" style={{ marginBottom: 4 }}>
            <Link to="/deliveries">Deliveries</Link> ›
          </p>
          <h1>
            <Link to={`/triggers/${encodeURIComponent(d.trigger)}`} className="mono">{d.trigger}</Link>
          </h1>
          <p className="subtitle">
            fired for <span className="mono">{d.key}</span> · <TimeAgo ts={d.fired_at} />
          </p>
        </div>
      </div>

      <div className="kv" style={{ marginBottom: 18 }}>
        <span className="k">kind</span><span className="mono">{d.kind}</span>
        <span className="k">delivery</span>
        <span>
          {d.subscribers === 0
            ? <span className="badge starting">no subscribers</span>
            : <span className={`badge ${failed ? "error" : "ok"}`}>{d.delivered}/{d.subscribers} delivered</span>}
        </span>
        {d.error && <><span className="k">error</span><span className="mono" style={{ color: "var(--err)" }}>{d.error}</span></>}
        <span className="k">dispatch id</span><span className="mono">{d.dispatch_id}</span>
      </div>

      <h2>Deliveries</h2>
      {d.deliveries.length === 0 ? (
        <p className="help" style={{ whiteSpace: "normal" }}>
          no subscribers were attached when this fired; nothing was delivered (the firing is still
          logged; wire an agent on the <Link to={`/triggers/${encodeURIComponent(d.trigger)}`}>trigger</Link>).
        </p>
      ) : (
        <table style={{ marginBottom: 18 }}>
          <thead><tr><th>agent</th><th>endpoint</th><th>status</th><th>when</th></tr></thead>
          <tbody>
            {/* Each kind links to where its story continues: a Tares agent to its run for THIS
                firing, an external agent to its roster row. A Slack channel gets no link — the
                message went to Slack; there is nothing more to show here. */}
            {d.deliveries.map((dv, i) => (
              <tr key={i}>
                <td>{dv.kind === "tares"
                  ? <Link to={`/agents/${encodeURIComponent(dv.agent)}?dispatch=${encodeURIComponent(d.dispatch_id)}`}><strong>{dv.agent}</strong></Link>
                  : dv.kind === "webhook"
                  ? <Link to={`/agents?agent=${encodeURIComponent(dv.agent)}`}><strong>{dv.agent}</strong></Link>
                  : <strong>{dv.agent}</strong>}</td>
                <td className="mono">{dv.endpoint}</td>
                <td>
                  {dv.ok
                    ? <span className="badge ok">delivered</span>
                    : <span className="badge error" title={dv.error ?? undefined}>failed{dv.error ? `: ${dv.error}` : ""}</span>}
                </td>
                <td style={{ whiteSpace: "nowrap" }}><TimeAgo ts={dv.delivered_at} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Payload</h2>
      <p className="help" style={{ margin: "0 0 6px", whiteSpace: "normal" }}>
        the timeline POSTed to each subscriber; the agent boots holding this.
      </p>
      <pre className="payload">{payload}</pre>
    </>
  );
}

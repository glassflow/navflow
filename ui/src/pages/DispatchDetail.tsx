import { Link, useParams } from "react-router-dom";

import { api } from "../api";
import ProjectBadge from "../components/ProjectBadge";
import { TimeAgo, usePolling } from "../components/bits";

// One firing, deep — the page behind a dispatch_id. Fetched by id so links from anywhere always
// resolve, unlike the capped dispatches list. One facts box (trigger, project, what it fired for,
// how delivery went, each recipient with its outcome), then the payload the subscribers received.
export default function DispatchDetail() {
  const { id = "" } = useParams();
  const { data: d, error } = usePolling(() => api.dispatch(id), 10000);
  const { data: triggers } = usePolling(() => api.triggers(), 30000);

  if (error) {
    return (
      <div className="alert error">
        {/unknown dispatch/i.test(error) ? <>no dispatch <span className="mono">{id}</span></> : error}
        {" "}· see <Link to="/deliveries">Deliveries</Link>
      </div>
    );
  }
  if (!d) return <div className="dim">loading…</div>;

  const trig = (triggers ?? []).find((t) => t.name === d.trigger);
  const pending = d.deliveries.filter((dv) => dv.ok === null).length;
  const failed = d.deliveries.filter((dv) => dv.ok === false).length;
  let payload = d.payload;
  try { payload = JSON.stringify(JSON.parse(d.payload), null, 2); } catch { /* keep raw */ }

  return (
    <>
      <div className="pagehead">
        <div>
          <h1><span className="mono">{d.trigger}</span> <span className="badge">firing</span></h1>
        </div>
      </div>

      <div className="panel">
        <table>
          <tbody>
            <tr><td className="help" style={{ width: 150 }}>trigger</td>
                <td><Link to={`/triggers/${encodeURIComponent(d.trigger)}`} className="chip mono">{d.trigger}</Link></td></tr>
            {trig?.owned_by && (
              <tr><td className="help">part of</td>
                  <td><ProjectBadge ownedBy={trig.owned_by} customized={trig.customized} compact /></td></tr>
            )}
            <tr><td className="help">fired for</td>
                <td className="mono">{d.key}</td></tr>
            <tr><td className="help">fired</td>
                <td><TimeAgo ts={d.fired_at} /></td></tr>
            <tr><td className="help">delivery</td>
                <td>
                  {d.subscribers === 0
                    ? <span className="badge starting">no subscribers</span>
                    : failed > 0
                    ? <span className="badge error">{failed} of {d.subscribers} failed</span>
                    : pending > 0
                    ? <span className="badge starting">running</span>
                    : <span className="badge ok">delivered to all {d.subscribers}</span>}
                </td></tr>
            {d.deliveries.length === 0 ? (
              <tr><td className="help">delivered to</td>
                  <td className="help" style={{ whiteSpace: "normal" }}>
                    nobody was subscribed when this fired; the firing is still logged. Wire an agent
                    on the <Link to={`/triggers/${encodeURIComponent(d.trigger)}`}>trigger</Link>.
                  </td></tr>
            ) : d.deliveries.map((dv, i) => (
              <tr key={i}>
                <td className="help">{i === 0 ? "delivered to" : ""}</td>
                <td>
                  {dv.kind === "tares"
                    ? <Link to={`/agents/${encodeURIComponent(dv.agent)}?dispatch=${encodeURIComponent(d.dispatch_id)}`}><strong>{dv.agent}</strong></Link>
                    : dv.kind === "webhook"
                    ? <Link to={`/deliveries?agent=${encodeURIComponent(dv.agent)}`}><strong>{dv.agent}</strong></Link>
                    : <strong>{dv.agent}</strong>}
                  <span className="chip" style={{ margin: "0 8px" }}>
                    {dv.kind === "tares" ? "Tares agent" : dv.kind === "slack" ? "Slack" : "webhook"}</span>
                  {/* ok is tri-state: null is a Tares run still going — not a failure */}
                  {dv.ok === true && <span className="badge ok">delivered</span>}
                  {dv.ok === null && <span className="badge starting">running</span>}
                  {dv.ok === false && <span className="badge error" title={dv.error ?? undefined}>failed{dv.error ? `: ${dv.error.slice(0, 80)}` : ""}</span>}
                  {dv.delivered_at && <span className="help"> · <TimeAgo ts={dv.delivered_at} /></span>}
                  {dv.kind === "tares" && (
                    <span className="help"> · <Link to={`/agents/${encodeURIComponent(dv.agent)}?dispatch=${encodeURIComponent(d.dispatch_id)}`}>open the run</Link></span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>What subscribers received</h2>
      <pre className="payload">{payload}</pre>
    </>
  );
}

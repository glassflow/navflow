import { Link } from "react-router-dom";

import { AgentsRoster, Dispatches } from "./Activity";

// Deliveries: the runtime side of triggers. Who is subscribed (external webhooks and Slack
// channels, with delivery health) and every firing. Tares agents are authored things and live on
// their own page; a subscriber is a destination, not an agent (TR-137, and the TR-138 confusion).
export default function Deliveries() {
  return (
    <>
      <h1>Deliveries</h1>
      <p className="subtitle">
        where trigger firings go: every subscriber with its delivery health, and every firing
      </p>

      <h2>Subscribers</h2>
      <p className="help" style={{ margin: "0 0 10px", whiteSpace: "normal" }}>
        external agents (webhooks) and Slack channels subscribed to a trigger. Wire one from a{" "}
        <Link to="/triggers">trigger's</Link> page.
      </p>
      <AgentsRoster only="connected" />

      <h2 style={{ marginTop: 28 }}>Trigger firings</h2>
      <Dispatches />
    </>
  );
}

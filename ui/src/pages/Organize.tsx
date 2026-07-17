import { useState } from "react";

import OrganizePanel from "../components/OrganizePanel";
import { api } from "../api";
import { usePolling } from "../components/bits";

// Dedicated home for the Organize agent (docs/design/organize-agent.md): inspect the ingested
// data, propose labels/keys per source and views across sources as cards the user applies or
// skips. The run starts on an explicit click — never on page load (it spends model tokens).
export default function Organize() {
  const { data: sources } = usePolling(() => api.sources(), 15000);
  const [started, setStarted] = useState(false);

  const total = sources?.reduce((n, s) => n + (s.health?.events_total ?? 0), 0) ?? 0;
  const unlabeled = (sources ?? []).filter(
    (s) => !((s.config?.labels as unknown[] | undefined)?.length)).length;

  return (
    <>
      <h1>Organize</h1>
      <p className="subtitle">
        an agent reads your data and proposes labels &amp; views — <em>you apply or skip each card</em>
      </p>

      {!started && (
        <div className="panel" style={{ maxWidth: 640 }}>
          <p className="help" style={{ whiteSpace: "normal", marginTop: 0 }}>
            The agent inspects every source&rsquo;s field profile and sample events, judges which
            fields identify real entities, and proposes: the labels &amp; key each source should
            carry, and the views that give agents one correlated timeline per entity. Nothing is
            changed without your click, and labels apply to new events going forward.
          </p>
          {sources && (
            <p className="help" style={{ whiteSpace: "normal" }}>
              Right now: {sources.length} source{sources.length === 1 ? "" : "s"},{" "}
              {total.toLocaleString()} events{unlabeled > 0 && (
                <> — <strong>{unlabeled} source{unlabeled === 1 ? "" : "s"} with no labels declared</strong></>
              )}.
            </p>
          )}
          <button className="primary" disabled={!total}
                  onClick={() => setStarted(true)}>
            ✨ Start the sweep
          </button>
          {!total && <p className="help" style={{ marginTop: 8 }}>needs at least one source with data</p>}
        </div>
      )}

      {started && <OrganizePanel />}
    </>
  );
}

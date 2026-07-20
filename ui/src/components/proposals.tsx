import { useEffect, useState } from "react";

import { api } from "../api";
import type { Trigger } from "../types";

// Shared proposal-card machinery for the in-app agent (Ask chat + Organize). The agent's
// propose_* tools stream these as structured cards; every mutation happens only when the user
// clicks Apply, through the normal validated management APIs.

export type LabelSpec = { name: string; field?: string; const?: string; primary?: boolean;
                          pattern?: string; replace?: string; map?: Record<string, string> };
export type TriggerCondition = { aggregate: string; predicate: string; window: string; field?: string };
export type Proposal =
  | { id: string; kind: "labels"; source: string; labels: LabelSpec[]; reasoning: string }
  | { id: string; kind: "view"; name: string; key_field: string; sources: string[];
      filters?: Array<Record<string, unknown>>; reasoning: string }
  | { id: string; kind: "trigger"; name: string; view: string; condition: TriggerCondition;
      emit?: { kind?: string; context_window?: string }; cooldown?: string; reasoning: string };

export type Decision = "applied" | "skipped" | "error";
export type DecisionMap = Record<string, { status: Decision; detail?: string }>;

/** Apply one proposal via the normal management APIs. Throws with a readable message. */
export async function applyProposal(p: Proposal): Promise<void> {
  if (p.kind === "labels") {
    const src = await api.source(p.source);
    await api.updateSource(p.source, {
      name: src.name, type: src.type, connector: src.connector, poll: src.poll,
      config: { ...src.config, labels: p.labels },
    });
  } else if (p.kind === "view") {
    // Upsert: the agent proposes the same way for a new view and an edit to an existing one —
    // apply as an update when the name already exists (create-only 409'd with "already exists").
    const body = { name: p.name, key_field: p.key_field,
                   sources: p.sources, filters: (p.filters ?? []) as never };
    const exists = (await api.views()).some((v) => v.name === p.name);
    if (exists) await api.updateView(p.name, body);
    else await api.createView(body);
  } else {
    const t = {
      name: p.name, view: p.view,
      condition: p.condition,
      emit: { kind: p.emit?.kind ?? p.name, context_window: p.emit?.context_window ?? "15m" },
      cooldown: p.cooldown ?? "5m",
    } as Trigger;
    const exists = (await api.triggers()).some((x) => x.name === p.name);
    if (exists) await api.updateTrigger(p.name, t);
    else await api.createTrigger(t);
  }
}

/** The hard evidence for a proposed value merge: the actual before→after table computed against
 *  the source's observed values (same stateless preview endpoint the label editor uses). */
function NormPreview({ source, label }: { source: string; label: LabelSpec }) {
  const [preview, setPreview] = useState<{ sampled: number; distinct_before: number;
    distinct_after: number; results: { from: string; to: string; events: number }[] }>();
  const [err, setErr] = useState<string>();

  useEffect(() => {
    api.labelPreview(source, label as Record<string, unknown>)
      .then(setPreview)
      .catch((e) => setErr(String((e as Error).message ?? e)));
  }, [source, JSON.stringify(label)]);

  if (err) return <div className="alert error">merge preview failed: {err}</div>;
  if (!preview) return <div className="dim" style={{ marginBottom: 8 }}>computing merge preview…</div>;
  const merges = preview.results.filter((r) => r.from !== r.to);
  return (
    <div style={{ margin: "0 0 10px" }}>
      <span className="help">
        <span className="mono">{label.name}</span>: {preview.distinct_before} value{preview.distinct_before === 1 ? "" : "s"} →{" "}
        <strong>{preview.distinct_after}</strong> after this merge ({preview.sampled} events sampled)
        {merges.length === 0 && <> — <strong>no observed value actually changes</strong></>}
      </span>
      {merges.length > 0 && (
        <table style={{ marginTop: 6 }}>
          <thead><tr><th>value seen</th><th className="num">events</th><th>will become</th></tr></thead>
          <tbody>
            {merges.slice(0, 8).map((r, k) => (
              <tr key={k}>
                <td className="mono">{r.from}</td>
                <td className="num">{r.events}</td>
                <td className="mono"><span className="badge ok" style={{ marginRight: 6 }}>→</span>{r.to}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function ProposalCard({ proposal, decision, onApply, onSkip }: {
  proposal: Proposal; decision?: { status: Decision; detail?: string };
  onApply: () => void; onSkip: () => void;
}) {
  const st = decision?.status;
  return (
    <div className="card" style={{ margin: "10px 0", padding: 14, opacity: st === "skipped" ? 0.55 : 1 }}>
      <div className="pagehead" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>
          {proposal.kind === "labels" && <>Labels for <span className="mono">{proposal.source}</span></>}
          {proposal.kind === "view" && <>View <span className="mono">{proposal.name}</span></>}
          {proposal.kind === "trigger" && <>Trigger <span className="mono">{proposal.name}</span></>}
        </h3>
        {st === "applied" && <span className="badge ok">applied</span>}
        {st === "skipped" && <span className="badge starting">skipped</span>}
        {st === "error" && <span className="badge error">failed</span>}
      </div>

      {proposal.kind === "labels" && (
        <table style={{ marginBottom: 8 }}>
          <thead><tr><th>label</th><th>from</th></tr></thead>
          <tbody>
            {proposal.labels.map((l) => (
              <tr key={l.name}>
                <td className="mono">{l.name}{l.primary && <span className="badge ok" style={{ marginLeft: 8 }}>key</span>}</td>
                <td className="mono">
                  {l.field != null
                    ? <><span className="badge push" style={{ marginRight: 8 }}>field</span>{l.field}</>
                    : <><span className="badge push" style={{ marginRight: 8 }}>const</span>{String(l.const ?? "")}</>}
                  {(l.pattern || l.map) && (
                    <div className="help">
                      normalize: {l.pattern && <>s/<span className="mono">{l.pattern}</span>/<span className="mono">{l.replace ?? ""}</span>/</>}
                      {l.pattern && l.map ? " · " : ""}
                      {l.map && `${Object.keys(l.map).length} alias(es)`}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {proposal.kind === "view" && (
        <p style={{ margin: "0 0 8px" }}>
          key <span className="chip mono">{proposal.key_field}</span> over{" "}
          {proposal.sources.map((s) => <span className="chip mono" key={s}>{s}</span>)}
          {!!proposal.filters?.length && <> · {proposal.filters.length} filter(s)</>}
        </p>
      )}

      {proposal.kind === "trigger" && (
        <p style={{ margin: "0 0 8px" }} className="mono">
          {proposal.condition.aggregate}({proposal.condition.field ?? "*"}){" "}
          {proposal.condition.predicate} over {proposal.condition.window} on{" "}
          <span className="chip">{proposal.view}</span>
          <span className="help" style={{ display: "block", fontFamily: "inherit" }}>
            wakes subscribers with {proposal.emit?.context_window ?? "15m"} of timeline ·
            cooldown {proposal.cooldown ?? "5m"} per entity
          </span>
        </p>
      )}

      {proposal.kind === "labels" && proposal.labels
        .filter((l) => l.field && (l.pattern || l.map))
        .map((l) => <NormPreview key={l.name} source={proposal.source} label={l} />)}

      <p className="help" style={{ whiteSpace: "normal", margin: "0 0 10px" }}>{proposal.reasoning}</p>
      {decision?.detail && <div className="alert error">{decision.detail}</div>}

      {(!st || st === "error") && (
        <div className="btnrow">
          <button className="primary" onClick={onApply}>{st === "error" ? "Retry" : "Apply"}</button>
          <button onClick={onSkip}>Skip</button>
        </div>
      )}
    </div>
  );
}

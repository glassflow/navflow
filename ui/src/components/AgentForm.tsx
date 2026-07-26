import { useState } from "react";

import { api } from "../api";
import { Combo } from "./bits";
import type { AgentPreset, BuiltinAgent } from "../types";

// Create/edit a NavFlow agent. One editable substance field — the prompt — seeded by a preset.
// Model/tools/budgets are NavFlow's decisions and never surfaced: a second knob turns a data-plane
// feature into an agent builder (docs/design/navflow-agents.md). The trigger is chosen at creation
// and fixed thereafter (move an agent by deleting and recreating), so it's read-only when editing.
export default function AgentForm({ initial, presetTrigger, triggers, presets, onSaved, onCancel }: {
  initial?: BuiltinAgent;              // absent = create
  presetTrigger?: string;              // create: trigger preselected (came from a trigger page)
  triggers: string[];
  presets: AgentPreset[];
  onSaved: (name: string) => void;
  onCancel: () => void;
}) {
  const isNew = !initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [trigger, setTrigger] = useState(initial?.trigger ?? presetTrigger ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [slack, setSlack] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const save = async () => {
    setBusy(true); setErr(undefined);
    const body = { name: name.trim(), trigger, prompt: prompt.trim(), slack_webhook: slack.trim() };
    try {
      if (isNew) await api.createBuiltinAgent(body);
      else await api.updateBuiltinAgent(initial!.name, body);
      onSaved(body.name);
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    setBusy(false);
  };

  return (
    <div className="panel">
      {err && <div className="alert error">{err}</div>}
      {isNew ? (
        <div className="row2">
          <label className="field">
            <span className="lbl">name</span>
            <input type="text" value={name} placeholder="e.g. incident-first-look"
                   onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="field">
            <span className="lbl">trigger</span>
            <Combo value={trigger} options={triggers}
                   placeholder="the trigger that wakes this agent" onChange={setTrigger} />
            <span className="help">the agent runs when this trigger fires</span>
          </div>
        </div>
      ) : (
        // Name and trigger are fixed after creation — shown as read-only facts, not fields, so it's
        // clear they can't be edited here (to move the agent, delete and recreate).
        <table style={{ marginBottom: 12 }}>
          <tbody>
            <tr><td className="help" style={{ width: 120 }}>name</td>
                <td className="mono">{name} <span className="help">— fixed</span></td></tr>
            <tr><td className="help">trigger</td>
                <td className="mono">{trigger} <span className="help">— fixed; delete and recreate to move</span></td></tr>
          </tbody>
        </table>
      )}
      <label className="field">
        <span className="lbl">prompt</span>
        <textarea rows={12} className="mono" value={prompt}
                  onChange={(e) => setPrompt(e.target.value)} />
        <span className="help">
          what to look for and what to write. The correlated timeline at firing time is supplied
          automatically; the agent's final message becomes the finding.
        </span>
      </label>
      {isNew && presets.length > 0 && (
        <div className="btnrow" style={{ marginBottom: 8 }}>
          <span className="help" style={{ alignSelf: "center" }}>start from:</span>
          {presets.map((p) => (
            <button key={p.id} onClick={() => setPrompt(p.prompt)}>{p.label}</button>
          ))}
        </div>
      )}
      <label className="field">
        <span className="lbl">Slack webhook <span className="help">(optional)</span></span>
        <input type="text" className="mono" placeholder={
          initial?.slack_configured ? "•••• configured — leave blank to keep" : "https://hooks.slack.com/services/…"}
               value={slack} onChange={(e) => setSlack(e.target.value)} />
        <span className="help">the full finding is posted there, not a link</span>
      </label>
      <div className="btnrow">
        <button className="primary" onClick={save}
                disabled={busy || !name.trim() || !trigger.trim() || !prompt.trim()}>
          {isNew ? "Create agent" : "Save changes"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

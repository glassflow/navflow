import { useEffect, useState } from "react";

import { api } from "../api";
import type { SlackChannels } from "../api";
import { Combo, Picker } from "./bits";
import type { AgentPreset, BuiltinAgent } from "../types";

// Create/edit a Tares agent. The prompt is the substance; the model is the one runtime choice an
// agent may pin (default: follow the instance). Tools and budgets stay Tares's decisions — more
// knobs turn a data-plane feature into an agent builder (docs/design/tares-agents.md). The trigger
// is chosen at creation and fixed thereafter (move an agent by deleting and recreating).
export default function AgentForm({ initial, presetTrigger, triggers, presets, models,
                                    defaultModel, slackWorkspace, onSaved, onCancel }: {
  initial?: BuiltinAgent;              // absent = create
  presetTrigger?: string;              // create: trigger preselected (came from a trigger page)
  triggers: string[];
  presets: AgentPreset[];
  models: string[];                    // curated choices; [0] is the instance default
  defaultModel: string;
  slackWorkspace: boolean;             // a workspace bot token is configured
  onSaved: (name: string) => void;
  onCancel: () => void;
}) {
  const isNew = !initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [trigger, setTrigger] = useState(initial?.trigger ?? presetTrigger ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [channel, setChannel] = useState(initial?.slack_channel ?? "");
  const [slack, setSlack] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  // "" is a real option — follow the instance default — so the picker always has one more entry
  // than the curated list, and the default reads as what it is rather than as a copy of a model.
  const modelOptions = ["", ...models.filter((m) => m !== defaultModel)];
  const modelLabels: Record<string, string> = { "": `${defaultModel} · instance default` };

  // The channel list comes from the workspace bot, exactly like the trigger page's picker: only
  // channels the bot is in are offered, because anything else fails at the first post.
  const [channels, setChannels] = useState<SlackChannels>();
  useEffect(() => {
    if (!slackWorkspace) return;
    let live = true;
    api.slackChannels().then((c) => { if (live) setChannels(c); })
      .catch(() => { if (live) setChannels({ channels: [], reason: "error" }); });
    return () => { live = false; };
  }, [slackWorkspace]);
  const chanList = channels?.reason === null ? channels.channels : [];
  const chanLabels: Record<string, string> = { "": "no channel — don't post" };
  for (const c of chanList) chanLabels[c.id] = (c.is_private ? "🔒 " : "#") + c.name;

  const save = async () => {
    setBusy(true); setErr(undefined);
    const body = { name: name.trim(), trigger, prompt: prompt.trim(), model,
                   slack_channel: channel, slack_webhook: slack.trim() };
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
      <div className="field">
        <span className="lbl">model</span>
        <Picker value={model} onChange={setModel} options={modelOptions} labels={modelLabels}
                ariaLabel="model" />
        <span className="help">the model this agent runs on; leave on the default to follow the instance</span>
      </div>
      {slackWorkspace ? (
        <>
          <div className="field">
            <span className="lbl">post findings to Slack <span className="help">(optional)</span></span>
            <Picker value={channel} onChange={setChannel}
                    options={["", ...chanList.map((c) => c.id)]} labels={chanLabels}
                    ariaLabel="Slack channel" />
            <span className="help">
              posted by the workspace bot; the full finding, not a link.
              {channels?.reason === "missing_scope" && " (reconnect Slack to list channels)"}
              {channels?.reason === null && chanList.length === 0 && " Add the bot to a channel in Slack first."}
            </span>
          </div>
          <label className="field">
            <span className="lbl">Slack webhook <span className="help">(legacy — used only when no channel is set)</span></span>
            <input type="text" className="mono" placeholder={
              initial?.slack_configured ? "•••• configured — leave blank to keep" : "https://hooks.slack.com/services/…"}
                   value={slack} onChange={(e) => setSlack(e.target.value)} />
          </label>
        </>
      ) : (
        <label className="field">
          <span className="lbl">Slack webhook <span className="help">(optional)</span></span>
          <input type="text" className="mono" placeholder={
            initial?.slack_configured ? "•••• configured — leave blank to keep" : "https://hooks.slack.com/services/…"}
                 value={slack} onChange={(e) => setSlack(e.target.value)} />
          <span className="help">
            the full finding is posted there, not a link. Connect a workspace bot under Security to
            pick a channel instead.
          </span>
        </label>
      )}
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

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api } from "../api";
import { usePolling } from "../components/bits";

type Status = { available: boolean; root: string; sessions: number; connected: boolean };

// Dedicated setup page for the Claude Code source — reached from the "Claude Code" button on the
// Sources page. Treats Claude Code like any other source: detect, choose what to ingest, connect.
// Nothing is ingested until the user connects; disconnecting removes the source.
export default function SourceClaudeCode() {
  const nav = useNavigate();
  const { data: sources, reload } = usePolling(() => api.sources(), 10000);
  const [st, setSt] = useState<Status>();
  const [redact, setRedact] = useState(true);
  const [includeThinking, setIncludeThinking] = useState(false);
  const [pushMode, setPushMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const refresh = () => api.claudeCodeStatus().then(setSt).catch(() => setSt(undefined));
  useEffect(() => { refresh(); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const connected = (sources?.some((s) => s.connector === "claude_code")) ?? st?.connected ?? false;

  const connect = async () => {
    setBusy(true); setErr(undefined);
    const config: Record<string, unknown> = {};
    if (!redact) config.redact = false;            // redact defaults on; only store the override
    if (includeThinking) config.include_thinking = true;
    if (pushMode) config.push = true;              // fed by the plugin via /ingest, not tailed here
    try {
      await api.createSource({ name: "claude_code", connector: "claude_code", poll: "10s", config });
      reload();
      nav("/sources/claude_code");                 // hand off to the normal source detail page
    } catch (e) { setErr(String((e as Error).message ?? e)); setBusy(false); }
  };

  const disconnect = async () => {
    if (!window.confirm("Disconnect Claude Code? Stored session events are kept unless you delete the source with purge.")) return;
    setBusy(true); setErr(undefined);
    try { await api.deleteSource("claude_code", false); await refresh(); reload(); }
    catch (e) { setErr(String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <h1>Claude Code sessions</h1>
      <p className="subtitle">
        Stream this machine's Claude Code sessions into NavFlow — keyed by session, with project,
        branch and model labels. Secrets are redacted. Nothing is ingested until you connect.
      </p>

      {err && <div className="alert error">{err}</div>}

      <div className="panel">
        <div className="pagehead" style={{ marginBottom: st?.available || !st ? 8 : 0 }}>
          <h2 style={{ margin: 0 }}>Detection</h2>
          {connected && <span className="badge ok">connected</span>}
        </div>
        {!st && <div className="dim">checking this machine…</div>}
        {st && (
          <div className="help" style={{ whiteSpace: "normal" }}>
            {st.available
              ? <><span className="mono">{st.sessions}</span> session{st.sessions === 1 ? "" : "s"} found in <span className="mono">{st.root}</span></>
              : <>No Claude Code sessions found here (<span className="mono">~/.claude/projects</span> not present). If NavFlow is running remotely, you'll connect from your own machine instead.</>}
          </div>
        )}
      </div>

      {connected ? (
        <div className="panel">
          <p className="subtitle" style={{ marginTop: 0 }}>
            Connected — sessions are tailing into the <span className="mono">claude_code</span> source.
            Edit what's ingested or remove it from the source page.
          </p>
          <div className="btnrow">
            <Link className="btn primary" to="/sources/claude_code">Manage source</Link>
            <button className="danger" onClick={disconnect} disabled={busy}>{busy ? "…" : "Disconnect"}</button>
          </div>
        </div>
      ) : (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>What to ingest</h2>
          <label className="field" style={{ marginBottom: 12 }}>
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center", fontWeight: 600, fontSize: 13 }}>
              <input type="checkbox" checked={redact} onChange={(e) => setRedact(e.target.checked)} />
              Redact secrets <span className="dim" style={{ fontWeight: 400 }}>(recommended)</span>
            </span>
            <span className="help">Strip obvious API keys, tokens and private keys from text and payload before storage.</span>
          </label>
          <label className="field" style={{ marginBottom: 12 }}>
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center", fontWeight: 600, fontSize: 13 }}>
              <input type="checkbox" checked={includeThinking} onChange={(e) => setIncludeThinking(e.target.checked)} />
              Include assistant thinking
            </span>
            <span className="help">Ingest the model's private reasoning blocks into the event text. Off by default.</span>
          </label>
          <label className="field">
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center", fontWeight: 600, fontSize: 13 }}>
              <input type="checkbox" checked={pushMode} onChange={(e) => setPushMode(e.target.checked)} />
              Stream via the Claude Code plugin <span className="dim" style={{ fontWeight: 400 }}>(don't read files here)</span>
            </span>
            <span className="help">
              For remote NavFlow, or to capture live via hooks: the plugin posts sessions to this source
              instead of NavFlow tailing files on this machine. Install the plugin from <span className="mono">claude-plugin/</span>.
            </span>
          </label>
          <div className="btnrow" style={{ marginTop: 8 }}>
            <button className="primary" onClick={connect} disabled={busy || (!!st && !st.available)}>
              {busy ? "Connecting…" : "Connect"}
            </button>
            <Link className="btn" to="/">Cancel</Link>
          </div>
        </div>
      )}
    </>
  );
}

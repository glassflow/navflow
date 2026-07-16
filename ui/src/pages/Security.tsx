import { useEffect, useState } from "react";

import { api } from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import { TimeAgo } from "../components/bits";
import type { ApiKey } from "../types";

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copybtn"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? "copied" : "copy"}
    </button>
  );
}

// Instance credentials the operator hands to machines. Read-only for now; create/revoke lands here
// later (today the ingest token is set once via NAVFLOW_INGEST_TOKEN on the daemon).
export default function Security() {
  const [data, setData] = useState<{ ingest_token: string | null; ingest_required: boolean }>();
  const [err, setErr] = useState<string>();
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    api.security().then(setData).catch((e) => setErr(String((e as Error).message ?? e)));
  }, []);

  const token = data?.ingest_token ?? "";
  const masked =
    token.length > 8
      ? `${token.slice(0, 4)}${"•".repeat(token.length - 8)}${token.slice(-4)}`
      : "••••••••";

  return (
    <>
      <h1>Security</h1>
      <p className="subtitle">
        instance credentials — the tokens machines use to reach this NavFlow
      </p>

      {err && <div className="alert error">{err}</div>}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Ingest token</h2>
        <p className="help" style={{ marginTop: 0 }}>
          Producers (webhooks, Vercel / OTLP drains) send this as <code>X-NavFlow-Token</code> or{" "}
          <code>Authorization: Bearer …</code> when POSTing to <code>/ingest/&lt;source&gt;</code> and{" "}
          <code>/v1/*</code>. It is separate from your console / MCP login token.
        </p>

        {!data && !err ? (
          <div className="muted">loading…</div>
        ) : data?.ingest_required && token ? (
          <div className="btnrow" style={{ alignItems: "center" }}>
            <code className="payload" style={{ flex: 1, margin: 0, wordBreak: "break-all" }}>
              {revealed ? token : masked}
            </code>
            <button onClick={() => setRevealed((r) => !r)}>{revealed ? "hide" : "reveal"}</button>
            <Copy text={token} />
          </div>
        ) : data ? (
          <div className="alert">
            Ingest is <strong>open</strong> on this instance — no token is required, so anyone who
            knows an <code>/ingest/&lt;key&gt;</code> URL can post to it. Set{" "}
            <code>NAVFLOW_INGEST_TOKEN</code> on the daemon to require a token.
          </div>
        ) : null}
      </div>

      <ApiKeysPanel />
    </>
  );
}

// Scope semantics (docs/design/api-keys.md): read = consume (queries, catalog reads, an agent's
// own derive/subscribe) · ingest = contribute events · admin = configure the instance.
const SCOPE_HELP: Record<string, string> = {
  read: "consume — queries, timelines, catalog; agents' own views & subscriptions",
  ingest: "contribute — POST events to /ingest and /v1/*, write memories",
  admin: "configure — sources/views/triggers, credentials, keys (implies the rest)",
};

function ApiKeysPanel() {
  const [keys, setKeys] = useState<ApiKey[]>();
  const [enforced, setEnforced] = useState(true);
  const [err, setErr] = useState<string>();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read"]);
  const [minted, setMinted] = useState<{ name: string; secret: string }>();
  const [revoking, setRevoking] = useState<ApiKey>();
  const [busy, setBusy] = useState(false);

  const load = () => api.keys().then((r) => { setKeys(r.keys); setEnforced(r.enforced); })
    .catch((e) => setErr(String((e as Error).message ?? e)));
  useEffect(() => { load(); }, []);

  const create = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const r = await api.createKey(name.trim(), scopes);
      setMinted({ name: r.name, secret: r.secret });
      setName("");
      load();
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    setBusy(false);
  };

  const active = (keys ?? []).filter((k) => !k.revoked_at);

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>API keys</h2>
      <p className="help" style={{ marginTop: 0 }}>
        Scoped, revocable credentials — hand each producer and agent its own key instead of a
        shared token. <strong>read</strong>: agents over MCP · <strong>ingest</strong>: producers ·{" "}
        <strong>read + ingest</strong>: the Claude Code plugin · <strong>admin</strong>: full control.
      </p>
      {!enforced && keys && (
        <div className="alert">
          No <code>NAVFLOW_AUTH_TOKEN</code> is set, so this instance is open and keys are not
          enforced. Keys become meaningful once the daemon has a root auth token.
        </div>
      )}
      {err && <div className="alert error">{err}</div>}

      {minted && (
        <div className="alert ok">
          Key <strong>{minted.name}</strong> created — copy the secret now; it is not shown again:
          <div className="ingest-url" style={{ marginTop: 8 }}>
            <code className="mono">{minted.secret}</code>
            <CopySecret text={minted.secret} />
          </div>
          <button style={{ marginTop: 8 }} onClick={() => setMinted(undefined)}>done</button>
        </div>
      )}

      {keys && keys.length > 0 && (
        <table style={{ marginBottom: 14 }}>
          <thead><tr><th>name</th><th>scopes</th><th>key</th><th>created</th><th>last used</th><th></th></tr></thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} style={k.revoked_at ? { opacity: 0.45 } : undefined}>
                <td>{k.name}</td>
                <td>{k.scopes.map((s) => <span className="chip" key={s} title={SCOPE_HELP[s]}>{s}</span>)}</td>
                <td className="mono">{k.prefix}…</td>
                <td className="help"><TimeAgo ts={k.created_at} /></td>
                <td className="help">{k.revoked_at ? "revoked" : k.last_used_at ? <TimeAgo ts={k.last_used_at} /> : "never"}</td>
                <td style={{ textAlign: "right" }}>
                  {!k.revoked_at && (
                    <button className="danger" onClick={() => setRevoking(k)}>revoke</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {keys && active.length === 0 && <p className="help">no active keys yet — create one below</p>}

      <div style={{ borderTop: "1px solid var(--line)", marginTop: 18, paddingTop: 16, maxWidth: 560 }}>
        <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>Create a key</h3>
        <label className="field" style={{ maxWidth: 320 }}>
          <span className="lbl">name</span>
          <input type="text" placeholder="e.g. otel-prod, my-agent" value={name}
                 onChange={(e) => setName(e.target.value)} />
          <span className="help">who holds it — one key per producer or agent</span>
        </label>
        <div className="field">
          <span className="lbl">scopes</span>
          {Object.entries(SCOPE_HELP).map(([s, help]) => (
            <label key={s} style={{ display: "flex", gap: 10, alignItems: "baseline",
                                     padding: "5px 0", cursor: "pointer" }}>
              <input type="checkbox" checked={scopes.includes(s)}
                     style={{ transform: "translateY(1px)" }}
                     onChange={(e) => setScopes(e.target.checked
                       ? [...scopes, s] : scopes.filter((x) => x !== s))} />
              <span className="mono" style={{ minWidth: 56 }}>{s}</span>
              <span className="help" style={{ margin: 0 }}>{help}</span>
            </label>
          ))}
        </div>
        <button className="primary" disabled={busy || !name.trim() || scopes.length === 0}
                onClick={create}>Create key</button>
      </div>

      {revoking && (
        <ConfirmDialog
          title={`Revoke ${revoking.name}?`}
          message="The key stops working immediately and its subscriptions are removed. Producers or agents still using it will start failing."
          confirmLabel="Revoke"
          danger
          onCancel={() => setRevoking(undefined)}
          onConfirm={async () => {
            try { await api.revokeKey(revoking.id); } catch (e) { setErr(String((e as Error).message ?? e)); }
            setRevoking(undefined);
            load();
          }}
        />
      )}
    </div>
  );
}

function CopySecret({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button onClick={() => {
      navigator.clipboard?.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    }}>{done ? "copied" : "copy"}</button>
  );
}

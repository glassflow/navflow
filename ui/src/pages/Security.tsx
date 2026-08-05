import { useEffect, useState } from "react";

import { api } from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import { Close } from "../components/icons";
import { TimeAgo } from "../components/bits";
import type { ApiKey } from "../types";

// Four distinct credential concepts, one box each:
//   · Access     — is this instance open, or does it require a login? (tares up --auth)
//   · API keys   — scoped, revocable, show-once credentials the operator mints for machines
//   · Anthropic  — the model key Tares agents (and Ask) run on
//   · Slack      — the bot token behind slack:// trigger subscriptions (outbound), and the
//                  signing secret that authenticates the /tares slash command (inbound)
// The per-source ingest URL is an address, not a secret — it lives on the source page, not here.
export default function Security() {
  return (
    <>
      <h1>Security</h1>
      <p className="subtitle">how this instance is secured, and the credentials it issues</p>
      <AccessPanel />
      <ApiKeysPanel />
      <AnthropicKeyPanel />
      <SlackTokenPanel />
      <SlackSigningSecretPanel />
    </>
  );
}

// Auth is set at launch: `tares up` is open; `tares up --auth` requires a login (a root token
// printed to the terminal). This box states which mode you're in — there's no runtime toggle, so
// it's status, not a control.
function AccessPanel() {
  const [authRequired, setAuthRequired] = useState<boolean>();
  useEffect(() => {
    api.health().then((h) => setAuthRequired(h.auth_required)).catch(() => setAuthRequired(undefined));
  }, []);

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Access</h2>
      {authRequired === undefined ? <div className="muted">loading…</div>
        : authRequired ? (
          <p style={{ margin: 0 }}>
            <span className="badge ok">auth on</span>{" "}
            <span className="help">
              the console and API require a login. You signed in with the root token printed by{" "}
              <code>tares up --auth</code>. Hand machines their own scoped <strong>API keys</strong>{" "}
              below — never the root token.
            </span>
          </p>
        ) : (
          <div className="alert">
            <span className="badge">auth off</span> — this instance is <strong>open</strong>: anyone
            who can reach it can read and write, and API keys are not enforced. Restart with{" "}
            <code>tares up --auth</code> to require a login.
          </div>
        )}
    </div>
  );
}

// The key Tares agents run on. Two ways in — the environment, or here — because plenty of local
// users launch Tares from a desktop shortcut and have no shell to export into. Env always wins,
// so a deployment's config is never silently overridden by something typed in here months earlier.
function AnthropicKeyPanel() {
  const [st, setSt] = useState<{ configured: boolean; source: string; stored: boolean; env_overrides: boolean }>();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [msg, setMsg] = useState<string>();

  const load = () =>
    api.anthropicKeyStatus().then(setSt).catch((e) => setErr(String((e as Error).message ?? e)));
  useEffect(() => { load(); }, []);

  const save = async () => {
    setBusy(true); setErr(undefined); setMsg(undefined);
    try {
      const r = await api.setAnthropicKey(key.trim());
      setKey("");
      setMsg(r.note ?? "✓ saved");
      await load();
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    setBusy(false);
  };

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Anthropic key</h2>
      <p className="help" style={{ marginTop: 0 }}>
        What <strong>Tares agents</strong> run on — their first look at an entity when a trigger
        fires. Set <code>ANTHROPIC_API_KEY</code> in the daemon's environment, or store one here.
        It is never returned by the API and never included in a catalog export.
      </p>

      {err && <div className="alert error">{err}</div>}
      {msg && <p className="help">{msg}</p>}

      {!st ? <div className="muted">loading…</div> : (
        <>
          <p style={{ margin: "0 0 10px" }}>
            {st.configured
              ? <><span className="badge ok">configured</span>{" "}
                  <span className="help">from <span className="mono">{st.source}</span></span></>
              : <><span className="badge error">not configured</span>{" "}
                  <span className="help">agents cannot be enabled until one is set</span></>}
          </p>
          {st.env_overrides && st.stored && (
            <div className="alert">
              A key is set in the environment and takes precedence — the one stored here is not in
              use. Remove the environment variable, or clear the stored key to avoid confusion.
            </div>
          )}
          <div className="btnrow" style={{ alignItems: "center", maxWidth: 720 }}>
            <input type="password" className="mono" style={{ flex: 1 }} placeholder="sk-ant-…"
                   value={key} onChange={(e) => setKey(e.target.value)} />
            <button className="primary" disabled={busy || !key.trim()} onClick={save}>Save</button>
            {st.stored && (
              <button className="danger" disabled={busy} onClick={async () => {
                setBusy(true);
                try { await api.clearAnthropicKey(); await load(); }
                catch (e) { setErr(String((e as Error).message ?? e)); }
                setBusy(false);
              }}>Clear stored</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// One bot token per instance, behind every `slack://channel/<id>` trigger subscription. Same
// contract as the Anthropic key — env wins, the value is never returned — so this panel is a
// deliberate near-copy rather than a variation the reader has to diff in their head.
function SlackTokenPanel() {
  const [st, setSt] = useState<{ configured: boolean; source: string; stored: boolean; env_overrides: boolean }>();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [msg, setMsg] = useState<string>();

  const load = () =>
    api.slackTokenStatus().then(setSt).catch((e) => setErr(String((e as Error).message ?? e)));
  useEffect(() => { load(); }, []);

  const save = async () => {
    setBusy(true); setErr(undefined); setMsg(undefined);
    try {
      const r = await api.setSlackToken(token.trim());
      setToken("");
      setMsg(r.note ?? "✓ saved");
      await load();
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    setBusy(false);
  };

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Slack bot token</h2>
      <p className="help" style={{ marginTop: 0 }}>
        Lets a trigger post to a channel: subscribe{" "}
        <code>slack://channel/C0123456789</code> on any trigger and every firing is delivered,
        retried and logged like a webhook. Create a Slack app with the <code>chat:write</code>{" "}
        scope, invite it to the channel, and paste its <strong>Bot User OAuth Token</strong> here —
        or set <code>TARES_SLACK_BOT_TOKEN</code> in the daemon's environment. It is never
        returned by the API and never included in a catalog export.
      </p>

      {err && <div className="alert error">{err}</div>}
      {msg && <p className="help">{msg}</p>}

      {!st ? <div className="muted">loading…</div> : (
        <>
          <p style={{ margin: "0 0 10px" }}>
            {st.configured
              ? <><span className="badge ok">configured</span>{" "}
                  <span className="help">from <span className="mono">{st.source}</span></span></>
              : <><span className="badge">not configured</span>{" "}
                  <span className="help">channels cannot be subscribed until one is set</span></>}
          </p>
          {st.env_overrides && st.stored && (
            <div className="alert">
              A token is set in the environment and takes precedence — the one stored here is not in
              use. Remove the environment variable, or clear the stored token to avoid confusion.
            </div>
          )}
          <div className="btnrow" style={{ alignItems: "center", maxWidth: 720 }}>
            <input type="password" className="mono" style={{ flex: 1 }} placeholder="xoxb-…"
                   value={token} onChange={(e) => setToken(e.target.value)} />
            <button className="primary" disabled={busy || !token.trim()} onClick={save}>Save</button>
            {st.stored && (
              <button className="danger" disabled={busy} onClick={async () => {
                setBusy(true);
                try { await api.clearSlackToken(); await load(); }
                catch (e) { setErr(String((e as Error).message ?? e)); }
                setBusy(false);
              }}>Clear stored</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// The other half of Slack: the signing secret that authenticates requests coming IN. Same
// write-only contract again, and the same panel shape — but this one is the security boundary for
// the only route that is public to the auth middleware, so the copy says what happens without it.
function SlackSigningSecretPanel() {
  const [st, setSt] = useState<{ configured: boolean; source: string; stored: boolean; env_overrides: boolean }>();
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [msg, setMsg] = useState<string>();

  const load = () =>
    api.slackSigningSecretStatus().then(setSt).catch((e) => setErr(String((e as Error).message ?? e)));
  useEffect(() => { load(); }, []);

  const save = async () => {
    setBusy(true); setErr(undefined); setMsg(undefined);
    try {
      const r = await api.setSlackSigningSecret(secret.trim());
      setSecret("");
      setMsg(r.note ?? "✓ saved");
      await load();
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    setBusy(false);
  };

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Slack signing secret</h2>
      <p className="help" style={{ marginTop: 0 }}>
        Lets your team ask Tares from Slack: point the Slack app's <code>/tares</code> slash
        command at <code>/api/slack/events</code> on this instance and run{" "}
        <code>/tares ask what happened to checkout-svc?</code> in any channel. Paste the app's{" "}
        <strong>Signing Secret</strong> (Basic Information) here, or set{" "}
        <code>TARES_SLACK_SIGNING_SECRET</code>. Every inbound request is verified against it and
        replays older than 5 minutes are refused; with no secret configured the endpoint answers
        503 rather than trusting anything. The secret is never returned by the API.
      </p>

      {err && <div className="alert error">{err}</div>}
      {msg && <p className="help">{msg}</p>}

      {!st ? <div className="muted">loading…</div> : (
        <>
          <p style={{ margin: "0 0 10px" }}>
            {st.configured
              ? <><span className="badge ok">configured</span>{" "}
                  <span className="help">from <span className="mono">{st.source}</span></span></>
              : <><span className="badge">not configured</span>{" "}
                  <span className="help">inbound Slack requests are refused until one is set</span></>}
          </p>
          {st.env_overrides && st.stored && (
            <div className="alert">
              A signing secret is set in the environment and takes precedence — the one stored here
              is not in use. Remove the environment variable, or clear the stored secret.
            </div>
          )}
          <div className="btnrow" style={{ alignItems: "center", maxWidth: 720 }}>
            <input type="password" className="mono" style={{ flex: 1 }} placeholder="signing secret"
                   value={secret} onChange={(e) => setSecret(e.target.value)} />
            <button className="primary" disabled={busy || !secret.trim()} onClick={save}>Save</button>
            {st.stored && (
              <button className="danger" disabled={busy} onClick={async () => {
                setBusy(true);
                try { await api.clearSlackSigningSecret(); await load(); }
                catch (e) { setErr(String((e as Error).message ?? e)); }
                setBusy(false);
              }}>Clear stored</button>
            )}
          </div>
        </>
      )}
    </div>
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
  const [minted, setMinted] = useState<{ name: string; secret: string }>();
  const [revoking, setRevoking] = useState<ApiKey>();
  const [creating, setCreating] = useState(false);

  const load = () => api.keys().then((r) => { setKeys(r.keys); setEnforced(r.enforced); })
    .catch((e) => setErr(String((e as Error).message ?? e)));
  useEffect(() => { load(); }, []);

  return (
    <div className="panel">
      <div className="pagehead" style={{ marginBottom: 6 }}>
        <h2 style={{ margin: 0 }}>API keys</h2>
        <button className="primary" onClick={() => setCreating(true)}>Create key</button>
      </div>
      <p className="help" style={{ marginTop: 0 }}>
        Scoped, revocable credentials — hand each producer and agent its own key instead of a
        shared token. <strong>read</strong>: agents over MCP · <strong>ingest</strong>: producers ·{" "}
        <strong>read + ingest</strong>: the Claude Code plugin · <strong>admin</strong>: full control.
      </p>
      {!enforced && keys && (
        <div className="alert">
          No <code>TARES_AUTH_TOKEN</code> is set, so this instance is open and keys are not
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

      {keys && keys.length > 0 ? (
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
      ) : (
        <p className="help">no keys yet — <strong>Create key</strong> to issue one for a producer or agent.</p>
      )}

      {creating && (
        <KeyModal
          onClose={() => setCreating(false)}
          onCreated={(m) => { setCreating(false); setMinted(m); load(); }}
        />
      )}

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

// Create-key modal — name + scope checkboxes. The secret only exists in the create response, so it
// surfaces once (in the panel's "created" alert) and never again; this dialog just collects inputs.
function KeyModal({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (m: { name: string; secret: string }) => void;
}) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read"]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const create = async () => {
    setBusy(true); setErr(undefined);
    try {
      const r = await api.createKey(name.trim(), scopes);
      onCreated({ name: r.name, secret: r.secret });
    } catch (e) { setErr(String((e as Error).message ?? e)); setBusy(false); }
  };

  return (
    <>
      <div className="sheet-overlay" style={{ zIndex: 100 }} onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label="Create API key">
        <div className="sheet-head">
          <div className="sheet-title"><h2 style={{ margin: 0 }}>Create API key</h2></div>
          <button className="sheet-close" onClick={onClose} aria-label="Close"><Close /></button>
        </div>
        <div className="modal-body">
          {err && <div className="alert error">{err}</div>}
          <label className="field">
            <span className="lbl">name</span>
            <input type="text" placeholder="e.g. otel-prod, my-agent" value={name} autoFocus
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
        </div>
        <div className="sheet-foot">
          <button className="primary" disabled={busy || !name.trim() || scopes.length === 0}
                  onClick={create}>{busy ? "…" : "Create key"}</button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </>
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

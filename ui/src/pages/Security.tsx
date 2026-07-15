import { useEffect, useState } from "react";

import { api } from "../api";

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

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Rotate &amp; revoke</h2>
        <p className="help" style={{ marginTop: 0 }}>
          Coming soon — create and revoke ingest tokens from here. Today the token is set once via
          the <code>NAVFLOW_INGEST_TOKEN</code> environment variable on the daemon.
        </p>
      </div>
    </>
  );
}

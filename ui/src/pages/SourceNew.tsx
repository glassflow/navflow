import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api } from "../api";
import IngestSetup from "../components/IngestSetup";
import SourceForm from "../components/SourceForm";
import type { ConnectorSpec } from "../types";

type Created = { name: string; key: string; authKey?: string; keyErr?: string };

export default function SourceNew() {
  const nav = useNavigate();
  const [specs, setSpecs] = useState<Record<string, ConnectorSpec>>();
  const [connector, setConnector] = useState<string>();
  const [created, setCreated] = useState<Created>();
  // Host capabilities gate local-only connectors: docker_logs shells out to `docker logs` on the
  // Tares host, so on a hosted cell (no Docker socket) it can only ever ingest nothing.
  // Enabled until known false, matching Sources.tsx.
  const [caps, setCaps] = useState<{ discover_docker: boolean }>();
  // Auth mode. When ON, a push producer needs an ingest credential in the header, so we mint one for
  // the source at creation (show-once). When OFF, the ingest URL alone is enough — no key.
  const [authOn, setAuthOn] = useState(false);

  useEffect(() => {
    api.connectors().then(setSpecs);
    api.capabilities().then(setCaps);
    api.health().then((h) => setAuthOn(h.auth_required)).catch(() => {});
  }, []);

  const unavailable = (key: string) => key === "docker_logs" && caps?.discover_docker === false;

  const spec = specs && connector ? specs[connector] : undefined;

  return (
    <>
      <h1>Add source</h1>
      <p className="subtitle">pick a connector, configure it, save — <em>no restart needed</em></p>

      {!specs && <div className="dim">loading connectors…</div>}

      {specs && !connector && (
        <table>
          <thead><tr><th>connector</th><th>mode</th><th>what it does</th></tr></thead>
          <tbody>
            {/* `internal` connectors are provisioned by Tares itself (the agent findings
                source) — nothing to configure, so they're not offered here. */}
            {Object.entries(specs).filter(([, s]) => !s.internal).map(([key, s]) => (
              unavailable(key) ? (
                <tr key={key} className="dim">
                  <td className="mono">{key}</td>
                  <td><span className="badge starting">unavailable</span></td>
                  <td>{s.description} <em>Needs Docker on the Tares host — not available on this deployment.</em></td>
                </tr>
              ) : (
                <tr key={key} className="clickable"
                    onClick={() => key === "claude_code" ? nav("/sources/claude-code") : setConnector(key)}>
                  <td className="mono">{key}</td>
                  <td><span className={`badge ${s.mode === "push" ? "push" : "ok"}`}>{s.mode}</span></td>
                  <td>{s.description}</td>
                </tr>
              )
            ))}
          </tbody>
        </table>
      )}

      {/* a push source just got created: show its ingest URL right here so it can be pasted into
          the producer (Vercel drain, etc.) without hunting for it */}
      {spec && created && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>✓ <span className="mono">{created.name}</span> created</h2>
          <p className="subtitle">Point your producer at this endpoint:</p>
          <IngestUrl connector={connector!} sourceKey={created.key} authKey={created.authKey} />

          {created.authKey ? (
            <div className="alert ok" style={{ marginTop: 14 }}>
              This instance requires auth, so <span className="mono">{created.name}</span> got its own
              ingest key — send it as <code>Authorization: Bearer …</code>. <strong>Copy it now; it
              is not shown again</strong> (it's listed under <Link to="/security">Security</Link> as{" "}
              <span className="mono">ingest: {created.name}</span>):
              <div className="ingest-url" style={{ marginTop: 8 }}>
                <code className="mono">{created.authKey}</code>
                <CopyText text={created.authKey} />
              </div>
            </div>
          ) : created.keyErr ? (
            <div className="alert error" style={{ marginTop: 14 }}>
              The source was created, but minting its ingest key failed: {created.keyErr}. Create one
              under <Link to="/security">Security</Link> (scope <span className="mono">ingest</span>).
            </div>
          ) : authOn === false ? (
            <p className="help" style={{ marginTop: 14, whiteSpace: "normal" }}>
              This instance is open, so no key is needed — the URL alone accepts events. Run{" "}
              <code>tares up --auth</code> to require an ingest key per producer.
            </p>
          ) : null}

          <div className="btnrow" style={{ marginTop: 16 }}>
            <Link className="btn" to={`/sources/${created.name}`}>Open source</Link>
            <button onClick={() => { setCreated(undefined); setConnector(undefined); }}>Add another</button>
          </div>
        </div>
      )}

      {spec && !created && (
        <div className="panel">
          <div className="pagehead">
            <h2 style={{ marginTop: 0 }}>{spec.label} <span className="dim mono">({connector})</span></h2>
            <button onClick={() => setConnector(undefined)}>change connector</button>
          </div>
          <p className="subtitle">{spec.description}</p>
          <SourceForm
            connector={connector!}
            spec={spec}
            submitLabel="Create source"
            onSubmit={async (body) => {
              const res = await api.createSource(body);
              if (spec.mode !== "push") {
                nav(`/sources/${body.name}`);
                return;
              }
              // Secured instance: mint this producer its own ingest key (show-once). Failure to
              // mint doesn't block — the source exists; surface the reason and let them retry in
              // Security. Open instance: no key needed, just the URL.
              let authKey: string | undefined, keyErr: string | undefined;
              if (authOn) {
                try {
                  const k = await api.createKey(`ingest: ${body.name}`, ["ingest"]);
                  authKey = k.secret;
                } catch (e) { keyErr = String((e as Error).message ?? e); }
              }
              setCreated({ name: body.name, key: res.ingest_key || body.name, authKey, keyErr });
            }}
          />
        </div>
      )}
    </>
  );
}

function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => {
      navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }}>{copied ? "copied" : "copy"}</button>
  );
}

// The full, copyable ingest URL, built from the browser's own origin (correct wherever the console
// is served). OTLP uses the /v1/* endpoints (source chosen by header) rather than a path key.
// `authKey` (present on a secured instance) is the freshly minted ingest key, threaded to the setup
// snippet so it's paste-ready.
function IngestUrl({ connector, sourceKey, authKey }: {
  connector: string; sourceKey: string; authKey?: string;
}) {
  const origin = window.location.origin;
  const url = connector === "otlp" ? `${origin}/v1/logs` : `${origin}/ingest/${sourceKey}`;
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div className="ingest-url">
        <code className="mono">{url}</code>
        <button onClick={() => {
          navigator.clipboard?.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}>{copied ? "copied" : "copy"}</button>
      </div>
      {connector === "otlp"
        ? <p className="muted">Point an OTLP/HTTP exporter here (also <span className="mono">/v1/traces</span>, <span className="mono">/v1/metrics</span>).</p>
        : <p className="muted">It accepts JSON or NDJSON; data flows in as soon as the producer posts.</p>}
      <IngestSetup connector={connector} url={url} authKey={authKey} />
    </>
  );
}

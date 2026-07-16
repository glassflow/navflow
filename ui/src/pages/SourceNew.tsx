import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api } from "../api";
import IngestSetup from "../components/IngestSetup";
import SourceForm from "../components/SourceForm";
import type { ConnectorSpec } from "../types";

export default function SourceNew() {
  const nav = useNavigate();
  const [specs, setSpecs] = useState<Record<string, ConnectorSpec>>();
  const [connector, setConnector] = useState<string>();
  const [created, setCreated] = useState<{ name: string; key: string }>();
  // Host capabilities gate local-only connectors: docker_logs shells out to `docker logs` on the
  // NavFlow host, so on a hosted cell (no Docker socket) it can only ever ingest nothing.
  // Enabled until known false, matching Sources.tsx.
  const [caps, setCaps] = useState<{ discover_docker: boolean }>();

  useEffect(() => { api.connectors().then(setSpecs); api.capabilities().then(setCaps); }, []);

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
            {Object.entries(specs).map(([key, s]) => (
              unavailable(key) ? (
                <tr key={key} className="dim">
                  <td className="mono">{key}</td>
                  <td><span className="badge starting">unavailable</span></td>
                  <td>{s.description} <em>Needs Docker on the NavFlow host — not available on this deployment.</em></td>
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
          <IngestUrl connector={connector!} sourceKey={created.key} />
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
              if (spec.mode === "push") {
                setCreated({ name: body.name, key: res.ingest_key || body.name });
              } else {
                nav(`/sources/${body.name}`);
              }
            }}
          />
        </div>
      )}
    </>
  );
}

// The full, copyable ingest URL, built from the browser's own origin (correct wherever the console
// is served). OTLP uses the /v1/* endpoints (source chosen by header) rather than a path key.
function IngestUrl({ connector, sourceKey }: { connector: string; sourceKey: string }) {
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
      <IngestSetup connector={connector} url={url} />
    </>
  );
}

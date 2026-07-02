import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { api } from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import SourceForm from "../components/SourceForm";
import { StatusBadge, TimeAgo, usePolling } from "../components/bits";
import type { ConnectorSpec, Source } from "../types";

export default function SourceDetail() {
  const { name = "" } = useParams();
  const nav = useNavigate();
  const [specs, setSpecs] = useState<Record<string, ConnectorSpec>>();
  const [editing, setEditing] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [confirmDel, setConfirmDel] = useState(false);
  const [purge, setPurge] = useState(false);

  const { data: source, error, reload } = usePolling(() => api.source(name));
  const { data: events } = usePolling(() => api.sourceEvents(name, 30));

  useEffect(() => { api.connectors().then(setSpecs); }, []);

  if (error) return <div className="alert error">{error}</div>;
  if (!source || !specs) return <div className="dim">loading…</div>;

  const spec = specs[source.connector];
  const h = source.health;

  const act = (fn: () => Promise<unknown>) => async () => {
    setActionError(undefined);
    try { await fn(); reload(); } catch (e) { setActionError(String((e as Error).message ?? e)); }
  };

  return (
    <>
      <div className="pagehead">
        <div>
          <h1><span className="mono">{source.name}</span></h1>
          <p className="subtitle">
            {spec?.label ?? source.connector} · {source.type}
          </p>
        </div>
        <div className="btnrow">
          {source.paused
            ? <button onClick={act(() => api.resumeSource(name))}>Resume</button>
            : <button onClick={act(() => api.pauseSource(name))}>Pause</button>}
          <button onClick={() => setEditing(!editing)}>{editing ? "Close editor" : "Edit config"}</button>
          <button className="danger" onClick={() => { setPurge(false); setConfirmDel(true); }}>Delete</button>
        </div>
      </div>

      {actionError && <div className="alert error">{actionError}</div>}

      {spec?.mode === "push" && <IngestEndpoint source={source} />}

      <div className="cards">
        <div className="card"><div className="k">status</div><div className="v"><StatusBadge status={h?.status} /></div></div>
        <div className="card"><div className="k">events stored</div><div className="v">{(h?.events_total ?? 0).toLocaleString()}</div></div>
        <div className="card"><div className="k">since daemon start</div><div className="v">{h?.events_since_start ?? 0} <small>events / {h?.polls ?? 0} polls</small></div></div>
        <div className="card"><div className="k">last ingest</div><div className="v" style={{ fontSize: 15 }}><TimeAgo ts={h?.last_ingest} /></div></div>
      </div>

      {h?.last_error && (
        <div className="alert error">
          last error ({h.consecutive_errors} consecutive): <span className="mono">{h.last_error}</span>
        </div>
      )}

      <FieldsPanel name={name} primaryField={primaryField(source)} />

      {editing && spec && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Edit config</h2>
          <SourceForm
            connector={source.connector}
            spec={spec}
            lockName
            initial={{ name: source.name, type: source.type, poll: source.poll, config: source.config }}
            submitLabel="Save changes"
            onSubmit={async (body) => {
              await api.updateSource(name, body);
              setEditing(false);
              reload();
            }}
          />
        </div>
      )}

      <h2>Recent events</h2>
      {!events?.length && <div className="empty">nothing ingested from this source yet</div>}
      {!!events?.length && (
        <table>
          <thead><tr><th>ingested</th><th>key</th><th>type</th><th>text</th></tr></thead>
          <tbody>
            {events.map((e, i) => (
              <tr key={i}>
                <td style={{ whiteSpace: "nowrap" }}><TimeAgo ts={e.ingest_time} /></td>
                <td className="mono">{e.key}</td>
                <td className="mono">{e.event_type}</td>
                <td className="mono" style={{ whiteSpace: "pre-wrap" }}>{e.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {confirmDel && (
        <ConfirmDialog
          title={`Delete source "${name}"?`}
          confirmLabel="Delete source"
          danger
          onCancel={() => setConfirmDel(false)}
          onConfirm={async () => {
            setConfirmDel(false);
            setActionError(undefined);
            try { await api.deleteSource(name, purge); nav("/"); }
            catch (e) { setActionError(String((e as Error).message ?? e)); }
          }}
        >
          <p className="help" style={{ whiteSpace: "normal", margin: 0 }}>
            Its configuration is removed. Stored events are kept unless you purge them.
          </p>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
            <span>also purge its stored events{h?.events_total ? ` (${h.events_total.toLocaleString()})` : ""}</span>
          </label>
        </ConfirmDialog>
      )}
    </>
  );
}

function primaryField(source: Source): string | undefined {
  const labels = (source.config?.labels as Array<Record<string, unknown>> | undefined) ?? [];
  const p = labels.find((l) => l.primary);
  return (p?.field as string) ?? undefined;
}

// The connector's normalized fields and how often each is actually present — makes the otherwise
// invisible structure visible, so the key is chosen against real coverage instead of guessed.
function FieldsPanel({ name, primaryField }: { name: string; primaryField?: string }) {
  const { data } = usePolling(() => api.sourceFields(name), 5000);
  if (!data || !data.fields.length) return null;
  const max = Math.max(1, ...data.fields.map((f) => f.coverage));
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Fields <small className="dim">· {data.sampled} events sampled</small></h2>
      <p className="subtitle">The normalized fields you can key/label on, and how present each is. Prefer a well-covered field for the key.</p>
      <table>
        <thead><tr><th>field</th><th style={{ width: 200 }}>coverage</th><th>distinct</th><th>top values</th></tr></thead>
        <tbody>
          {data.fields.map((f) => (
            <tr key={f.name}>
              <td className="mono">
                {f.name}
                {f.name === primaryField && <span className="badge ok" style={{ marginLeft: 6 }}>key</span>}
              </td>
              <td>
                <div className="cov"><div className="cov-bar" style={{ width: `${(f.coverage / max) * 100}%` }} /></div>
                <small className="dim">{f.coverage} / {data.sampled}</small>
              </td>
              <td>{f.distinct}</td>
              <td className="help" style={{ whiteSpace: "normal" }}>
                {f.values.slice(0, 5).map((v) => `${v.value} (${v.events})`).join(", ") || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CopyableUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ingest-url">
      <code className="mono">{url}</code>
      <button onClick={() => {
        navigator.clipboard?.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}>{copied ? "copied" : "copy"}</button>
    </div>
  );
}

// The full, copyable ingest URL — built from the browser's own origin, so it's correct wherever the
// console is served. OTLP uses the /v1/* endpoints (source chosen by header) instead of a path key.
function IngestEndpoint({ source }: { source: Source }) {
  const origin = window.location.origin;
  if (source.connector === "otlp") {
    return (
      <div className="card ingest-card">
        <div className="k">OTLP endpoint</div>
        <CopyableUrl url={`${origin}/v1/logs`} />
        <p className="muted">Point an OTLP/HTTP exporter here (also <span className="mono">/v1/traces</span>, <span className="mono">/v1/metrics</span>).</p>
      </div>
    );
  }
  return (
    <div className="card ingest-card">
      <div className="k">ingest endpoint · POST</div>
      <CopyableUrl url={`${origin}/ingest/${source.ingest_key || source.name}`} />
      <p className="muted">Point your producer (e.g. a Vercel log drain) at this URL.</p>
    </div>
  );
}

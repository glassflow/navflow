import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { api } from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import IngestSetup from "../components/IngestSetup";
import SourceForm from "../components/SourceForm";
import { ErrorState, StatusBadge, TimeAgo, usePolling } from "../components/bits";
import type { ConnectorSpec, Source } from "../types";

export default function SourceDetail() {
  const { name = "" } = useParams();
  const nav = useNavigate();
  const [specs, setSpecs] = useState<Record<string, ConnectorSpec>>();
  const [tab, setTab] = useState<"fields" | "events" | "config">("fields");
  const [actionError, setActionError] = useState<string>();
  const [confirmDel, setConfirmDel] = useState(false);
  const [purge, setPurge] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);

  // Editing labels opens the Configuration tab, which renders below the fold — scroll to it so it's
  // obvious something opened (otherwise the page looks unchanged).
  const openConfig = () => {
    setTab("config");
    requestAnimationFrame(() =>
      tabsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const { data: source, error, reload } = usePolling(() => api.source(name));
  const { data: events, error: eventsError } = usePolling(() => api.sourceEvents(name, 30));

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
            {spec?.label ?? source.connector}
          </p>
        </div>
        <div className="btnrow">
          {source.paused
            ? <button onClick={act(() => api.resumeSource(name))}>Resume</button>
            : <button onClick={act(() => api.pauseSource(name))}>Pause</button>}
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

      <LabelsSummary source={source} onEdit={openConfig} />

      <div className="tabs" style={{ marginTop: 16, scrollMarginTop: 60 }} ref={tabsRef}>
        <button className={tab === "fields" ? "active" : ""} onClick={() => setTab("fields")}>Fields</button>
        <button className={tab === "events" ? "active" : ""} onClick={() => setTab("events")}>Recent events</button>
        <button className={tab === "config" ? "active" : ""} onClick={() => setTab("config")}>Configuration</button>
      </div>

      {tab === "fields" && <FieldsPanel name={name} />}

      {tab === "config" && spec && (
        <div className="panel">
          <SourceForm
            connector={source.connector}
            spec={spec}
            lockName
            initial={{ name: source.name, type: source.type, poll: source.poll, config: source.config }}
            submitLabel="Save changes"
            onSubmit={async (body) => {
              await api.updateSource(name, body);
              setTab("fields");
              reload();
            }}
          />
        </div>
      )}

      {tab === "events" && (
        <>
          {eventsError && <ErrorState error={eventsError} what="recent events" />}
          {!eventsError && !events?.length && <div className="empty">nothing ingested from this source yet</div>}
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
        </>
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
            try { await api.deleteSource(name, purge); nav("/sources"); }
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

// The fields this source carries, sampled from recent events. Nested contexts (e.g. a Prometheus
// label set) are flattened to sub-fields (metric.service, …) so the real keyable axes are visible;
// the backend marks which are declared labels/keys. Coverage is only shown when it varies (a full
// 100%-everywhere column is noise), so partial fields stand out.
// The declared entity axes — the single most important config of a source, so it lives on the
// main screen (not buried in the edit form): every event carries these labels, the key names
// the timeline agents read.
function LabelsSummary({ source, onEdit }: { source: Source; onEdit: () => void }) {
  const labels = (source.config?.labels ?? []) as Array<{
    name: string; field?: string; const?: string; primary?: boolean }>;
  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="pagehead" style={{ marginBottom: labels.length ? 8 : 0 }}>
        <h2 style={{ margin: 0 }}>Labels &amp; key</h2>
        <button onClick={onEdit}>Edit</button>
      </div>
      {labels.length ? (
        <table>
          <thead><tr><th>label</th><th>from</th></tr></thead>
          <tbody>
            {labels.map((l) => (
              <tr key={l.name}>
                <td className="mono">
                  {l.name}
                  {l.primary && <span className="badge ok" style={{ marginLeft: 8 }}>key</span>}
                </td>
                <td className="mono">
                  {"field" in l && l.field
                    ? <><span className="badge push" style={{ marginRight: 8 }}>field</span>{l.field}</>
                    : <><span className="badge push" style={{ marginRight: 8 }}>const</span>{String(l.const ?? "")}</>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="help" style={{ margin: 0, whiteSpace: "normal" }}>
          No labels declared — events fall back to the connector&rsquo;s default key, and agents
          can&rsquo;t slice this source by any axis. Check <strong>Fields</strong> below for the
          candidates observed in your data, then declare them here.
        </p>
      )}
    </div>
  );
}

const FIELDS_PAGE = 12;

function FieldsPanel({ name }: { name: string }) {
  const { data } = usePolling(() => api.sourceFields(name), 5000);
  const [showAll, setShowAll] = useState(false);
  if (!data || !data.fields.length) return null;
  const allFull = data.fields.every((f) => f.coverage === data.sampled);
  const fmt = (v: string) => (v.length > 44 ? v.slice(0, 43) + "…" : v);
  // keys and labels lead, then by how many events actually carry the field — the most
  // promotable candidates come first, long tails of sparse fields fold behind "show all"
  const sorted = [...data.fields].sort((a, b) =>
    (a.is_key ? 0 : a.is_label ? 1 : 2) - (b.is_key ? 0 : b.is_label ? 1 : 2)
    || b.coverage - a.coverage || a.name.localeCompare(b.name));
  const shown = showAll ? sorted : sorted.slice(0, FIELDS_PAGE);
  const labels = data.labels ?? [];
  const allLabelsFull = labels.every((l) => l.coverage === data.sampled);
  return (
    <>
    {labels.length > 0 && (
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Labels <small className="dim">· {data.sampled} events sampled</small></h2>
        <p className="subtitle">
          The curated axes you read and alert by — each label with its coverage and top values,
          including derived ones (regex / const / map over a raw field). <span className="badge ok">key</span>{" "}
          is the primary; <strong>0 coverage</strong> means the extraction matched nothing (e.g. a bad field or regex).
        </p>
        <table>
          <thead><tr>
            <th>label</th>
            {!allLabelsFull && <th style={{ width: 180 }}>coverage</th>}
            <th className="num">distinct</th>
            <th>top values</th>
          </tr></thead>
          <tbody>
            {labels.map((l) => (
              <tr key={l.name} style={l.coverage === 0 ? { opacity: 0.55 } : undefined}>
                <td className="mono">
                  {l.name}
                  {l.is_key ? <span className="badge ok" style={{ marginLeft: 6 }}>key</span>
                    : <span className="badge starting" style={{ marginLeft: 6 }}>label</span>}
                  {l.coverage === 0 && (
                    <div className="help" style={{ fontFamily: "inherit" }}>
                      no sampled event carries this label — check the field mapping / regex
                    </div>
                  )}
                </td>
                {!allLabelsFull && (
                  <td>
                    <div className="cov"><div className="cov-bar" style={{ width: `${(l.coverage / Math.max(1, data.sampled)) * 100}%` }} /></div>
                    <small className="dim">{l.coverage} / {data.sampled}</small>
                  </td>
                )}
                <td className="num">{l.distinct}</td>
                <td>
                  {l.values.length
                    ? <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                        {l.values.slice(0, 6).map((v) => (
                          <span className="chip" key={v.value} title={`${v.value} · ${v.events} events`}>
                            {fmt(v.value)} <span className="dim">({v.events})</span>
                          </span>
                        ))}
                      </span>
                    : <span className="help">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Fields <small className="dim">· {data.sampled} events sampled</small></h2>
      <p className="subtitle">
        The axes this connector can label events by, profiled from recent events (the full raw
        payload is always stored regardless). <span className="badge ok">key</span> and{" "}
        <span className="badge starting">label</span> mark what you read and alert by today; the
        rest can be promoted to a label in <strong>Configuration</strong>.
      </p>
      <table>
        <thead><tr>
          <th>field</th>
          {!allFull && <th style={{ width: 180 }}>coverage</th>}
          <th className="num">distinct</th>
          <th>top values</th>
        </tr></thead>
        <tbody>
          {shown.map((f) => (
            <tr key={f.name} style={f.coverage === 0 ? { opacity: 0.55 } : undefined}>
              <td className="mono">
                {f.name}
                {f.is_key ? <span className="badge ok" style={{ marginLeft: 6 }}>key</span>
                  : f.is_label ? <span className="badge starting" style={{ marginLeft: 6 }}>label</span> : null}
                {f.coverage === 0 && (
                  <div className="help" style={{ fontFamily: "inherit" }}>
                    not observed in the sample{(f.is_key || f.is_label)
                      ? " — declared as a label but no event carries it; check the field mapping"
                      : ""}
                  </div>
                )}
              </td>
              {!allFull && (
                <td>
                  <div className="cov"><div className="cov-bar" style={{ width: `${(f.coverage / Math.max(1, data.sampled)) * 100}%` }} /></div>
                  <small className="dim">{f.coverage} / {data.sampled}</small>
                </td>
              )}
              <td className="num">{f.distinct}</td>
              <td>
                {f.values.length
                  ? <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                      {f.values.slice(0, 6).map((v) => (
                        <span className="chip" key={v.value} title={`${v.value} · ${v.events} events`}>
                          {fmt(v.value)} <span className="dim">({v.events})</span>
                        </span>
                      ))}
                    </span>
                  : <span className="help">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length > FIELDS_PAGE && (
        <button style={{ marginTop: 10 }} onClick={() => setShowAll((s) => !s)}>
          {showAll ? "show fewer" : `show all ${sorted.length} fields`}
        </button>
      )}
      {allFull && <p className="help" style={{ marginTop: 8 }}>Every field is present in all {data.sampled} sampled events.</p>}
    </div>
    </>
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
// console is served. The URL is an address (always shown here); on a secured instance IngestSetup
// adds the auth-key guidance. OTLP uses the /v1/* endpoints (source chosen by header), no path key.
function IngestEndpoint({ source }: { source: Source }) {
  const origin = window.location.origin;
  if (source.connector === "otlp") {
    return (
      <div className="card ingest-card">
        <div className="k">OTLP endpoint</div>
        <CopyableUrl url={`${origin}/v1/logs`} />
        <p className="muted">Point an OTLP/HTTP exporter here (also <span className="mono">/v1/traces</span>, <span className="mono">/v1/metrics</span>).</p>
        <IngestSetup connector="otlp" url={`${origin}/v1/logs`} />
      </div>
    );
  }
  const url = `${origin}/ingest/${source.ingest_key || source.name}`;
  return (
    <div className="card ingest-card">
      <div className="k">ingest endpoint · POST</div>
      <CopyableUrl url={url} />
      <p className="muted">Point your producer (e.g. a Vercel log drain) at this URL.</p>
      <IngestSetup connector={source.connector} url={url} />
    </div>
  );
}

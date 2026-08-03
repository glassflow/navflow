import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api } from "../api";
import { Search, Settings as SettingsIco } from "../components/icons";
import { ErrorState, StatusBadge, TimeAgo, formatBytes, usePolling } from "../components/bits";

// Gear dropdown next to "Add source" — catalog import/export, each on its own page.
function CatalogMenu() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button className="btn" onClick={() => setOpen((o) => !o)} title="Import / export catalog"
              aria-label="Catalog menu" aria-haspopup="menu" aria-expanded={open}>
        <SettingsIco className="ico" />
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 20 }} />
          <div className="menu-pop" role="menu"
               style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 21 }}>
            <Link className="menu-item" role="menuitem" to="/sources/export" onClick={() => setOpen(false)}>Export catalog</Link>
            <Link className="menu-item" role="menuitem" to="/sources/import" onClick={() => setOpen(false)}>Import catalog</Link>
          </div>
        </>
      )}
    </div>
  );
}

// The console's answer to "how full is my database?" — asked *before* it breaks, not after.
// Which story you get depends on whether an operator configured a cap (NAVFLOW_MAX_DB_SIZE; the
// Helm chart sets it for hosted cells, a self-hosted install usually has not):
//   · cap set  → the percentage of it, a bar, and a warning from 80% up. The daemon only flips
//                /health to `degraded` at NAVFLOW_DEGRADED_PCT (90 by default); the console warns
//                earlier, while there is still room to act.
//   · no cap   → no percentage and no bar, because there is no denominator to measure against.
//                Absolute size, with headroom taken from the free space on the volume instead.
// pct_used is on a 0-100 scale, so the threshold is 80, not 0.8. Per-source bytes are deliberately
// absent: DuckDB keeps every source in one events table and cannot attribute storage per source.
function StoragePanel() {
  const { data: u, error, reload } = usePolling(() => api.usage(), 30000);
  const onDisk = u ? u.db_bytes + u.wal_bytes : 0;
  // Both null together, but check the denominator: it is what makes a percentage meaningful.
  const pct = u && u.max_bytes != null && u.pct_used != null ? u.pct_used : null;

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Storage</h2>
      <p className="help" style={{ marginTop: 0 }}>
        What this instance is using on disk — the DuckDB file plus its write-ahead log. Nothing is
        pruned today, so agent runs and dispatch deliveries grow with every firing.
      </p>

      {error && <ErrorState error={error} what="storage usage" onRetry={reload} />}
      {!u && !error && <div className="muted">loading…</div>}

      {u && (
        <>
          {pct !== null && pct >= 80 && (
            <div className="alert warn">
              <strong>Storage {pct}% full</strong> — {formatBytes(onDisk)} of the{" "}
              {formatBytes(u.max_bytes)} limit for this instance. Ingest keeps working until it
              runs out; free space or raise <code>NAVFLOW_MAX_DB_SIZE</code> before it does.
            </div>
          )}

          <div className="cards" style={{ marginBottom: 12 }}>
            <div className="card">
              <div className="k">on disk</div>
              <div className="v">
                {formatBytes(onDisk)}{" "}
                {/* the denominator is spelled out under the bar; the card just glances */}
                {pct !== null && <small>{pct}%</small>}
              </div>
            </div>
            <div className="card"><div className="k">events</div><div className="v">{u.events.toLocaleString()}</div></div>
            <div className="card"><div className="k">agent runs</div><div className="v">{u.agent_runs.toLocaleString()}</div></div>
            <div className="card"><div className="k">dispatch deliveries</div><div className="v">{u.dispatch_deliveries.toLocaleString()}</div></div>
          </div>

          {pct !== null ? (
            <>
              <div className="usage-bar" aria-hidden="true">
                <span className={pct >= 80 ? "hot" : undefined}
                      style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
              </div>
              <p className="help" style={{ marginBottom: 0 }}>
                {formatBytes(onDisk)} of {formatBytes(u.max_bytes)} used
                {u.disk_free != null && <> · {formatBytes(u.disk_free)} free on the volume</>}
              </p>
            </>
          ) : (
            // No cap configured: no percentage, no bar — there is nothing to be a percentage of.
            <p className="help" style={{ marginBottom: 0 }}>
              No size limit is configured for this instance, so there is no percentage to show.{" "}
              {u.disk_free != null
                ? <>The volume it sits on has <strong>{formatBytes(u.disk_free)}</strong> free
                   {u.disk_total != null && <> of {formatBytes(u.disk_total)}</>}.</>
                : <>Free space on its volume could not be read.</>}{" "}
              Set <code>NAVFLOW_MAX_DB_SIZE</code> to be warned against a budget instead.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default function Sources() {
  const nav = useNavigate();
  const { data: sources, error } = usePolling(() => api.sources());
  // Host capabilities gate local-only actions: hide Auto-discover where Docker isn't reachable
  // (a hosted cell, or a local box without Docker). Shown until known false.
  const { data: caps } = usePolling(() => api.capabilities());

  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");

  const total = sources?.reduce((n, s) => n + (s.health?.events_total ?? 0), 0) ?? 0;
  const erroring = sources?.filter((s) => s.health?.status === "error").length ?? 0;

  const statuses = useMemo(
    () => Array.from(new Set((sources ?? []).map((s) => s.health?.status ?? "starting"))).sort(),
    [sources],
  );

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (sources ?? []).filter((s) => {
      const st = s.health?.status ?? "starting";
      return (status === "all" || st === status) &&
        (!needle || s.name.toLowerCase().includes(needle) || s.connector.toLowerCase().includes(needle));
    });
  }, [sources, q, status]);

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Sources</h1>
          <p className="subtitle">everything NavFlow ingests — <em>lossless, normalized, one project</em></p>
        </div>
        <span className="btnrow">
          {caps?.discover_docker !== false && (
            <Link to="/sources/discover" className="btn">✦ Auto-discover</Link>
          )}
          <Link to="/sources/new" className="btn primary">Add source</Link>
          <CatalogMenu />
        </span>
      </div>

      {error && <div className="alert error">daemon unreachable: {error}</div>}

      {sources && (
        <div className="cards">
          <div className="card"><div className="k">sources</div><div className="v">{sources.length}</div></div>
          <div className="card"><div className="k">events stored</div><div className="v">{total.toLocaleString()}</div></div>
          <div className="card"><div className="k">erroring</div><div className="v" style={erroring ? { color: "var(--err)" } : {}}>{erroring}</div></div>
        </div>
      )}

      {sources && sources.length === 0 && (
        <div className="empty">
          No sources yet — <Link to="/sources/new">add one by hand</Link> or <Link to="/sources/import">import a catalog YAML</Link>
          {caps?.discover_docker !== false && (
            <>, or <Link to="/sources/discover">auto-discover from Docker</Link></>
          )}.
        </div>
      )}

      {sources && sources.length > 0 && (
        <>
          <div className="toolbar">
            <div className="search-box">
              <Search />
              <input
                type="text"
                className="search"
                placeholder="Filter sources…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">All statuses</option>
              {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <span className="grow" />
            <span className="count">{shown.length} of {sources.length}</span>
          </div>

          <table>
            <thead>
              <tr>
                <th>name</th><th>connector</th><th>status</th><th>poll</th>
                <th className="num">events</th><th>last ingest</th><th>last error</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.name} className="clickable" onClick={() => nav(`/sources/${s.name}`)}>
                  <td className="mono">{s.name}</td>
                  <td>{s.connector}</td>
                  <td><StatusBadge status={s.health?.status} /></td>
                  <td className="mono">{s.health?.status === "push" ? <span className="dim">push</span> : s.poll}</td>
                  <td className="num">{(s.health?.events_total ?? 0).toLocaleString()}</td>
                  <td><TimeAgo ts={s.health?.last_ingest} /></td>
                  <td className="mono" style={{ maxWidth: 260, color: "var(--err)" }}>
                    {s.health?.last_error ? s.health.last_error.slice(0, 80) : <span className="dim">—</span>}
                  </td>
                </tr>
              ))}
              {!shown.length && (
                <tr><td colSpan={7} className="dim" style={{ textAlign: "center", padding: 24 }}>
                  no sources match the current filter
                </td></tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {/* Instance state, under the roster it explains: the sources above are what fills it. */}
      <StoragePanel />
    </>
  );
}

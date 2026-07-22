import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api } from "../api";
import { Search, Settings as SettingsIco } from "../components/icons";
import { StatusBadge, TimeAgo, usePolling } from "../components/bits";

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
    </>
  );
}

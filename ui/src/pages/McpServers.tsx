import { useMemo, useState } from "react";

import { api } from "../api";
import { TimeAgo, usePolling } from "../components/bits";

// The MCP connections registry: external tool servers a Tares agent can opt into. This page owns
// the connection (URL + credential, entered once); which agent uses which server is chosen on the
// agent's own form. HTTP transport only — stdio would mean the daemon spawning arbitrary
// commands, which is off the table on a hosted cell and a footgun anywhere.

type Server = { name: string; url: string; auth_header: string;
                auth_value_configured: boolean; updated_at: string };
type Tool = { name: string; description: string };

function ServerForm({ initial, onSaved, onCancel }: {
  initial?: Server; onSaved: () => void; onCancel: () => void;
}) {
  const isNew = !initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [header, setHeader] = useState(initial?.auth_header ?? "");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const save = async () => {
    setBusy(true); setErr(undefined);
    const body = { name: name.trim(), url: url.trim(),
                   auth_header: header.trim(), auth_value: value };
    try {
      if (isNew) await api.createMcpServer(body);
      else await api.updateMcpServer(initial!.name, body);
      onSaved();
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    setBusy(false);
  };

  return (
    <div className="panel">
      {err && <div className="alert error">{err}</div>}
      <div className="row2">
        <label className="field">
          <span className="lbl">name</span>
          <input type="text" value={name} placeholder="e.g. github" disabled={!isNew}
                 onChange={(e) => setName(e.target.value)} />
          {!isNew && <span className="help">fixed; delete and recreate to rename</span>}
        </label>
        <label className="field">
          <span className="lbl">url</span>
          <input type="text" className="mono" value={url}
                 placeholder="https://mcp.example.com/mcp"
                 onChange={(e) => setUrl(e.target.value)} />
          <span className="help">stdio servers are not supported</span>
        </label>
      </div>
      <div className="field">
        <span className="lbl">authentication <span className="help">(optional)</span></span>
        <div className="hook-group">
          <input type="text" className="mono" placeholder="header name (default: Authorization)"
                 value={header} onChange={(e) => setHeader(e.target.value)} />
          <input type="password" className="mono" autoComplete="new-password" placeholder={
            initial?.auth_value_configured
              ? "•••• configured, leave blank to keep"
              : "header value, e.g. Bearer sk-…"}
                 value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        <span className="help">stored as a secret, never shown again</span>
      </div>
      <div className="btnrow">
        <button className="primary" onClick={save}
                disabled={busy || !name.trim() || !url.trim()}>
          {isNew ? "Add server" : "Save changes"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export default function McpServers() {
  const { data, error, reload } = usePolling(() => api.mcpServers(), 30000);
  const [editing, setEditing] = useState<Server | "new">();
  const [tests, setTests] = useState<Record<string, { busy?: boolean; ok?: boolean;
                                                     error?: string; tools?: Tool[] }>>({});
  const [open, setOpen] = useState<string>();

  const servers = useMemo(() => data?.servers ?? [], [data]);

  const test = async (name: string) => {
    setTests((t) => ({ ...t, [name]: { busy: true } }));
    setOpen(name);
    try {
      const r = await api.testMcpServer(name);
      setTests((t) => ({ ...t, [name]: { ok: r.ok, error: r.error, tools: r.tools } }));
    } catch (e) {
      setTests((t) => ({ ...t, [name]: { ok: false, error: String((e as Error).message ?? e) } }));
    }
  };

  const remove = async (name: string) => {
    try { await api.deleteMcpServer(name); reload(); }
    catch { /* the next poll shows the truth */ }
  };

  return (
    <>
      <h1>MCP servers</h1>
      <p className="subtitle">
        external MCP servers, connected once; pick them per <em>Tares agent</em> to give it those tools
      </p>

      {error && <div className="alert error">{error}</div>}

      {editing !== undefined ? (
        <ServerForm initial={editing === "new" ? undefined : editing}
                    onSaved={() => { setEditing(undefined); reload(); }}
                    onCancel={() => setEditing(undefined)} />
      ) : (
        <div className="btnrow" style={{ marginBottom: 12 }}>
          <button className="primary" onClick={() => setEditing("new")}>Add server</button>
        </div>
      )}

      {!data ? <div className="dim">loading…</div>
        : servers.length === 0 ? (
          <div className="empty">
            no servers yet. Add one, then pick it on an agent's form to give that agent its tools.
          </div>
        ) : (
          <table>
            <thead><tr><th>name</th><th>url</th><th>auth</th><th>updated</th><th aria-label="actions" /></tr></thead>
            <tbody>
              {servers.map((s) => {
                const t = tests[s.name];
                return (
                  <>
                    <tr key={s.name}>
                      <td className="mono"><strong>{s.name}</strong></td>
                      <td className="mono">{s.url}</td>
                      <td>{s.auth_value_configured
                        ? <span className="badge ok">{s.auth_header || "Authorization"}</span>
                        : <span className="dim">none</span>}</td>
                      <td style={{ whiteSpace: "nowrap" }}><TimeAgo ts={s.updated_at} /></td>
                      <td>
                        <div className="btnrow" style={{ justifyContent: "flex-end" }}>
                          <button onClick={() => test(s.name)} disabled={t?.busy}>
                            {t?.busy ? "testing…" : "Test"}
                          </button>
                          <button onClick={() => setEditing(s)}>Edit</button>
                          <button className="danger" onClick={() => remove(s.name)}>Delete</button>
                        </div>
                      </td>
                    </tr>
                    {open === s.name && t && !t.busy && (
                      <tr key={s.name + "-test"}>
                        <td colSpan={5} style={{ background: "var(--wash)" }}>
                          {t.ok ? (
                            <div style={{ padding: "6px 4px" }}>
                              <span className="badge ok">connected</span>{" "}
                              <span className="help">{t.tools?.length ?? 0} tools</span>
                              <ul style={{ margin: "6px 0 2px", paddingLeft: 22 }}>
                                {(t.tools ?? []).map((tool) => (
                                  <li key={tool.name}>
                                    <span className="mono">{tool.name}</span>
                                    {tool.description && (
                                      <span className="help"> {tool.description.slice(0, 140)}</span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : (
                            <div style={{ padding: "6px 4px" }}>
                              <span className="badge error">failed</span>{" "}
                              <span className="help mono">{t.error}</span>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        )}
    </>
  );
}

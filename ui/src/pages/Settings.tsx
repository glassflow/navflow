import { useState } from "react";

import { api } from "../api";

// Catalog YAML export/import — the portable form of the daemon's catalog (git it, seed deployments).
export default function Settings() {
  const [exported, setExported] = useState<string>();
  const [importText, setImportText] = useState("");
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();

  const doExport = async () => setExported(await api.exportYaml());

  const doImport = async () => {
    setMsg(undefined);
    try {
      const r = await api.importYaml(importText, mode);
      setMsg({ ok: true, text: `imported ${r.sources} sources, ${r.views} views, ${r.triggers} triggers (${mode})` });
      setImportText("");
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message ?? e) });
    }
  };

  return (
    <>
      <h1>Settings</h1>
      <p className="subtitle">
        catalog as YAML — its <em>portable form</em> (git it, share it, seed new deployments)
      </p>

      <div className="panel">
        <div className="pagehead">
          <h2 style={{ margin: 0 }}>Export catalog</h2>
          <button onClick={doExport}>Export current catalog</button>
        </div>
        {exported && <pre className="payload">{exported}</pre>}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Import catalog</h2>
        {msg && <div className={`alert ${msg.ok ? "ok" : "error"}`}>{msg.text}</div>}
        <label className="field">
          <span className="lbl">catalog YAML</span>
          <textarea className="code" style={{ minHeight: 200 }} value={importText}
                    placeholder={"sources:\n  - name: ...\nviews:\n  - name: ...\ntriggers:\n  - name: ..."}
                    onChange={(e) => setImportText(e.target.value)} />
          <span className="help">validated as a whole before anything is written</span>
        </label>
        <div className="btnrow">
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <input type="radio" checked={mode === "merge"} onChange={() => setMode("merge")} />
            merge (upsert into current catalog)
          </label>
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <input type="radio" checked={mode === "replace"} onChange={() => setMode("replace")} />
            replace (clear catalog first)
          </label>
          <button className="primary" onClick={doImport} disabled={!importText.trim()}>Import</button>
        </div>
      </div>
    </>
  );
}

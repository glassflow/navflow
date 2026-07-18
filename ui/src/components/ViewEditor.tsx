import { useEffect, useState } from "react";

import { api } from "../api";
import { Combo } from "./bits";
import type { View, ViewFilter } from "../types";

// The one view editor, used in place: on /views/new (create) and on /views/<name> (edit).
// Sources are picked one at a time — chips above, an add-picker below — so the control scales
// with any number of sources instead of a wall of checkboxes.

const NUMERIC_OPS = new Set(["gt", "lt", "gte", "lte"]);

export default function ViewEditor({ initial, sourceNames, onSaved, onCancel }: {
  initial?: View;                     // absent = create
  sourceNames: string[];
  onSaved: (name: string) => void;
  onCancel: () => void;
}) {
  const isNew = !initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [keyField, setKeyField] = useState(initial?.key_field ?? "");
  const [sources, setSources] = useState<string[]>(initial?.sources ?? []);
  const [pick, setPick] = useState("");
  const [fRows, setFRows] = useState(
    (initial?.filters ?? []).map((f) => ({ field: f.field, op: f.op as string, value: String(f.value) })));
  const [labelOpts, setLabelOpts] = useState<string[]>([]);
  const [fieldOpts, setFieldOpts] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // suggest real field/label names from the selected sources
  useEffect(() => {
    if (!sources.length) { setLabelOpts([]); setFieldOpts([]); return; }
    let live = true;
    Promise.all(sources.map((s) => api.sourceFields(s).catch(() => null))).then((profiles) => {
      if (!live) return;
      const labels = new Set<string>();
      const names = new Set<string>();
      for (const p of profiles) for (const f of p?.fields ?? []) {
        names.add(f.name);
        if (f.is_label || f.is_key) labels.add(f.name);
      }
      setLabelOpts(Array.from(labels.size ? labels : names).sort());
      setFieldOpts(Array.from(names).sort());
    });
    return () => { live = false; };
  }, [sources.join("|")]);

  const addSource = (s: string) => {
    if (sourceNames.includes(s) && !sources.includes(s)) setSources([...sources, s]);
    setPick("");
  };
  const remaining = sourceNames.filter((s) => !sources.includes(s));

  const save = async () => {
    setBusy(true);
    setError(undefined);
    const filters: ViewFilter[] = fRows.filter((r) => r.field.trim())
      .map((r) => ({ field: r.field.trim(), op: r.op as ViewFilter["op"],
                     value: NUMERIC_OPS.has(r.op) ? Number(r.value) : r.value }));
    const body: View = { name: name.trim(), key_field: keyField.trim(), sources, filters };
    try {
      if (isNew) await api.createView(body);
      else await api.updateView(initial!.name, body);
      onSaved(body.name);
    } catch (e) { setError(String((e as Error).message ?? e)); }
    setBusy(false);
  };

  return (
    <div className="panel">
      {error && <div className="alert error">{error}</div>}

      <label className="field" style={{ maxWidth: 340 }}>
        <span className="lbl">name</span>
        <input type="text" value={name} disabled={!isNew} placeholder="e.g. service_timeline"
               onChange={(e) => setName(e.target.value)} />
        <span className="help">agents query it by this name</span>
      </label>

      <div className="field">
        <span className="lbl">sources to correlate</span>
        <span className="help" style={{ display: "block", marginTop: 0, marginBottom: 6 }}>
          events from every selected source merge into one time-ordered timeline
        </span>
        {sources.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            {sources.map((s) => (
              <span className="chip mono" key={s} style={{ paddingRight: 4 }}>
                {s}{" "}
                <button type="button" onClick={() => setSources(sources.filter((x) => x !== s))}
                        style={{ border: "none", background: "none", padding: "0 2px", cursor: "pointer",
                                 color: "var(--err)" }}
                        title={`remove ${s}`}>×</button>
              </span>
            ))}
          </div>
        )}
        {remaining.length > 0 ? (
          <Combo style={{ maxWidth: 340 }} value={pick} options={remaining}
                 placeholder={sources.length ? "add another source…" : "add a source…"}
                 onChange={(v) => (remaining.includes(v) ? addSource(v) : setPick(v))} />
        ) : sourceNames.length === 0 ? (
          <span className="help">no sources yet — add one under Sources first</span>
        ) : (
          <span className="help">all sources selected</span>
        )}
      </div>

      <div className="field" style={{ marginTop: 14 }}>
        <span className="lbl">key field</span>
        <span className="help" style={{ display: "block", marginTop: 0, marginBottom: 6 }}>
          the label agents look an entity up by — pick one the selected sources share
        </span>
        <Combo value={keyField} options={labelOpts} style={{ maxWidth: 340 }}
               placeholder={labelOpts.length ? `e.g. ${labelOpts[0]}` : "e.g. service"}
               onChange={setKeyField} />
        {labelOpts.length > 0 && (
          <div style={{ marginTop: 6 }}>
            {labelOpts.map((f) => (
              <button key={f} type="button" className="chip"
                      style={{ cursor: "pointer", marginRight: 6,
                               outline: keyField === f ? "2px solid var(--accent)" : undefined }}
                      onClick={() => setKeyField(f)}>
                {f}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="field">
        <span className="lbl">filters (optional)</span>
        <span className="help" style={{ display: "block", marginTop: 0, marginBottom: 6 }}>
          narrow what the view returns — applied on reads and trigger evaluation
        </span>
        {fRows.map((r, i) => (
          <div key={i} className="btnrow" style={{ marginBottom: 6, alignItems: "center" }}>
            <Combo value={r.field} options={fieldOpts} placeholder="field"
                   style={{ maxWidth: 200, flex: 1 }}
                   onChange={(v) => setFRows(fRows.map((x, j) => j === i ? { ...x, field: v } : x))} />
            <select value={r.op} style={{ maxWidth: 130 }}
                    onChange={(e) => setFRows(fRows.map((x, j) => j === i ? { ...x, op: e.target.value } : x))}>
              {["eq", "neq", "contains", "gt", "lt", "gte", "lte"].map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <input type="text" className="mono" style={{ maxWidth: 180 }} placeholder="value" value={r.value}
                   onChange={(e) => setFRows(fRows.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
            <button type="button" className="danger" onClick={() => setFRows(fRows.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <button type="button" onClick={() => setFRows([...fRows, { field: "", op: "eq", value: "" }])}>
          + Add filter
        </button>
      </div>

      <div className="btnrow">
        <button className="primary" onClick={save}
                disabled={busy || !name.trim() || !keyField.trim() || !sources.length}>
          {isNew ? "Create view" : "Save changes"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

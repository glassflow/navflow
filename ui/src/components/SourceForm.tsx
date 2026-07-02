import { useMemo, useState } from "react";

import { api } from "../api";
import type { ConnectorField, ConnectorSpec, DiscoverProposal, EnvScan, TestResult } from "../types";

// Structured push connectors know their entity shape, so a fresh source starts with sensible
// label axes (the user can still edit/remove them).
const DEFAULT_LABELS: Record<string, Array<Record<string, unknown>>> = {
  vercel: [{ name: "project", field: "project", primary: true },
           { name: "environment", field: "environment" }, { name: "source", field: "source" }],
  otlp: [{ name: "service", field: "service.name", primary: true }],
};

interface Props {
  connector: string;
  spec: ConnectorSpec;
  initial?: { name: string; type: string; poll: string; config: Record<string, unknown> };
  lockName?: boolean;
  submitLabel: string;
  onSubmit: (body: {
    name: string; type: string; connector: string; poll: string; config: Record<string, unknown>;
  }) => Promise<void>;
}

/** Form generated from the connector's spec (GET /api/connectors). string/number fields render
 *  as inputs, json fields as a code textarea. Test runs one poll server-side before saving. */
export default function SourceForm({ connector, spec, initial, lockName, submitLabel, onSubmit }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const type = initial?.type ?? "event_stream";  // ignored by the daemon; derived from connector
  const [poll, setPoll] = useState(initial?.poll ?? "5s");
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const f of spec.fields) {
      if (f.type === "list") continue;   // list fields use `rows`, below
      const cur = initial?.config?.[f.name];
      if (cur === undefined || cur === null) v[f.name] = "";
      else if (f.type === "json") v[f.name] = JSON.stringify(cur, null, 2);
      else v[f.name] = String(cur);
    }
    return v;
  });
  const [rows, setRows] = useState<Record<string, Array<Record<string, string>>>>(() => {
    const r: Record<string, Array<Record<string, string>>> = {};
    for (const f of spec.fields) {
      if (f.type !== "list") continue;
      const cur = initial?.config?.[f.name];
      r[f.name] = Array.isArray(cur)
        ? (cur as Record<string, unknown>[]).map((row) =>
            Object.fromEntries((f.item ?? []).map((sf) =>
              [sf.name, row?.[sf.name] != null ? String(row[sf.name]) : ""])))
        : [];
    }
    return r;
  });
  const [labelRows, setLabelRows] = useState<LabelRow[]>(() => {
    const l = initial?.config?.labels;
    // structured push connectors get sensible default label axes when creating a fresh source
    return (Array.isArray(l) && l.length) ? labelsToRows(l) : labelsToRows(DEFAULT_LABELS[connector]);
  });
  const [error, setError] = useState<string>();
  const [test, setTest] = useState<TestResult>();
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<DiscoverProposal>();
  const [containers, setContainers] = useState<EnvScan["containers"]>();

  const jsonErrors = useMemo(() => {
    const errs: Record<string, string> = {};
    for (const f of spec.fields) {
      if (f.type === "json" && values[f.name]?.trim()) {
        try { JSON.parse(values[f.name]); } catch (e) { errs[f.name] = "invalid JSON: " + ((e as Error).message ?? e); }
      }
    }
    return errs;
  }, [spec.fields, values]);

  const build = () => {
    const config: Record<string, unknown> = {};
    for (const f of spec.fields) {
      if (f.type === "list") {
        const out: Record<string, unknown>[] = [];
        for (const row of rows[f.name] ?? []) {
          if (!(f.item ?? []).some((sf) => (row[sf.name] ?? "").trim())) continue;  // skip empty row
          const obj: Record<string, unknown> = {};
          for (const sf of f.item ?? []) {
            const raw = (row[sf.name] ?? "").trim();
            if (!raw) {
              if (sf.required) throw new Error(`${f.name}: "${sf.name}" is required in every row`);
              continue;
            }
            obj[sf.name] = sf.type === "number" ? Number(raw) : raw;
          }
          out.push(obj);
        }
        if (f.required && !out.length) throw new Error(`${f.name}: add at least one row`);
        if (out.length) config[f.name] = out;
        continue;
      }
      const raw = values[f.name]?.trim();
      if (!raw) {
        if (f.required) throw new Error(`${f.name} is required`);
        continue;
      }
      if (f.type === "json") config[f.name] = JSON.parse(raw);
      else if (f.type === "number") config[f.name] = Number(raw);
      else config[f.name] = raw;
    }
    const labels = labelRows
      .filter((r) => r.name.trim())
      .map((r) => ({ name: r.name.trim(), [r.kind]: r.value, ...(r.primary ? { primary: true } : {}) }));
    if (labels.length) config.labels = labels;
    if (!name.trim()) throw new Error("name is required");
    return { name: name.trim(), type, connector, poll: poll.trim() || "5s", config };
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try { await fn(); } catch (e) { setError(String((e as Error).message ?? e)); }
    setBusy(false);
  };

  const discover = () => run(async () => {
    if (connector === "docker_logs") {
      setContainers((await api.discoverEnvironment("docker")).containers);
      return;
    }
    const cfg: Record<string, unknown> = {};
    for (const f of spec.fields) {
      const raw = values[f.name]?.trim();
      if (raw && f.type !== "json") cfg[f.name] = f.type === "number" ? Number(raw) : raw;
    }
    const p = await api.discoverSource(connector, cfg);
    // connectors whose discover proposes a config to confirm in a panel (prometheus) set `proposal`;
    // simpler ones (github) just apply the proposed config and report a one-line summary
    if (Array.isArray((p as { metrics?: unknown[] }).metrics)) {
      setProposal(p);
    } else {
      applyConfig((p as { proposed_config?: Record<string, unknown> }).proposed_config ?? {});
      const summary = (p as { summary?: unknown }).summary;
      if (typeof summary === "string") setTest({ ok: true, note: summary });
    }
  });

  const pickContainer = (c: { name: string; service: string; project: string }) => {
    setValues((v) => ({ ...v, container: c.name }));
    if (!name.trim()) setName(`${c.service}_logs`);
    setLabelRows(labelsToRows(
      [{ name: "service", const: c.service, primary: true }, { name: "project", const: c.project }]));
    setContainers(undefined);
  };

  const applyConfig = (c: Record<string, unknown>) => {
    setValues((v) => {
      const nv = { ...v };
      for (const f of spec.fields) {
        if (f.type === "list") continue;
        if (c[f.name] != null) nv[f.name] = String(c[f.name]);
      }
      return nv;
    });
    setRows((r) => {
      const nr = { ...r };
      for (const f of spec.fields) {
        if (f.type !== "list" || !Array.isArray(c[f.name])) continue;
        nr[f.name] = (c[f.name] as Record<string, unknown>[]).map((row) =>
          Object.fromEntries((f.item ?? []).map((sf) =>
            [sf.name, row?.[sf.name] != null ? String(row[sf.name]) : ""])));
      }
      return nr;
    });
    setLabelRows(labelsToRows(c.labels));
  };

  const applyProposal = () => {
    if (!proposal) return;
    applyConfig(proposal.proposed_config as unknown as Record<string, unknown>);
    setProposal(undefined);
  };

  // Editing labels re-processes every stored event for the source; warn before that happens.
  // Only meaningful when editing (initial present) — a fresh source has no stored events.
  const canonRows = (rs: LabelRow[]) =>
    JSON.stringify(rs.filter((r) => r.name.trim()).map((r) => [r.name.trim(), r.kind, r.value, r.primary]));
  const labelsChanged = !!initial && canonRows(labelRows) !== canonRows(labelsToRows(initial?.config?.labels));

  return (
    <form onSubmit={(e) => { e.preventDefault(); run(async () => onSubmit(build())); }}>
      {error && <div className="alert error">{error}</div>}
      {test && (
        <div className={`alert ${test.ok ? "ok" : "error"}`}>
          {test.ok
            ? <>connection ok — {test.note ?? `${test.events} event(s) on a test poll`}
                {test.sample?.length ? <pre className="payload">{test.sample.join("\n")}</pre> : null}</>
            : <>test failed: {test.error}</>}
        </div>
      )}

      <label className="field" style={{ maxWidth: 360 }}>
        <span className="lbl">name <span className="req">*</span></span>
        <input type="text" value={name} disabled={lockName} placeholder="e.g. metrics"
               onChange={(e) => setName(e.target.value)} />
        <span className="help">logical source name; events carry it forever</span>
      </label>

      {spec.mode === "poll" && (
        <label className="field" style={{ maxWidth: 220 }}>
          <span className="lbl">poll interval</span>
          <input type="text" value={poll} onChange={(e) => setPoll(e.target.value)} />
          <span className="help">e.g. 5s, 1m, 1h</span>
        </label>
      )}

      {spec.fields.map((f) => (
        f.type === "list" ? (
          <ListFieldEditor key={f.name} field={f} rows={rows[f.name] ?? []}
                           onChange={(r) => setRows({ ...rows, [f.name]: r })} />
        ) : (
          <label className={"field" + (jsonErrors[f.name] ? " invalid" : "")} key={f.name}>
            <span className="lbl">{f.name} {f.required && <span className="req">*</span>}</span>
            {f.type === "json" ? (
              <textarea className="code" value={values[f.name]}
                        onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
            ) : (
              <input type={f.type === "number" ? "number" : "text"} value={values[f.name]}
                     onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
            )}
            <span className="help">{jsonErrors[f.name] ?? f.help}</span>
          </label>
        )
      ))}

      {spec.discover && (
        <div className="panel" style={{ background: "var(--th-bg)", marginBottom: 14 }}>
          <div className="btnrow" style={{ alignItems: "center" }}>
            <button type="button" disabled={busy} onClick={discover}>
              ✦ {connector === "docker_logs" ? "Discover containers" : "Discover"}
            </button>
            <span className="help" style={{ margin: 0 }}>
              {connector === "docker_logs"
                ? "list the containers navflowd can see, then pick one to fill this form"
                : connector === "github"
                ? "enter the repo above, then Discover its default branch + author labels"
                : "fill the URL above, then let NavFlow introspect the source and propose what to ingest — no PromQL to write by hand"}
            </span>
          </div>
          {proposal && <ProposalView proposal={proposal} onApply={applyProposal} />}
          {containers && (
            <table style={{ marginTop: 10 }}>
              <thead><tr><th>service</th><th>image</th><th></th></tr></thead>
              <tbody>
                {containers.map((c) => (
                  <tr key={c.name}>
                    <td className="mono">{c.service}</td>
                    <td className="help">{c.image}</td>
                    <td style={{ textAlign: "right" }}>
                      <button type="button" onClick={() => pickContainer(c)}>use this</button>
                    </td>
                  </tr>
                ))}
                {containers.length === 0 && (
                  <tr><td colSpan={3} className="help">no containers found</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}

      <LabelsEditor rows={labelRows} onChange={setLabelRows}
                    fields={(spec.provides ?? []).map((p) => p.name)} />

      {labelsChanged && (
        <div className="alert info">
          Label changes apply to new events going forward. Existing events keep the labels they were
          ingested with; retroactive relabel of stored events is coming soon.
        </div>
      )}

      <div className="btnrow">
        <button type="submit" className="primary" disabled={busy || Object.keys(jsonErrors).length > 0}>
          {submitLabel}
        </button>
        {spec.mode === "poll" && (
          <button type="button" disabled={busy}
                  onClick={() => run(async () => setTest(await api.testSource(build())))}>
            Test connection
          </button>
        )}
      </div>
    </form>
  );
}

type LabelRow = { name: string; kind: "const" | "field"; value: string; primary: boolean };

function labelsToRows(arr: unknown): LabelRow[] {
  if (!Array.isArray(arr)) return [];
  const rows = arr.map((x) => {
    const o = x as Record<string, unknown>;
    const kind: "const" | "field" = "field" in o ? "field" : "const";
    return { name: String(o.name ?? ""), kind, value: String(o[kind] ?? ""), primary: !!o.primary };
  });
  if (rows.length && !rows.some((r) => r.primary)) rows[0].primary = true;  // first is the key by default
  return rows;
}

function LabelsEditor({ rows, onChange, fields = [] }:
  { rows: LabelRow[]; onChange: (r: LabelRow[]) => void; fields?: string[] }) {
  const set = (i: number, patch: Partial<LabelRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const makePrimary = (i: number) => onChange(rows.map((r, j) => ({ ...r, primary: j === i })));
  const remove = (i: number) => {
    const next = rows.filter((_, j) => j !== i);
    if (next.length && !next.some((r) => r.primary)) next[0].primary = true;  // keep one key
    onChange(next);
  };
  return (
    <div className="field">
      <span className="lbl">labels &amp; key</span>
      <span className="help" style={{ display: "block", marginTop: 0, marginBottom: 8 }}>
        the entity axes events carry — a fixed <code>const</code> value or read per-event from a{" "}
        <code>field</code>. One is the <strong>key</strong> (the primary entity you read and alert by);
        the rest are extra axes. Browse them all on the Entities page.
      </span>
      {rows.length > 0 && (
        <div className="label-head">
          <span className="help label-col-key">key</span>
          <span className="help label-col-grow">name</span>
          <span className="help label-col-from">from</span>
          <span className="help label-col-grow">value</span>
          <span className="label-col-x" />
        </div>
      )}
      {rows.map((row, i) => (
        <div key={i} className="label-row">
          <span className="label-col-key" title="make this the primary key">
            <input type="radio" checked={row.primary} onChange={() => makePrimary(i)} />
          </span>
          <input className="label-col-grow" placeholder="e.g. service" value={row.name}
                 onChange={(e) => set(i, { name: e.target.value })} />
          <select className="label-col-from" value={row.kind}
                  onChange={(e) => set(i, { kind: e.target.value as LabelRow["kind"] })}>
            <option value="const">const (fixed)</option>
            <option value="field">field (per event)</option>
          </select>
          <input className={"label-col-grow" + (row.kind === "field" ? " mono" : "")}
                 list={row.kind === "field" && fields.length ? "provided-fields" : undefined}
                 placeholder={row.kind === "const" ? "value, e.g. api-server" : "field, e.g. service"}
                 value={row.value} onChange={(e) => set(i, { value: e.target.value })} />
          <button type="button" className="danger label-col-x" onClick={() => remove(i)}>×</button>
        </div>
      ))}
      <button type="button"
              onClick={() => onChange([...rows, { name: "", kind: "const", value: "", primary: rows.length === 0 }])}>
        + Add label
      </button>
      {fields.length > 0 && (
        <>
          <datalist id="provided-fields">{fields.map((f) => <option key={f} value={f} />)}</datalist>
          <div className="help" style={{ marginTop: 6 }}>
            this connector provides: {fields.map((f, i) => <span key={f}><code>{f}</code>{i < fields.length - 1 ? ", " : ""}</span>)}
            {" "}— pick a <code>field</code> from these (the source's page shows each field's coverage once data flows).
          </div>
        </>
      )}
    </div>
  );
}

function ListFieldEditor({ field, rows, onChange }:
  { field: ConnectorField; rows: Array<Record<string, string>>; onChange: (r: Array<Record<string, string>>) => void }) {
  const sub = field.item ?? [];
  const blank = () => Object.fromEntries(sub.map((sf) => [sf.name, ""]));
  const setCell = (i: number, name: string, val: string) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, [name]: val } : r)));

  return (
    <div className="field">
      <span className="lbl">{field.name} {field.required && <span className="req">*</span>}</span>
      <span className="help" style={{ marginTop: 0, marginBottom: 6 }}>{field.help}</span>
      {rows.length === 0 && <div className="empty" style={{ padding: 10 }}>no rows yet — add one below</div>}
      {rows.map((row, i) => (
        <div key={i} className="panel" style={{ padding: 10, marginBottom: 8 }}>
          <div className="btnrow" style={{ justifyContent: "space-between", marginBottom: 4 }}>
            <span className="help" style={{ margin: 0 }}>#{i + 1}</span>
            <button type="button" className="danger" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              remove
            </button>
          </div>
          {sub.map((sf) => (
            <label className="field" key={sf.name} style={{ marginBottom: 6 }}>
              <span className="lbl" style={{ fontSize: 12 }}>
                {sf.name} {sf.required && <span className="req">*</span>}
              </span>
              <input type={sf.type === "number" ? "number" : "text"} value={row[sf.name] ?? ""}
                     placeholder={sf.help} className={sf.name === "promql" ? "mono" : undefined}
                     onChange={(e) => setCell(i, sf.name, e.target.value)} />
            </label>
          ))}
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, blank()])}>
        + Add {field.name === "queries" ? "query" : "row"}
      </button>
    </div>
  );
}

function ProposalView({ proposal, onApply }: { proposal: DiscoverProposal; onApply: () => void }) {
  const k = proposal.suggested_key;
  return (
    <div style={{ marginTop: 12 }}>
      <p className="subtitle" style={{ marginTop: 0 }}>
        found {proposal.summary.total_metrics} metrics · {proposal.summary.relevant} relevant ·{" "}
        {proposal.summary.hidden} internals hidden
      </p>

      <div className="field" style={{ marginBottom: 10 }}>
        <span className="lbl">suggested key</span>
        <div>
          <span className="chip mono">{k.name}</span>
          <span className="help" style={{ marginLeft: 8 }}>
            {k.cardinality} {k.cardinality === 1 ? "entity" : "entities"}
            {k.values_preview.length ? ` — ${k.values_preview.join(", ")}` : ""}
            {k.alternatives.length ? ` · alternatives: ${k.alternatives.join(", ")}` : ""}
          </span>
        </div>
      </div>

      <div className="field" style={{ marginBottom: 10 }}>
        <span className="lbl">will ingest ({proposal.metrics.filter((m) => m.ingest).length})</span>
        <table>
          <thead>
            <tr>
              <th style={{ width: 36, textAlign: "center" }} title="ingested">in</th>
              <th>metric</th>
              <th style={{ width: 84 }}>type</th>
              <th>detail</th>
            </tr>
          </thead>
          <tbody>
            {proposal.metrics.map((m) => (
              <tr key={m.name} style={{ opacity: m.ingest ? 1 : 0.5 }}>
                <td style={{ textAlign: "center" }}>{m.ingest ? "✓" : "—"}</td>
                <td className="mono">{m.name}</td>
                <td><span className="chip">{m.type}</span></td>
                <td className="help">{m.help || m.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {proposal.derived_suggestions.length > 0 && (
        <div className="field" style={{ marginBottom: 10 }}>
          <span className="lbl">derived suggestions</span>
          {proposal.derived_suggestions.map((d) => (
            <div key={d.id} style={{ marginBottom: 4 }}>
              <span className="chip">{d.label}</span>
              <span className="help mono" style={{ marginLeft: 8 }}>{d.promql}</span>
            </div>
          ))}
        </div>
      )}

      {proposal.proposed_labels.length > 0 && (
        <div className="field" style={{ marginBottom: 10 }}>
          <span className="lbl">labels</span>
          <div>{proposal.proposed_labels.map((l) => <span className="chip mono" key={l}>{l}</span>)}</div>
        </div>
      )}

      <button type="button" className="primary" onClick={onApply}>
        Apply to form
      </button>
      <span className="help" style={{ marginLeft: 10 }}>
        fills the fields below — review, Test connection, then Create
      </span>
    </div>
  );
}

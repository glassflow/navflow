import { useEffect, useMemo, useState } from "react";

import { api } from "../api";
import { Combo } from "./bits";
import type { ColumnsProposal, ConnectorField, ConnectorSpec, DiscoverProposal, EnvScan, TestResult } from "../types";

// Structured push connectors know their entity shape, so a fresh source starts with sensible
// label axes (the user can still edit/remove them).
const DEFAULT_LABELS: Record<string, Array<Record<string, unknown>>> = {
  vercel: [{ name: "project", field: "project", primary: true },
           { name: "environment", field: "environment" }, { name: "source", field: "source" }],
  otlp: [{ name: "service", field: "resourceAttributes.service.name", primary: true }],
};

// Connector-appropriate example names; the generic fallback suits metric-ish sources.
const NAME_PLACEHOLDER: Record<string, string> = {
  github: "e.g. my-repo-commits",
  postgres: "e.g. orders-table",
};

// What Discover does, per connector (fallback: the prometheus introspection copy).
const DISCOVER_HINT: Record<string, string> = {
  docker_logs: "list the containers navflowd can see, then pick one to fill this form",
  github: "enter the repo above, then Discover its default branch + author labels",
  postgres: "enter the DSN above, then Discover — it lists the tables it can see; pick one and it proposes the cursor, entity key and labels from the columns",
};

// Postgres form: plain-language field labels + grouping (main poll settings vs collapsed advanced),
// so the internal schema names don't leak into the UI. Fields not in PG_GROUP go in the main group.
const PG_LABEL: Record<string, string> = {
  dsn: "Connection URL",
  table: "Table",
  cursor_column: "How we find new rows",
  time_column: "Event time",
  columns: "Columns to pull",
  limit: "Rows per poll",
};
const PG_GROUP: Record<string, "advanced"> = { limit: "advanced" };

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
  const [poll, setPoll] = useState(initial?.poll ?? spec.poll ?? "5s");
  // A secret that's already stored comes back from the API as a redaction placeholder, never its
  // real value. Show which secrets are set, but never prefill one — blank means "keep it" (below).
  const secretSet = (f: ConnectorField) => !!f.secret && !!initial?.config?.[f.name];
  const [cleared, setCleared] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const f of spec.fields) {
      if (f.type === "list") continue;   // list fields use `rows`, below
      if (f.secret) { v[f.name] = ""; continue; }   // never prefill a secret
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
  // For an existing source, what the data actually carries beats the connector's static
  // `provides` list — merge the observed field profile into the labels editor's suggestions,
  // keeping coverage so the dropdown can show how many sampled events carry each field.
  const [observed, setObserved] = useState<{ sampled: number; fields: { name: string; coverage: number }[] }>();
  useEffect(() => {
    if (!initial?.name) return;
    api.sourceFields(initial.name)
      .then((p) => setObserved({ sampled: p.sampled,
                                 fields: p.fields.map((f) => ({ name: f.name, coverage: f.coverage })) }))
      .catch(() => {});
  }, [initial?.name]);
  const coverage = new Map((observed?.fields ?? []).map((f) => [f.name, f.coverage]));
  const labelFieldOpts = Array.from(new Set([
    ...(spec.provides ?? []).map((p) => p.name),
    ...(observed?.fields ?? []).map((f) => f.name),
  ])).sort((a, b) => (coverage.get(b) ?? -1) - (coverage.get(a) ?? -1) || a.localeCompare(b));
  const labelFieldHints = observed
    ? Object.fromEntries(labelFieldOpts
        .filter((n) => coverage.has(n))
        .map((n) => [n, `${coverage.get(n)} / ${observed.sampled} events`]))
    : undefined;
  const [proposal, setProposal] = useState<DiscoverProposal>();
  const [colProposal, setColProposal] = useState<ColumnsProposal>();
  const [pgColumns, setPgColumns] = useState<string[]>();  // postgres: discovered column names, for the picker
  const [editConn, setEditConn] = useState(false);         // postgres: connection collapsed after discover unless editing
  const [tables, setTables] = useState<string[]>();
  const [containers, setContainers] = useState<EnvScan["containers"]>();
  const [discovering, setDiscovering] = useState(false);
  const [discoverErr, setDiscoverErr] = useState<string>();

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
      // A secret that's already set: blank = keep (omit), typed = replace, Remove = clear ("").
      if (secretSet(f)) {
        if (cleared[f.name]) config[f.name] = "";       // explicit remove
        else if (raw) config[f.name] = raw;             // replace
        // else omit → the daemon keeps the stored secret
        continue;
      }
      if (!raw) {
        if (f.required) throw new Error(`${f.name} is required`);
        continue;
      }
      if (f.type === "json") config[f.name] = JSON.parse(raw);
      else if (f.type === "number") config[f.name] = Number(raw);
      else config[f.name] = raw;
    }
    const labels = labelRows.filter((r) => r.name.trim()).map(rowToSpec);
    if (labels.length) config.labels = labels;
    if (!name.trim()) throw new Error("name is required");
    return { name: name.trim(), type, connector, poll: poll.trim() || spec.poll || "5s", config };
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try { await fn(); } catch (e) { setError(String((e as Error).message ?? e)); }
    setBusy(false);
  };

  // discover errors surface inside the Discover panel (the top-of-form alert can be scrolled
  // out of view on long forms — the user is looking at the button they just clicked)
  const discover = (override?: Record<string, unknown>) => run(async () => {
    setDiscovering(true);
    setDiscoverErr(undefined);
    try {
      await doDiscover(override);
    } catch (e) {
      setDiscoverErr(String((e as Error).message ?? e));
    }
    setDiscovering(false);
  });

  const doDiscover = async (override?: Record<string, unknown>) => {
    if (connector === "docker_logs") {
      setContainers((await api.discoverEnvironment("docker")).containers);
      return;
    }
    const cfg: Record<string, unknown> = {};
    for (const f of spec.fields) {
      const raw = values[f.name]?.trim();
      if (raw && f.type !== "json") cfg[f.name] = f.type === "number" ? Number(raw) : raw;
    }
    Object.assign(cfg, override);
    const p = await api.discoverSource(connector, cfg);
    // connectors whose discover proposes a config to confirm in a panel set `proposal`
    // (prometheus: metrics), `colProposal` (postgres: table columns) or `tables` (postgres
    // without a table yet: pick one); simpler ones (github) just apply the proposed config
    // and report a one-line summary
    if (Array.isArray((p as { metrics?: unknown[] }).metrics)) {
      setProposal(p);
    } else if (Array.isArray((p as { columns?: unknown[] }).columns)) {
      const cp = p as unknown as ColumnsProposal;
      setColProposal(cp);
      setPgColumns(cp.columns.map((c) => c.name));   // feed the column picker below
      setEditConn(false);                            // collapse the connection now it's confirmed
    } else if (Array.isArray((p as { tables?: unknown[] }).tables)) {
      setTables((p as unknown as { tables: string[] }).tables);
    } else {
      applyConfig((p as { proposed_config?: Record<string, unknown> }).proposed_config ?? {});
      const summary = (p as { summary?: unknown }).summary;
      if (typeof summary === "string") setTest({ ok: true, note: summary });
    }
  };

  const pickTable = (t: string) => {
    setValues((v) => ({ ...v, table: t }));
    if (!name.trim()) setName(`${t.split(".").pop()}-table`);
    setTables(undefined);
    void discover({ table: t });   // straight to the columns proposal for the picked table
  };

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
    JSON.stringify(rs.filter((r) => r.name.trim()).map(rowToSpec));
  const labelsChanged = !!initial && canonRows(labelRows) !== canonRows(labelsToRows(initial?.config?.labels));

  // The right-column control for one field: postgres column checklist / single-column dropdown, a
  // json textarea, or a plain input (with secret handling).
  const fieldControl = (f: ConnectorField) => {
    if (connector === "postgres" && f.name === "columns" && pgColumns?.length) {
      // always keep the cursor/time columns + any column a label reads (the key is a primary label)
      const mandatory = new Set([
        values.cursor_column, values.time_column,
        ...labelRows.filter((r) => r.kind === "field").map((r) => r.value),
      ].map((v) => v?.trim()).filter(Boolean) as string[]);
      return <ColumnPicker columns={pgColumns} value={values[f.name] ?? ""} mandatory={mandatory}
                           onChange={(v) => setValues({ ...values, [f.name]: v })} />;
    }
    if (connector === "postgres" && pgColumns?.length
        && ["cursor_column", "time_column"].includes(f.name)) {
      const opts = pgColumns.includes(values[f.name] ?? "") || !values[f.name]
        ? pgColumns : [values[f.name], ...pgColumns];   // keep a stale value selectable
      return (
        <select value={values[f.name] ?? ""} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}>
          <option value="">{f.required ? "— select —" : "— none —"}</option>
          {opts.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      );
    }
    if (f.type === "json")
      return <textarea className="code" value={values[f.name]}
                       onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />;
    return <input type={f.secret ? "password" : f.type === "number" ? "number" : "text"}
                  value={values[f.name]} autoComplete={f.secret ? "off" : undefined}
                  disabled={secretSet(f) && cleared[f.name]}
                  placeholder={secretSet(f) ? (cleared[f.name] ? "" : "leave blank to keep") : undefined}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />;
  };

  const fieldHelp = (f: ConnectorField) =>
    secretSet(f) ? (
      <span className="help">
        {cleared[f.name]
          ? <>will be removed on save — <button type="button" className="linklike"
                onClick={() => setCleared({ ...cleared, [f.name]: false })}>undo</button></>
          : <>a value is set — type to replace, or leave blank to keep ·{" "}
              <button type="button" className="linklike"
                onClick={() => { setCleared({ ...cleared, [f.name]: true }); setValues({ ...values, [f.name]: "" }); }}>remove</button></>}
      </span>
    ) : <span className="help">{jsonErrors[f.name] ?? f.help}</span>;

  const fieldLabel = (f: ConnectorField) => (connector === "postgres" && PG_LABEL[f.name]) || f.name;
  const fieldDetected = (f: ConnectorField) =>       // value came from Discover, not the user
    connector === "postgres" && !!pgColumns?.length && !!values[f.name]?.trim()
    && ["cursor_column", "time_column"].includes(f.name);

  // Two-column row: label + description on the left, control on the right. (list fields keep their
  // own full-width editor.)
  const renderField = (f: ConnectorField) => {
    if (f.type === "list")
      return <ListFieldEditor key={f.name} field={f} rows={rows[f.name] ?? []}
                              onChange={(r) => setRows({ ...rows, [f.name]: r })} />;
    return (
      <div className={"fld-row" + (jsonErrors[f.name] ? " invalid" : "")} key={f.name}>
        <div className="fld-meta">
          <span className="lbl">{fieldLabel(f)}{f.required && <span className="req"> *</span>}
            {fieldDetected(f) && <span className="badge ok" style={{ marginLeft: 8 }}>detected</span>}</span>
          {fieldHelp(f)}
        </div>
        <div className="fld-ctrl">{fieldControl(f)}</div>
      </div>
    );
  };

  // Postgres: group the poll settings into a main block + a collapsed "Advanced".
  const renderPgFields = (fields: ConnectorField[]) => {
    const main = fields.filter((f) => PG_GROUP[f.name] !== "advanced");
    const advanced = fields.filter((f) => PG_GROUP[f.name] === "advanced");
    const found = !!pgColumns?.length;
    return (
      <>
        <div className="fld-group">
          <div className="fld-group-head">
            <h3>{found ? <>What we read from <code>{values.table || "the table"}</code></> : "How to poll the table"}</h3>
            <p className="help">{found
              ? "Discover picked these from the columns — adjust any that aren't right."
              : "Run Discover above to fill these from the table, or set them by hand."}</p>
          </div>
          {main.map(renderField)}
        </div>
        {advanced.length > 0 && (
          <details className="fld-group adv-group">
            <summary>Advanced<span className="caret">›</span></summary>
            <div>{advanced.map(renderField)}</div>
          </details>
        )}
      </>
    );
  };

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
        <input type="text" value={name} disabled={lockName}
               placeholder={NAME_PLACEHOLDER[connector] ?? "e.g. metrics"}
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

      {connector === "postgres" && spec.discover && pgColumns?.length && !editConn ? (
        <div className="conn-summary">
          <span className="tick">✓</span>
          <span>Connected{(() => {
            try { const u = new URL(values.dsn); const db = u.pathname.replace(/^\//, "");
              return <> to <code>{db || u.hostname}</code>{db && u.hostname ? <> · {u.hostname}</> : null}</>; }
            catch { return null; }
          })()}</span>
          <button type="button" className="linklike" style={{ marginLeft: "auto" }}
                  onClick={() => setEditConn(true)}>edit connection</button>
        </div>
      ) : (
        (spec.discover ? spec.fields.filter((f) => f.discover_input) : spec.fields).map(renderField)
      )}

      {spec.discover && !(connector === "postgres" && pgColumns?.length && !editConn) && (
        <div className="panel" style={{ background: "var(--th-bg)", marginBottom: 14 }}>
          <div className="btnrow" style={{ alignItems: "center" }}>
            <button type="button" disabled={busy} onClick={() => discover()}>
              {discovering ? "⏳ discovering…"
                : `✦ ${connector === "docker_logs" ? "Discover containers" : "Discover"}`}
            </button>
            <span className="help" style={{ margin: 0 }}>
              {DISCOVER_HINT[connector]
                ?? "fill the URL above, then let NavFlow introspect the source and propose what to ingest — no PromQL to write by hand"}
            </span>
          </div>
          {discoverErr && <div className="alert error" style={{ marginTop: 10, marginBottom: 0 }}>{discoverErr}</div>}
          {proposal && <ProposalView proposal={proposal} onApply={applyProposal} />}
          {tables && (
            <table style={{ marginTop: 10 }}>
              <thead><tr><th>table</th><th style={{ width: 100 }}></th></tr></thead>
              <tbody>
                {tables.map((t) => (
                  <tr key={t}>
                    <td className="mono">{t}</td>
                    <td style={{ textAlign: "right" }}>
                      <button type="button" disabled={busy} onClick={() => pickTable(t)}>use this</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {colProposal && (
            <ColumnsProposalView proposal={colProposal}
              onApply={() => {
                applyConfig(colProposal.proposed_config);
                setTest({ ok: true, note: colProposal.summary });
                setColProposal(undefined);
              }} />
          )}
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

      {spec.discover && (connector === "postgres"
        ? renderPgFields(spec.fields.filter((f) => !f.discover_input))
        : spec.fields.filter((f) => !f.discover_input).map(renderField))}

      <LabelsEditor rows={labelRows} onChange={setLabelRows} sourceName={initial?.name}
                    fields={labelFieldOpts} fieldHints={labelFieldHints} />

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

type MapRow = { from: string; to: string };
type LabelRow = { name: string; kind: "const" | "field"; value: string; primary: boolean;
                  type: "string" | "number";
                  pattern: string; replace: string; map: MapRow[]; normOpen: boolean };

function labelsToRows(arr: unknown): LabelRow[] {
  if (!Array.isArray(arr)) return [];
  const rows = arr.map((x) => {
    const o = x as Record<string, unknown>;
    const kind: "const" | "field" = "field" in o ? "field" : "const";
    const map = o.map && typeof o.map === "object"
      ? Object.entries(o.map as Record<string, string>).map(([from, to]) => ({ from, to: String(to) }))
      : [];
    return { name: String(o.name ?? ""), kind, value: String(o[kind] ?? ""), primary: !!o.primary,
             type: o.type === "number" ? "number" as const : "string" as const,
             pattern: String(o.pattern ?? ""), replace: String(o.replace ?? ""), map,
             normOpen: !!(o.pattern || map.length) };
  });
  if (rows.length && !rows.some((r) => r.primary)) rows[0].primary = true;  // first is the key by default
  return rows;
}

/** Row -> label spec, including the optional value normalization (pattern/replace + alias map). */
function rowToSpec(r: LabelRow): Record<string, unknown> {
  const spec: Record<string, unknown> = { name: r.name.trim(), [r.kind]: r.value,
                                          ...(r.primary ? { primary: true } : {}),
                                          // the key is always a string; number labels are aggregatable
                                          ...(r.type === "number" && !r.primary ? { type: "number" } : {}) };
  if (r.kind === "field") {
    if (r.pattern.trim()) { spec.pattern = r.pattern; spec.replace = r.replace; }
    const map = Object.fromEntries(r.map.filter((m) => m.from.trim()).map((m) => [m.from, m.to]));
    if (Object.keys(map).length) spec.map = map;
  }
  return spec;
}

function LabelsEditor({ rows, onChange, fields = [], fieldHints, sourceName }:
  { rows: LabelRow[]; onChange: (r: LabelRow[]) => void; fields?: string[];
    fieldHints?: Record<string, string>; sourceName?: string }) {
  const set = (i: number, patch: Partial<LabelRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const makePrimary = (i: number) => onChange(rows.map((r, j) =>
    j === i ? { ...r, primary: true, type: "string" as const } : { ...r, primary: false }));
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
          <span className="help" style={{ width: 88, flexShrink: 0 }}>type</span>
          <span className="label-col-x" />
        </div>
      )}
      {rows.map((row, i) => (
        <div key={i}>
          <div className="label-row">
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
            {row.kind === "field" && fields.length ? (
              <Combo className="label-col-grow" value={row.value} options={fields}
                     hints={fieldHints} placeholder="field, e.g. service"
                     onChange={(v) => set(i, { value: v })} />
            ) : (
              <input className="label-col-grow"
                     placeholder={row.kind === "const" ? "value, e.g. api-server" : "field, e.g. service"}
                     value={row.value} onChange={(e) => set(i, { value: e.target.value })} />
            )}
            <select style={{ width: 88, flexShrink: 0 }} value={row.primary ? "string" : row.type}
                    disabled={row.primary}
                    title={row.primary ? "the key is always a string"
                                       : "number labels can be aggregated (avg/max/sum) in triggers"}
                    onChange={(e) => set(i, { type: e.target.value as LabelRow["type"] })}>
              <option value="string">string</option>
              <option value="number">number</option>
            </select>
            {row.kind === "field" && (
              <button type="button" title="normalize values (regex + aliases)"
                      className={row.normOpen || row.pattern || row.map.length ? "active" : "dim"}
                      onClick={() => set(i, { normOpen: !row.normOpen })}>≈</button>
            )}
            <button type="button" className="danger label-col-x" onClick={() => remove(i)}>×</button>
          </div>
          {row.kind === "field" && row.normOpen && (
            <NormalizeEditor row={row} onChange={(patch) => set(i, patch)} sourceName={sourceName} />
          )}
        </div>
      ))}
      <button type="button"
              onClick={() => onChange([...rows, { name: "", kind: "const", value: "", primary: rows.length === 0,
                                                  type: "string", pattern: "", replace: "", map: [], normOpen: false }])}>
        + Add label
      </button>
      {fields.length > 0 && (
        <>
          <div className="help" style={{ marginTop: 6 }}>
            this connector provides: {fields.map((f, i) => <span key={f}><code>{f}</code>{i < fields.length - 1 ? ", " : ""}</span>)}
            {" "}— pick a <code>field</code> from these (the source's page shows each field's coverage once data flows).
          </div>
        </>
      )}
    </div>
  );
}

/** Merge value variants for one field label. User-first flow: show the values this field
 *  actually has, let the user rename the odd ones onto a canonical one, and reflect the result
 *  live. The regex lives behind an "advanced" toggle for whole families of variants. */
function NormalizeEditor({ row, onChange, sourceName }:
  { row: LabelRow; onChange: (patch: Partial<LabelRow>) => void; sourceName?: string }) {
  const [preview, setPreview] = useState<{ sampled: number; distinct_before: number;
    distinct_after: number; results: { from: string; to: string; events: number }[] }>();
  const [pErr, setPErr] = useState<string>();
  const [advanced, setAdvanced] = useState(!!row.pattern);

  // live preview: on open (bare field -> the observed values), and after every edit (debounced)
  useEffect(() => {
    if (!sourceName || !row.value.trim()) return;
    const t = setTimeout(async () => {
      try {
        setPErr(undefined);
        setPreview(await api.labelPreview(sourceName, rowToSpec(row)));
      } catch (e) { setPreview(undefined); setPErr(String((e as Error).message ?? e)); }
    }, 500);
    return () => clearTimeout(t);
  }, [sourceName, row.value, row.pattern, row.replace, JSON.stringify(row.map)]);

  const observed = preview?.results ?? [];
  const merges = observed.filter((r2) => r2.from !== r2.to).length;
  const fromOpts = observed.map((r2) => r2.from);
  const fromHints = Object.fromEntries(observed.map((r2) => [r2.from, `${r2.events} events`]));

  const hasRules = !!row.pattern || row.map.length > 0;

  return (
    <div className="panel" style={{ margin: "2px 0 10px 28px", padding: 12 }}>
      <div className="pagehead" style={{ marginBottom: 6 }}>
        <strong>Merge value variants</strong>
        <span className="btnrow">
          {hasRules && (
            <button type="button" className="danger"
                    title="discard the pattern rule and all renames for this label"
                    onClick={() => { onChange({ pattern: "", replace: "", map: [] }); }}>
              Clear
            </button>
          )}
          <button type="button" onClick={() => onChange({ normOpen: false })}>Done</button>
        </span>
      </div>
      <span className="help" style={{ display: "block", marginTop: 0, marginBottom: 8, whiteSpace: "normal" }}>
        If the same thing appears under different names
        (say <span className="mono">checkout</span> and <span className="mono">checkout-svc</span>),
        they count as different entities and won&rsquo;t correlate. Rename the variants onto one
        name here. Renaming never loses data — the original value stays in the stored event.
      </span>

      {pErr && <div className="alert error">{pErr}</div>}

      {sourceName && preview && (
        <div style={{ marginBottom: 10 }}>
          <span className="help">
            This field has <strong>{preview.distinct_before}</strong> distinct value{preview.distinct_before === 1 ? "" : "s"} in
            recent events{merges > 0 && <> — with your renames it becomes <strong>{preview.distinct_after}</strong></>}:
          </span>
          <table style={{ marginTop: 6 }}>
            <thead><tr><th>value seen</th><th className="num">events</th><th>will become</th></tr></thead>
            <tbody>
              {observed.slice(0, 12).map((r2, k) => (
                <tr key={k}>
                  <td className="mono">{r2.from}</td>
                  <td className="num">{r2.events}</td>
                  <td className="mono">
                    {r2.from === r2.to
                      ? <span className="dim">unchanged</span>
                      : <><span className="badge ok" style={{ marginRight: 6 }}>→</span>{r2.to}</>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sourceName && !preview && !pErr && <div className="dim" style={{ marginBottom: 10 }}>loading observed values…</div>}
      {!sourceName && (
        <span className="help" style={{ display: "block", marginBottom: 10 }}>
          (once this source has data, its actual values will show here so you can pick what to rename)
        </span>
      )}

      {row.map.map((m, j) => (
        <div key={j} className="btnrow" style={{ marginBottom: 6, alignItems: "center" }}>
          <span className="help">rename</span>
          <Combo style={{ flex: 1 }} value={m.from} options={fromOpts} hints={fromHints}
                 placeholder="value seen in the data"
                 onChange={(v) => onChange({ map: row.map.map((x, k) => k === j ? { ...x, from: v } : x) })} />
          <span className="help">to</span>
          <input className="mono" style={{ flex: 1 }} placeholder="the name it should have"
                 value={m.to}
                 onChange={(e) => onChange({ map: row.map.map((x, k) => k === j ? { ...x, to: e.target.value } : x) })} />
          <button type="button" className="danger" onClick={() => onChange({ map: row.map.filter((_, k) => k !== j) })}>×</button>
        </div>
      ))}
      <div className="btnrow">
        <button type="button" onClick={() => onChange({ map: [...row.map, { from: "", to: "" }] })}>
          + Rename a value
        </button>
        <button type="button" className="dim" onClick={() => setAdvanced((a) => !a)}>
          {advanced ? "hide pattern rule" : "advanced: pattern rule…"}
        </button>
      </div>

      {advanced && (
        <PatternRule key={row.pattern === "" ? "empty" : "set"} row={row} onChange={onChange} />
      )}
    </div>
  );
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type RuleKind = "suffix" | "prefix" | "after" | "custom";

/** Builds the pattern for the user from plain choices — "remove the ending -svc" — so nobody has
 *  to write a regex unless they pick custom. The stored config is still just pattern/replace. */
function PatternRule({ row, onChange }:
  { row: LabelRow; onChange: (patch: Partial<LabelRow>) => void }) {
  const [kind, setKind] = useState<RuleKind>(row.pattern ? "custom" : "suffix");
  const [text, setText] = useState("");

  const apply = (k: RuleKind, t: string) => {
    if (k === "suffix") onChange({ pattern: t ? `${escRe(t)}$` : "", replace: "" });
    else if (k === "prefix") onChange({ pattern: t ? `^${escRe(t)}` : "", replace: "" });
    else if (k === "after") onChange({ pattern: t ? `${escRe(t)}.*$` : "", replace: "" });
  };

  return (
    <div style={{ marginTop: 8 }}>
      <span className="help" style={{ display: "block", marginBottom: 6, whiteSpace: "normal" }}>
        A pattern rule fixes a whole family of values at once (it runs before the renames above).
        The table shows its effect live.
      </span>
      <div className="btnrow" style={{ alignItems: "center" }}>
        <select value={kind} style={{ maxWidth: 260 }}
                onChange={(e) => { const k = e.target.value as RuleKind; setKind(k);
                                   if (k === "custom") return; apply(k, text); }}>
          <option value="suffix">remove this ending</option>
          <option value="prefix">remove this beginning</option>
          <option value="after">cut everything from … onwards</option>
          <option value="custom">custom (regular expression)</option>
        </select>
        {kind !== "custom" ? (
          <input className="mono" style={{ flex: 1 }}
                 placeholder={kind === "suffix" ? "e.g. -svc" : kind === "prefix" ? "e.g. prod-" : "e.g. ."}
                 value={text}
                 onChange={(e) => { setText(e.target.value); apply(kind, e.target.value); }} />
        ) : (
          <>
            <input className="mono" style={{ flex: 2 }} placeholder="regex, e.g. -(service|svc)$"
                   value={row.pattern} onChange={(e) => onChange({ pattern: e.target.value })} />
            <input className="mono" style={{ flex: 1 }} placeholder="replacement (empty = remove)"
                   value={row.replace} onChange={(e) => onChange({ replace: e.target.value })} />
          </>
        )}
      </div>
      {kind === "suffix" && (
        <span className="help">e.g. entering <span className="mono">-svc</span> turns{" "}
          <span className="mono">checkout-svc</span> into <span className="mono">checkout</span></span>
      )}
      {kind === "prefix" && (
        <span className="help">e.g. entering <span className="mono">prod-</span> turns{" "}
          <span className="mono">prod-checkout</span> into <span className="mono">checkout</span></span>
      )}
      {kind === "after" && (
        <span className="help">e.g. entering <span className="mono">.</span> turns{" "}
          <span className="mono">checkout.internal.eu</span> into <span className="mono">checkout</span></span>
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

// Postgres column selection as a checklist (once discover knows the table's columns). Emits the
// same comma-separated string the API uses: all columns checked -> "" (SELECT *); a subset ->
// "a,b,c". The cursor/key/time columns are always pulled, so they're shown checked + locked.
function ColumnPicker({ columns, value, mandatory, onChange }: {
  columns: string[]; value: string; mandatory: Set<string>; onChange: (v: string) => void;
}) {
  const [q, setQ] = useState("");
  const listed = value.trim()
    ? new Set(value.split(",").map((s) => s.trim()).filter(Boolean))
    : null;   // null = "all"
  const isChecked = (c: string) => mandatory.has(c) || listed === null || listed.has(c);
  const emit = (checked: Set<string>) => {
    mandatory.forEach((m) => checked.add(m));
    onChange(checked.size >= columns.length ? "" : columns.filter((c) => checked.has(c)).join(","));
  };
  const toggle = (c: string) => {
    const checked = new Set(columns.filter(isChecked));
    checked.has(c) ? checked.delete(c) : checked.add(c);
    emit(checked);
  };
  const nChecked = columns.filter(isChecked).length;
  const shown = columns.filter((c) => !q || c.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <div className="btnrow" style={{ marginBottom: 6, alignItems: "center" }}>
        <button type="button" onClick={() => onChange("")}>All</button>
        <button type="button" onClick={() => emit(new Set())}>None</button>
        <span className="help">
          {nChecked}/{columns.length} selected{nChecked >= columns.length ? " — pulls every column" : ""}
        </span>
      </div>
      {columns.length > 8 && (
        <input type="text" placeholder="filter columns…" value={q}
               onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 6 }} />
      )}
      <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 6, padding: 4 }}>
        {shown.map((c) => (
          <label key={c} className="explore-item"
                 style={{ cursor: mandatory.has(c) ? "default" : "pointer", opacity: mandatory.has(c) ? 0.7 : 1 }}>
            <input type="checkbox" checked={isChecked(c)} disabled={mandatory.has(c)}
                   onChange={() => toggle(c)} style={{ marginRight: 8 }} />
            <span className="mono">{c}</span>
            {mandatory.has(c) && <span className="badge push" style={{ marginLeft: 8 }} title="cursor/key/time — always pulled">always</span>}
          </label>
        ))}
      </div>
    </div>
  );
}

// Table-shaped discover result (postgres): every column with its type, badged with the role the
// proposal assigns it (cursor / key / label), so the user sees the possible values before applying.
function ColumnsProposalView({ proposal, onApply }: { proposal: ColumnsProposal; onApply: () => void }) {
  const cfg = proposal.proposed_config as { cursor_column?: string; key_column?: string;
                                            labels?: { field?: string }[] };
  const labelFields = new Set((cfg.labels ?? []).map((l) => l.field).filter(Boolean));
  const role = (col: string) =>
    col === cfg.cursor_column ? "cursor" : col === cfg.key_column ? "key"
      : labelFields.has(col) ? "label" : "";
  return (
    <div style={{ marginTop: 12 }}>
      <p className="subtitle" style={{ marginTop: 0 }}>{proposal.summary}</p>
      <table>
        <thead><tr><th>column</th><th style={{ width: 180 }}>type</th><th style={{ width: 90 }}>proposed as</th></tr></thead>
        <tbody>
          {proposal.columns.map((c) => (
            <tr key={c.name}>
              <td className="mono">{c.name}</td>
              <td className="help">{c.type}</td>
              <td>{role(c.name) && <span className="chip">{role(c.name)}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="primary" style={{ marginTop: 10 }} onClick={onApply}>
        Apply to form
      </button>
      <span className="help" style={{ marginLeft: 10 }}>
        fills the fields below — review, Test connection, then Create
      </span>
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

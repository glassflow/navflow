import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api";
import { TimeAgo } from "./bits";
import type { ChallengerSession, TimelineEventRow, UsecaseSummary } from "../types";

// The challenger workflow's own panels on the use case page: the sessions Codex challenged (with
// the plan and commit verdicts, and the Claude/Codex exchange as one thread) and the summarizer's
// memory proposals with accept / reject. A proposal is text inside a finding until the user
// accepts it; accept is the only thing that writes memory, so the plugin only ever hands Claude
// what a person chose to keep.

// Codex's verdict word stays in the data (the `verdict` label); on screen we say what happened.
// "FAIL" elsewhere in the console means a run or delivery that did not work; here the review
// worked and found things.
function verdictClass(v: string | undefined | null) {
  return v === "PASS" ? "ok" : v === "FAIL" ? "paused" : "blanked";
}
function verdictText(v: string | undefined | null, findings?: string | number, blocking?: string | number) {
  if (v === "PASS") return "no findings";
  if (v === "FAIL") {
    const n = Number(findings), b = Number(blocking);
    if (!Number.isFinite(n) || n <= 0) return "findings";
    return `${n} finding${n === 1 ? "" : "s"}` + (Number.isFinite(b) && b > 0 ? `, ${b} blocking` : "");
  }
  return "no verdict";
}

function Verdict({ v, findings, blocking, compact, what }: {
  v: string | undefined | null; findings?: string | number; blocking?: string | number;
  compact?: boolean;   // the collapsed row: just the finding count, wording on hover
  what?: string;
}) {
  if (!v) return <span className="dim">{compact ? "none" : "not reviewed"}</span>;
  const text = verdictText(v, findings, blocking);
  const title = `${what ? what + ": " : ""}${text} (Codex verdict ${v})`;
  if (compact) {
    const n = Number(findings);
    const label = v === "PASS" ? "Pass" : v === "FAIL" ? `Findings (${Number.isFinite(n) ? n : "?"})` : "No verdict";
    return <span className={`badge ${verdictClass(v)}`} title={title}>{label}</span>;
  }
  return <span className={`badge ${verdictClass(v)}`} title={title}>{text}</span>;
}

export function SessionsPanel({ sessions, view, onSummarize, busy, message }: {
  sessions: ChallengerSession[]; view: string;
  onSummarize?: (session: string) => Promise<unknown>; busy?: boolean; message?: string;
}) {
  const [open, setOpen] = useState<string>();
  if (!sessions.length) {
    return (
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Sessions</h2>
        <div className="empty">
          no challenger sessions yet; in Claude Code run <span className="mono">/tares:challenger</span>, then leave plan mode or commit
        </div>
      </div>
    );
  }
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Sessions</h2>
      <table>
        <thead><tr><th>when</th><th>repo</th><th>branch</th><th title="findings on the plan">plan</th><th title="findings per reviewed commit, in order">commits</th><th>state</th><th aria-label="actions" /></tr></thead>
        <tbody>
          {sessions.map((x) => (
            <tr key={x.session} style={{ cursor: "pointer" }} onClick={() => setOpen(open === x.session ? undefined : x.session)}>
              <td style={{ whiteSpace: "nowrap" }}><TimeAgo ts={x.started_at ?? null} /></td>
              <td className="mono">{x.repo ?? <span className="dim">unknown</span>}</td>
              <td className="mono">{x.branch ?? ""}</td>
              <td><Verdict compact what="plan" v={x.plan_verdict} findings={x.plan_findings ?? undefined} blocking={x.plan_blocking ?? undefined} /></td>
              <td>
                {x.commits.length === 0 ? <span className="dim">none</span> : (
                  <span className="tl-labels">
                    {x.commits.map((c, i) => <Verdict key={i} compact v={c.verdict} findings={c.findings} blocking={c.blocking}
                                                       what={`commit ${c.sha ?? "?"}${c.round ? `, round ${c.round}` : ""}`} />)}
                  </span>
                )}
                {x.waived > 0 && <span className="help"> · {x.waived} waived</span>}
              </td>
              <td>
                {x.ended ? (x.run_id ? <span className="badge ok">summarized</span> : <span className="badge paused">ended</span>)
                  : <span className="badge agent">live</span>}
              </td>
              <td onClick={(e) => e.stopPropagation()}>
                {onSummarize && (
                  <div className="btnrow" style={{ justifyContent: "flex-end" }}>
                    <button disabled={busy} onClick={() => onSummarize(x.session)}
                            title={x.run_id ? "run the summarizer again on this session" : "summarize this session now, without waiting for it to end"}>
                      {busy ? "working…" : x.run_id ? "Summarize again" : "Summarize"}
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {message && <p className="help" style={{ margin: "8px 0 0" }}>{message}</p>}
      {open && sessions.find((x) => x.session === open) && (
        <SessionThread s={sessions.find((x) => x.session === open)!} view={view} onClose={() => setOpen(undefined)} />
      )}
    </div>
  );
}

function SessionThread({ s, view, onClose }: { s: ChallengerSession; view: string; onClose: () => void }) {
  const [all, setAll] = useState(false);
  const [rows, setRows] = useState<TimelineEventRow[]>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    if (!all) return;
    let live = true;
    setRows(undefined); setErr(undefined);
    api.runQueryWhere(view, { key_value: s.session }, "30d")
      .then((r) => { if (live) setRows(r.rows ?? []); })
      .catch((e) => { if (live) setErr(String((e as Error).message ?? e)); });
    return () => { live = false; };
  }, [all, s.session, view]);

  const blocking = s.commits.reduce((n, c) => n + (Number(c.blocking) || 0), 0);
  return (
    <div style={{ marginTop: 14 }}>
      <div className="tl-head">
        <div>
          <h3 style={{ margin: 0 }}><span className="mono">{s.repo ?? s.session}</span>{s.branch && <span className="help"> on {s.branch}</span>}</h3>
          <span className="subtitle" style={{ margin: 0 }}>
            challenger session · plan <Verdict v={s.plan_verdict} findings={s.plan_findings ?? undefined} blocking={s.plan_blocking ?? undefined} /> · {s.commits.length} commit{s.commits.length === 1 ? "" : "s"} reviewed
            {blocking > 0 && <> · {blocking} blocking finding{blocking === 1 ? "" : "s"}</>}
            {s.waived > 0 && <> · {s.waived} waived</>}
            {s.run_id && <> · <Link to={`/agents/challenger_summarizer?run=${encodeURIComponent(s.run_id)}`}>summary</Link></>}
          </span>
        </div>
        <div className="btnrow">
          <div className="seg small">
            <button className={!all ? "active" : ""} onClick={() => setAll(false)}>challenges only</button>
            <button className={all ? "active" : ""} onClick={() => setAll(true)}>whole session</button>
          </div>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
      {err && <div className="alert error">{err}</div>}
      {!all ? (
        s.thread.length ? (
          <table style={{ marginTop: 10 }}>
            <thead><tr><th style={{ width: 90 }}>when</th><th>event</th></tr></thead>
            <tbody>
              {s.thread.map((t, i) => (
                <tr key={i}>
                  <td style={{ whiteSpace: "nowrap" }}><TimeAgo ts={t.at} /></td>
                  <td>
                    <span className="mono" style={{ whiteSpace: "pre-wrap" }}>{t.text}</span>
                    {t.labels.verdict && <span className="tl-labels"><Verdict v={t.labels.verdict} findings={t.labels.finding_count} blocking={t.labels.blocking_count} /></span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="empty">no challenge events in this session yet</div>
      ) : rows === undefined && !err ? <div className="help" style={{ marginTop: 10 }}>reading session…</div>
        : rows && rows.length ? (
          <table style={{ marginTop: 10 }}>
            <thead><tr><th style={{ width: 74 }}>when</th><th>event</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="mono dim" style={{ whiteSpace: "nowrap" }}>{r.offset}</td>
                  <td><span className="mono" style={{ whiteSpace: "pre-wrap" }}>{r.text}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : rows && <div className="empty">the view holds nothing for this session in the last 30 days</div>}
    </div>
  );
}

type Decision = "accepted" | "rejected";
type Row = { runId: string; i: number; repo: string; text: string; agent: string; started_at?: string; decision?: Decision };

export function ProposalsPanel({ runs }: { runs: NonNullable<UsecaseSummary["runs"]> }) {
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  // decided locally this render cycle, until the next poll brings the state back from Tares
  const [local, setLocal] = useState<Record<string, Decision>>({});
  const rows: Row[] = runs.flatMap((r) => (r.id && r.proposals ? r.proposals : []).map((text, i) => ({
    runId: r.id!, i, repo: r.repo ?? "", text, agent: r.agent ?? "challenger_summarizer",
    started_at: r.started_at, decision: local[`${r.id}:${i}`] ?? r.decisions?.[String(i)],
  })));
  if (!rows.length) return null;
  const open = rows.filter((x) => !x.decision);
  const done = rows.filter((x) => x.decision);

  const decide = async (x: Row, d: Decision) => {
    const k = `${x.runId}:${x.i}`;
    setBusy(k); setErr(undefined);
    try {
      await api.remember({ key: x.repo, content: x.text, memory_type: d === "accepted" ? "decision" : "rejected_proposal" });
      setLocal({ ...local, [k]: d });
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    setBusy(undefined);
  };

  const cell = (x: Row) => (
    <td className="mono" style={{ whiteSpace: "nowrap" }}>
      {x.repo || <span className="dim" title="the session's repo is unknown, so accept has no key">unknown</span>}
      <div><Link to={`/agents/${encodeURIComponent(x.agent)}?run=${encodeURIComponent(x.runId)}`} className="help"><TimeAgo ts={x.started_at ?? null} /></Link></div>
    </td>
  );

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Memory proposals</h2>
      <p className="help" style={{ marginTop: 0 }}>
        What the summarizer thinks is worth remembering about a repo. Accept stores it as a decision
        on the memory source, keyed by the repo, and the plugin hands it to Claude at the start of
        the next session there. Reject keeps it out of memory for good.
      </p>
      {err && <div className="alert error">{err}</div>}
      {open.length ? (
        <table>
          <thead><tr><th>repo</th><th>proposal</th><th aria-label="decision" /></tr></thead>
          <tbody>
            {open.map((x) => (
              <tr key={`${x.runId}:${x.i}`}>
                {cell(x)}
                <td style={{ whiteSpace: "pre-wrap" }}>{x.text}</td>
                <td>
                  <div className="btnrow" style={{ justifyContent: "flex-end" }}>
                    <button className="primary" disabled={!x.repo || busy === `${x.runId}:${x.i}`} onClick={() => decide(x, "accepted")}>
                      {busy === `${x.runId}:${x.i}` ? "saving…" : "Accept"}
                    </button>
                    <button disabled={!x.repo || busy === `${x.runId}:${x.i}`} onClick={() => decide(x, "rejected")}>Reject</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div className="empty">nothing waiting for a decision</div>}
      {done.length > 0 && (
        <details className="uc-how" style={{ marginTop: 10 }}>
          <summary>{done.length} decided</summary>
          <table style={{ marginTop: 8 }}>
            <tbody>
              {done.map((x) => (
                <tr key={`${x.runId}:${x.i}`}>
                  {cell(x)}
                  <td style={{ whiteSpace: "pre-wrap" }}>{x.text}</td>
                  <td>{x.decision === "accepted" ? <span className="badge ok">accepted</span> : <span className="help">rejected</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

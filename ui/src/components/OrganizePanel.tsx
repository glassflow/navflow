import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { api, anthropicKey, authHeader } from "../api";

// The Organize agent (docs/design/organize-agent.md): one button on the Sources page starts an
// agent run that inspects the data and streams PROPOSAL cards — labels for a source, a view across
// sources. The agent mutates nothing; each card is applied (via the normal management APIs) or
// skipped by the user, right here. Conversation continues for refinements.

type LabelSpec = { name: string; field?: string; const?: string; primary?: boolean;
                   pattern?: string; replace?: string; map?: Record<string, string> };
type Proposal =
  | { id: string; kind: "labels"; source: string; labels: LabelSpec[]; reasoning: string }
  | { id: string; kind: "view"; name: string; key_field: string; sources: string[];
      filters?: Array<Record<string, unknown>>; reasoning: string };
type Part =
  | { type: "text"; text: string }
  | { type: "tool"; name: string }
  | { type: "proposal"; proposal: Proposal };
type Msg = { role: "user" | "assistant"; parts: Part[] };
type Decision = "applied" | "skipped" | "error";

const KICKOFF =
  "Organize my data: review my sources and propose the labels/keys each should have and the " +
  "views that would serve agents best.";

export default function OrganizePanel({ onCatalogChanged }: { onCatalogChanged?: () => void }) {
  const [serverKey, setServerKey] = useState<boolean>();
  const [key, setKey] = useState(anthropicKey.get());
  const [keyInput, setKeyInput] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [decisions, setDecisions] = useState<Record<string, { status: Decision; detail?: string }>>({});
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const startedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    api.capabilities().then((c) => setServerKey(!!c.agent_key_configured)).catch(() => setServerKey(false));
  }, []);

  // auto-start the sweep once a usable key exists
  useEffect(() => {
    if (serverKey === undefined || startedRef.current) return;
    if (serverKey || key) { startedRef.current = true; void send(KICKOFF); }
  }, [serverKey, key]);

  const mutLast = (fn: (parts: Part[]) => Part[]) =>
    setMsgs((cur) => cur.map((m, i) => (i === cur.length - 1 ? { ...m, parts: fn(m.parts) } : m)));

  // History for the model: text plus a compact textual record of proposals and what the user did
  // with them, so follow-up turns know the state.
  const historyText = (m: Msg) => m.parts.map((p) => {
    if (p.type === "text") return p.text;
    if (p.type === "proposal") {
      const st = decisions[p.proposal.id]?.status ?? "pending";
      const what = p.proposal.kind === "labels"
        ? `labels for source ${p.proposal.source}` : `view ${p.proposal.name}`;
      return `\n[proposal: ${what} — ${st}]\n`;
    }
    return "";
  }).join("");

  async function send(text: string) {
    if (!text.trim() || busy) return;
    setInput("");
    const history: Msg[] = [...msgs, { role: "user", parts: [{ type: "text", text }] }];
    setMsgs([...history, { role: "assistant", parts: [] }]);
    setBusy(true);
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const res = await fetch("/api/agent/chat", {
        method: "POST",
        signal: ctl.signal,
        headers: { "content-type": "application/json",
                   ...(key ? { "X-Anthropic-Key": key } : {}), ...authHeader() },
        body: JSON.stringify({
          mode: "organize",
          messages: history.map((m) => ({ role: m.role, content: historyText(m) })),
        }),
      });
      if (!res.ok || !res.body) {
        mutLast((p) => [...p, { type: "text", text: `⚠️ ${res.statusText}` }]);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          if (!chunk.startsWith("data: ")) continue;
          const e = JSON.parse(chunk.slice(6));
          if (e.type === "text") {
            mutLast((parts) => {
              const last = parts[parts.length - 1];
              if (last?.type === "text") return [...parts.slice(0, -1), { type: "text", text: last.text + e.text }];
              return [...parts, { type: "text", text: e.text }];
            });
          } else if (e.type === "tool") {
            mutLast((p) => [...p, { type: "tool", name: e.name }]);
          } else if (e.type === "proposal") {
            const proposal = { id: e.id, kind: e.kind, ...e.payload } as Proposal;
            mutLast((p) => [...p, { type: "proposal", proposal }]);
          } else if (e.type === "error") {
            mutLast((p) => [...p, { type: "text", text: `\n\n⚠️ ${e.detail}` }]);
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // user hit Stop: cancelling the fetch tears down the SSE stream, which cancels the
        // server-side agent loop mid-flight. Already-proposed cards stay reviewable.
        mutLast((p) => [...p, { type: "text", text: "\n\n⏹ stopped — proposals so far are still reviewable" }]);
      } else {
        mutLast((p) => [...p, { type: "text", text: `\n\n⚠️ ${String((err as Error).message ?? err)}` }]);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  const decide = (id: string, status: Decision, detail?: string) =>
    setDecisions((d) => ({ ...d, [id]: { status, detail } }));

  const applyLabels = async (p: Extract<Proposal, { kind: "labels" }>) => {
    try {
      const src = await api.source(p.source);
      await api.updateSource(p.source, {
        name: src.name, type: src.type, connector: src.connector, poll: src.poll,
        config: { ...src.config, labels: p.labels },
      });
      decide(p.id, "applied");
      onCatalogChanged?.();
    } catch (e) { decide(p.id, "error", String((e as Error).message ?? e)); }
  };

  const applyView = async (p: Extract<Proposal, { kind: "view" }>) => {
    try {
      await api.createView({ name: p.name, key_field: p.key_field,
                             sources: p.sources, filters: (p.filters ?? []) as never });
      decide(p.id, "applied");
      onCatalogChanged?.();
    } catch (e) { decide(p.id, "error", String((e as Error).message ?? e)); }
  };

  if (serverKey === undefined) return <div className="panel"><span className="dim">loading…</span></div>;

  if (!serverKey && !key) {
    return (
      <div className="panel" style={{ maxWidth: 560 }}>
        <h2 style={{ marginTop: 0 }}>Organize needs an Anthropic API key</h2>
        <p className="help" style={{ whiteSpace: "normal" }}>
          This instance has no server-provisioned key, so the agent runs on yours — sent per
          request, kept in this browser, never stored on the server.
        </p>
        <form onSubmit={(e) => { e.preventDefault(); if (keyInput.trim()) { anthropicKey.set(keyInput.trim()); setKey(keyInput.trim()); } }}>
          <input type="password" placeholder="sk-ant-…" value={keyInput}
                 onChange={(e) => setKeyInput(e.target.value)}
                 style={{ width: "100%", boxSizing: "border-box", padding: "0.5rem 0.7rem" }} autoFocus />
          <div className="btnrow" style={{ marginTop: 12 }}>
            <button className="primary" disabled={!keyInput.trim()}>Save key &amp; start</button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="pagehead" style={{ marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>✨ Organize</h2>
        {busy && (
          <button className="danger" onClick={() => abortRef.current?.abort()}>⏹ Stop</button>
        )}
      </div>
      <p className="help" style={{ whiteSpace: "normal", marginTop: 0 }}>
        The agent inspects your data and proposes labels and views — nothing is changed until you
        apply a card. Labels apply to events going forward.
      </p>

      {msgs.map((m, i) => m.role === "user" ? null : (
        <div key={i}>
          {m.parts.map((p, j) => {
            if (p.type === "tool") {
              return <div key={j} className="toolcall">→ <span className="mono">{p.name}</span></div>;
            }
            if (p.type === "text") {
              return <div key={j} className="md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{p.text}</ReactMarkdown></div>;
            }
            return <ProposalCard key={j} proposal={p.proposal}
                                 decision={decisions[p.proposal.id]}
                                 onApply={() => p.proposal.kind === "labels"
                                   ? applyLabels(p.proposal) : applyView(p.proposal)}
                                 onSkip={() => decide(p.proposal.id, "skipped")} />;
          })}
          {busy && i === msgs.length - 1 && m.parts.length === 0 && <div className="dim">inspecting your data…</div>}
        </div>
      ))}

      {!busy && msgs.length > 0 && (
        <form className="btnrow" style={{ marginTop: 12 }}
              onSubmit={(e) => { e.preventDefault(); void send(input); }}>
          <input value={input} placeholder="refine — e.g. 'key claude_code by project instead'"
                 style={{ flex: 1 }} onChange={(e) => setInput(e.target.value)} />
          <button className="primary" disabled={!input.trim()}>Send</button>
        </form>
      )}
    </div>
  );
}

/** The hard evidence for a proposed value merge: the actual before→after table computed against
 *  the source's observed values (same stateless preview endpoint the label editor uses). */
function NormPreview({ source, label }: { source: string; label: LabelSpec }) {
  const [preview, setPreview] = useState<{ sampled: number; distinct_before: number;
    distinct_after: number; results: { from: string; to: string; events: number }[] }>();
  const [err, setErr] = useState<string>();

  useEffect(() => {
    api.labelPreview(source, label as Record<string, unknown>)
      .then(setPreview)
      .catch((e) => setErr(String((e as Error).message ?? e)));
  }, [source, JSON.stringify(label)]);

  if (err) return <div className="alert error">merge preview failed: {err}</div>;
  if (!preview) return <div className="dim" style={{ marginBottom: 8 }}>computing merge preview…</div>;
  const merges = preview.results.filter((r) => r.from !== r.to);
  return (
    <div style={{ margin: "0 0 10px" }}>
      <span className="help">
        <span className="mono">{label.name}</span>: {preview.distinct_before} value{preview.distinct_before === 1 ? "" : "s"} →{" "}
        <strong>{preview.distinct_after}</strong> after this merge ({preview.sampled} events sampled)
        {merges.length === 0 && <> — <strong>no observed value actually changes</strong></>}
      </span>
      {merges.length > 0 && (
        <table style={{ marginTop: 6 }}>
          <thead><tr><th>value seen</th><th className="num">events</th><th>will become</th></tr></thead>
          <tbody>
            {merges.slice(0, 8).map((r, k) => (
              <tr key={k}>
                <td className="mono">{r.from}</td>
                <td className="num">{r.events}</td>
                <td className="mono"><span className="badge ok" style={{ marginRight: 6 }}>→</span>{r.to}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ProposalCard({ proposal, decision, onApply, onSkip }: {
  proposal: Proposal; decision?: { status: Decision; detail?: string };
  onApply: () => void; onSkip: () => void;
}) {
  const st = decision?.status;
  return (
    <div className="card" style={{ margin: "10px 0", padding: 14, opacity: st === "skipped" ? 0.55 : 1 }}>
      <div className="pagehead" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>
          {proposal.kind === "labels"
            ? <>Labels for <span className="mono">{proposal.source}</span></>
            : <>View <span className="mono">{proposal.name}</span></>}
        </h3>
        {st === "applied" && <span className="badge ok">applied</span>}
        {st === "skipped" && <span className="badge starting">skipped</span>}
        {st === "error" && <span className="badge error">failed</span>}
      </div>

      {proposal.kind === "labels" ? (
        <table style={{ marginBottom: 8 }}>
          <thead><tr><th>label</th><th>from</th></tr></thead>
          <tbody>
            {proposal.labels.map((l) => (
              <tr key={l.name}>
                <td className="mono">{l.name}{l.primary && <span className="badge ok" style={{ marginLeft: 8 }}>key</span>}</td>
                <td className="mono">
                  {l.field != null
                    ? <><span className="badge push" style={{ marginRight: 8 }}>field</span>{l.field}</>
                    : <><span className="badge push" style={{ marginRight: 8 }}>const</span>{String(l.const ?? "")}</>}
                  {(l.pattern || l.map) && (
                    <div className="help">
                      normalize: {l.pattern && <>s/<span className="mono">{l.pattern}</span>/<span className="mono">{l.replace ?? ""}</span>/</>}
                      {l.pattern && l.map ? " · " : ""}
                      {l.map && `${Object.keys(l.map).length} alias(es)`}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p style={{ margin: "0 0 8px" }}>
          key <span className="chip mono">{proposal.key_field}</span> over{" "}
          {proposal.sources.map((s) => <span className="chip mono" key={s}>{s}</span>)}
          {!!proposal.filters?.length && <> · {proposal.filters.length} filter(s)</>}
        </p>
      )}

      {proposal.kind === "labels" && proposal.labels
        .filter((l) => l.field && (l.pattern || l.map))
        .map((l) => <NormPreview key={l.name} source={proposal.source} label={l} />)}

      <p className="help" style={{ whiteSpace: "normal", margin: "0 0 10px" }}>{proposal.reasoning}</p>
      {decision?.detail && <div className="alert error">{decision.detail}</div>}

      {!st && (
        <div className="btnrow">
          <button className="primary" onClick={onApply}>Apply</button>
          <button onClick={onSkip}>Skip</button>
        </div>
      )}
      {st === "error" && (
        <div className="btnrow">
          <button className="primary" onClick={onApply}>Retry</button>
          <button onClick={onSkip}>Skip</button>
        </div>
      )}
    </div>
  );
}

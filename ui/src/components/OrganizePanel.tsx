import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { api, anthropicKey, authHeader } from "../api";
import { applyProposal, ProposalCard } from "./proposals";
import type { DecisionMap, Proposal } from "./proposals";

// The Organize agent (docs/design/organize-agent.md): one button on the Sources page starts an
// agent run that inspects the data and streams PROPOSAL cards — labels for a source, a view across
// sources. The agent mutates nothing; each card is applied (via the normal management APIs) or
// skipped by the user, right here. Conversation continues for refinements.

type Part =
  | { type: "text"; text: string }
  | { type: "tool"; name: string }
  | { type: "proposal"; proposal: Proposal };
type Msg = { role: "user" | "assistant"; parts: Part[] };

const KICKOFF =
  "Organize my data: review my sources and propose the labels/keys each should have and the " +
  "views that would serve agents best.";

export default function OrganizePanel({ onCatalogChanged, intent }:
  { onCatalogChanged?: () => void; intent?: string }) {
  const [serverKey, setServerKey] = useState<boolean>();
  const [key, setKey] = useState(anthropicKey.get());
  const [keyInput, setKeyInput] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [decisions, setDecisions] = useState<DecisionMap>({});
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const startedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    api.capabilities().then((c) => setServerKey(!!c.agent_key_configured)).catch(() => setServerKey(false));
  }, []);

  // auto-start once a usable key exists — with the user's stated goal when one was given
  useEffect(() => {
    if (serverKey === undefined || startedRef.current) return;
    if (serverKey || key) { startedRef.current = true; void send(intent?.trim() || KICKOFF); }
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
        ? `labels for source ${p.proposal.source}`
        : p.proposal.kind === "view" ? `view ${p.proposal.name}` : `trigger ${p.proposal.name}`;
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

  const decide = (id: string, status: "applied" | "skipped" | "error", detail?: string) =>
    setDecisions((d) => ({ ...d, [id]: { status, detail } }));

  const apply = async (p: Proposal) => {
    try {
      await applyProposal(p);
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
                                 onApply={() => apply(p.proposal)}
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

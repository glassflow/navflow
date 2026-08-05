import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { api, anthropicKey, authHeader } from "../api";
import { applyProposal, ProposalCard } from "./proposals";
import type { DecisionMap, Proposal } from "./proposals";

// The Ask assistant, extracted so it can back both the dedicated /ask page and the global ⌘K
// command palette. Same engine, two doors: the page for long sessions, the overlay to ask from
// anywhere without losing your place.

type Part = { type: "text"; text: string } | { type: "tool"; name: string; input: unknown }
  | { type: "proposal"; proposal: Proposal };
type Msg = { role: "user" | "assistant"; parts: Part[] };

const STARTERS: { mode: "explore" | "debug"; title: string; prompts: string[] }[] = [
  {
    mode: "explore", title: "Explore the data",
    prompts: [
      "What sources am I ingesting, and what does each one contain?",
      "Summarize the shape and structure of my data.",
      "What entities exist and how many events does each have?",
    ],
  },
  {
    mode: "debug", title: "Debug something",
    prompts: [
      "Is anything not ingesting, empty, or sparse? What looks off?",
      "Why might one of my entities show almost no events?",
      "What data is stale or unusually low-volume?",
    ],
  },
];

const textOf = (m: Msg, decisions?: DecisionMap) =>
  m.parts.map((p) => {
    if (p.type === "text") return p.text;
    if (p.type === "proposal") {
      const st = decisions?.[p.proposal.id]?.status ?? "pending";
      const what = p.proposal.kind === "labels"
        ? `labels for source ${p.proposal.source}`
        : p.proposal.kind === "view" ? `view ${p.proposal.name}` : `trigger ${p.proposal.name}`;
      return `\n[proposal: ${what} — ${st}]\n`;
    }
    return "";
  }).join("");

function compact(v: unknown): string {
  const s = JSON.stringify(v);
  return s === "{}" ? "" : s.length > 60 ? s.slice(0, 60) + "…" : s;
}

export default function AskChat() {
  const [key, setKeyState] = useState(anthropicKey.get());
  const [keyInput, setKeyInput] = useState("");
  // A hosted cell can carry a server-provisioned key — then the console never prompts.
  const [serverKey, setServerKey] = useState<boolean>();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [decisions, setDecisions] = useState<DecisionMap>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    api.capabilities().then((c) => setServerKey(!!c.agent_key_configured)).catch(() => setServerKey(false));
  }, []);

  if (serverKey === undefined) return <div className="dim">loading…</div>;
  if (!key && !serverKey) {
    return <KeySetup onSave={(k) => { anthropicKey.set(k); setKeyState(k); }}
                     value={keyInput} onChange={setKeyInput} />;
  }

  const mutLast = (fn: (parts: Part[]) => Part[]) =>
    setMsgs((cur) => cur.map((m, i) => (i === cur.length - 1 ? { ...m, parts: fn(m.parts) } : m)));
  const appendText = (t: string) => mutLast((parts) => {
    const last = parts[parts.length - 1];
    if (last && last.type === "text") return [...parts.slice(0, -1), { type: "text", text: last.text + t }];
    return [...parts, { type: "text", text: t }];
  });
  const addTool = (name: string, inputv: unknown) => mutLast((parts) => [...parts, { type: "tool", name, input: inputv }]);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    setInput("");
    const history: Msg[] = [...msgs, { role: "user", parts: [{ type: "text", text }] }];
    setMsgs([...history, { role: "assistant", parts: [] }]);
    setBusy(true);
    const scroll = () => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
    try {
      const res = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "content-type": "application/json",
                   ...(key ? { "X-Anthropic-Key": key } : {}), ...authHeader() },
        body: JSON.stringify({ messages: history.map((m) => ({ role: m.role, content: textOf(m, decisions) })) }),
      });
      if (!res.ok || !res.body) {
        appendText(`⚠️ ${await res.text().catch(() => res.statusText)}`);
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
          if (e.type === "text") appendText(e.text);
          else if (e.type === "tool") addTool(e.name, e.input);
          else if (e.type === "proposal") {
            const proposal = { id: e.id, kind: e.kind, ...e.payload } as Proposal;
            mutLast((parts) => [...parts, { type: "proposal", proposal }]);
          }
          else if (e.type === "error") appendText(`\n\n⚠️ ${e.detail}`);
        }
        scroll();
      }
    } catch (err) {
      appendText(`\n\n⚠️ ${String((err as Error).message ?? err)}`);
    } finally {
      setBusy(false);
      scroll();
    }
  }

  const decide = (id: string, status: "applied" | "skipped" | "error", detail?: string) =>
    setDecisions((d) => ({ ...d, [id]: { status, detail } }));
  const apply = async (p: Proposal) => {
    try { await applyProposal(p); decide(p.id, "applied"); }
    catch (e) { decide(p.id, "error", String((e as Error).message ?? e)); }
  };

  return (
    <div className="askchat">
      <div className="chat-tools">
        {key
          ? <button className="dim" onClick={() => { anthropicKey.clear(); setKeyState(""); }}>change key</button>
          : <span className="dim">using this instance&rsquo;s key</span>}
      </div>

      <div className="chat" ref={scrollRef}>
        {msgs.length === 0 && (
          <div className="starters">
            {STARTERS.map((g) => (
              <div key={g.mode} className="starter-group">
                <div className="help">{g.title}</div>
                {g.prompts.map((p) => (
                  <button key={p} className="starter" onClick={() => send(p)}>{p}</button>
                ))}
              </div>
            ))}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.role === "user"
              ? <div className="bubble-text">{textOf(m)}</div>
              : m.parts.map((p, j) => p.type === "tool"
                ? <div key={j} className="toolcall">→ <span className="mono">{p.name}</span>(<span className="mono">{compact(p.input)}</span>)</div>
                : p.type === "proposal"
                ? <ProposalCard key={j} proposal={p.proposal} decision={decisions[p.proposal.id]}
                                onApply={() => apply(p.proposal)}
                                onSkip={() => decide(p.proposal.id, "skipped")} />
                : <div key={j} className="md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{p.text}</ReactMarkdown></div>)}
            {busy && i === msgs.length - 1 && m.parts.length === 0 && <div className="dim">thinking…</div>}
          </div>
        ))}
      </div>

      <form className="askbar" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <input value={input} placeholder="ask about your data…" disabled={busy} autoFocus
               onChange={(e) => setInput(e.target.value)} />
        <button className="primary" disabled={busy || !input.trim()}>{busy ? "…" : "Send"}</button>
      </form>
    </div>
  );
}

function KeySetup({ value, onChange, onSave }:
  { value: string; onChange: (s: string) => void; onSave: (k: string) => void }) {
  return (
    <div className="panel" style={{ maxWidth: 560 }}>
      <h2 style={{ marginTop: 0 }}>Add your Anthropic API key</h2>
      <p className="help" style={{ whiteSpace: "normal" }}>
        The assistant runs on your Tares daemon using your key. The key is sent to this instance
        with each request and used transiently — it is <strong>not stored on the server</strong>;
        it's kept in this browser. Get one at{" "}
        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com</a>.
      </p>
      <form onSubmit={(e) => { e.preventDefault(); if (value.trim()) onSave(value.trim()); }}>
        <input type="password" placeholder="sk-ant-…" value={value}
               onChange={(e) => onChange(e.target.value)}
               style={{ width: "100%", boxSizing: "border-box", padding: "0.5rem 0.7rem" }} autoFocus />
        <div className="btnrow" style={{ marginTop: 12 }}>
          <button className="primary" disabled={!value.trim()}>Save key</button>
        </div>
      </form>
    </div>
  );
}

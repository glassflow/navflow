import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { api, authHeader } from "../api";
import { applyProposal, ProposalCard } from "./proposals";
import type { DecisionMap, Proposal } from "./proposals";

// The Ask assistant. Backs both the /ask page and the global ⌘K palette — the page for long
// sessions, the overlay to ask from anywhere without losing your place.
//
// There is no second "organize" surface any more. It sent the same tools to the same endpoint and
// differed only by a system prompt, so the judgement it carried (what makes a good key, labels come
// from real fields, watch for value variants) now applies to every proposal — see tares/agent.py.
// The full-source sweep it ran is a starter prompt below.

type Part = { type: "text"; text: string } | { type: "tool"; name: string; input: unknown }
  | { type: "proposal"; proposal: Proposal };
type Msg = { role: "user" | "assistant"; parts: Part[] };

const ORGANIZE_PROMPT =
  "Organize my data: inventory every source that has data, then propose the labels, keys and " +
  "views that would let me correlate it. Check existing labels first and don't duplicate them.";

const STARTERS: { title: string; prompts: string[] }[] = [
  {
    title: "Explore the data",
    prompts: [
      "What sources am I ingesting, and what does each one contain?",
      "What entities exist and how many events does each have?",
    ],
  },
  {
    title: "Debug something",
    prompts: [
      "Is anything not ingesting, empty, or sparse? What looks off?",
      "What data is stale or unusually low-volume?",
    ],
  },
  {
    title: "Organize it",
    prompts: [
      ORGANIZE_PROMPT,
      "Which of my labels would make bad entity keys, and why?",
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

/** How close to the bottom counts as "following along". Below this the reader has deliberately
 *  scrolled away and must not be dragged back. */
const STICK_PX = 120;

const nearBottom = () => {
  const el = document.scrollingElement || document.documentElement;
  return el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
};

export default function AskChat() {
  const [ready, setReady] = useState<boolean>();      // is a key configured on the server?
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [decisions, setDecisions] = useState<DecisionMap>({});
  // Follow the tail only while the reader is at the tail. The old code called scrollTo() on every
  // streamed chunk unconditionally, so scrolling up to re-read something was undone by the next
  // token and a long answer could not be read until it finished.
  const [stick, setStick] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refreshKey = () => api.capabilities()
    .then((c) => setReady(!!c.agent_key_configured)).catch(() => setReady(false));
  useEffect(() => { refreshKey(); }, []);

  // Detach ONLY on a deliberate upward scroll. Re-checking `nearBottom()` on every scroll event
  // isn't enough: streamed text lands between the programmatic scroll and the event, so the check
  // sees "not at the bottom", detaches, and the transcript stops following its own output.
  const lastTop = useRef(0);
  useEffect(() => {
    const onScroll = () => {
      const el = document.scrollingElement || document.documentElement;
      const scrolledUp = el.scrollTop < lastTop.current - 2;
      lastTop.current = el.scrollTop;
      if (scrolledUp) setStick(false);
      else if (nearBottom()) setStick(true);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (stick) endRef.current?.scrollIntoView({ block: "end" });
  }, [msgs, stick]);

  if (ready === undefined) return <div className="dim">loading…</div>;
  if (!ready) return <KeySetup onSaved={refreshKey} />;

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
    setStick(true);
    const history: Msg[] = [...msgs, { role: "user", parts: [{ type: "text", text }] }];
    setMsgs([...history, { role: "assistant", parts: [] }]);
    setBusy(true);
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const res = await fetch("/api/agent/chat", {
        method: "POST",
        signal: ctl.signal,
        headers: { "content-type": "application/json", ...authHeader() },
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
      }
    } catch (err) {
      // An aborted run is the user pressing Stop, not a failure to report.
      if ((err as Error).name !== "AbortError") {
        appendText(`\n\n⚠️ ${String((err as Error).message ?? err)}`);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
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
      <div className="chat">
        {msgs.length === 0 && (
          <div className="starters">
            {STARTERS.map((g) => (
              <div key={g.title} className="starter-group">
                <div className="help">{g.title}</div>
                {g.prompts.map((p) => (
                  <button key={p} className="starter" onClick={() => send(p)}>{p}</button>
                ))}
              </div>
            ))}
          </div>
        )}
        {msgs.map((m, i) => (
          <Turn key={i} msg={m} decisions={decisions} apply={apply} decide={decide}
                thinking={busy && i === msgs.length - 1 && m.parts.length === 0} />
        ))}
        <div ref={endRef} />
      </div>

      {!stick && msgs.length > 0 && (
        <div className="jump-latest-wrap">
          <button className="jump-latest"
                  onClick={() => { setStick(true); endRef.current?.scrollIntoView({ block: "end" }); }}>
            ↓ latest
          </button>
        </div>
      )}

      <form className="askbar" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <input value={input} placeholder="ask about your data…" disabled={busy} autoFocus
               onChange={(e) => setInput(e.target.value)} />
        {busy
          ? <button type="button" className="danger" onClick={() => abortRef.current?.abort()}>Stop</button>
          : <button className="primary" disabled={!input.trim()}>Send</button>}
        {msgs.length > 0 && !busy && (
          <button type="button" className="dim" title="start a new conversation"
                  onClick={() => { setMsgs([]); setDecisions({}); setStick(true); }}>New</button>
        )}
      </form>
    </div>
  );
}

/** One turn. Consecutive tool calls fold into a single line: they are mechanical detail in the
 *  middle of the reasoning, and at full weight they were most of what you scrolled past. */
function Turn({ msg, decisions, apply, decide, thinking }: {
  msg: Msg; decisions: DecisionMap; thinking: boolean;
  apply: (p: Proposal) => void;
  decide: (id: string, status: "applied" | "skipped" | "error", detail?: string) => void;
}) {
  if (msg.role === "user") {
    return (
      <div className="turn user">
        <div className="turn-who">you</div>
        <div className="bubble-text">{textOf(msg)}</div>
      </div>
    );
  }

  // group runs of tool calls so they collapse together
  const blocks: ({ kind: "tools"; tools: Extract<Part, { type: "tool" }>[] } | { kind: "part"; part: Part })[] = [];
  for (const p of msg.parts) {
    const last = blocks[blocks.length - 1];
    if (p.type === "tool" && last && last.kind === "tools") last.tools.push(p);
    else if (p.type === "tool") blocks.push({ kind: "tools", tools: [p] });
    else blocks.push({ kind: "part", part: p });
  }

  const copyable = msg.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");

  return (
    <div className="turn assistant">
      <div className="turn-who">
        tares
        {copyable && (
          <button className="turn-copy" title="copy this answer"
                  onClick={() => navigator.clipboard?.writeText(copyable)}>copy</button>
        )}
      </div>
      {blocks.map((b, j) => b.kind === "tools"
        ? <ToolRun key={j} tools={b.tools} />
        : b.part.type === "proposal"
        ? <ProposalCard key={j} proposal={b.part.proposal} decision={decisions[b.part.proposal.id]}
                        onApply={() => apply((b.part as { proposal: Proposal }).proposal)}
                        onSkip={() => decide((b.part as { proposal: Proposal }).proposal.id, "skipped")} />
        : <div key={j} className="md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{(b.part as { text: string }).text}</ReactMarkdown></div>)}
      {thinking && <div className="dim">thinking…</div>}
    </div>
  );
}

function ToolRun({ tools }: { tools: Extract<Part, { type: "tool" }>[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="toolrun">
      <button className="toolrun-head" onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} {tools.length} step{tools.length === 1 ? "" : "s"}
        {!open && <span className="dim"> · {tools.map((t) => t.name).join(", ")}</span>}
      </button>
      {open && tools.map((t, i) => (
        <div key={i} className="toolcall">
          → <span className="mono">{t.name}</span>(<span className="mono">{compact(t.input)}</span>)
        </div>
      ))}
    </div>
  );
}

/** The key is stored on the SERVER, under Security — the same one Slack and trigger-woken agents
 *  resolve. It used to live in this browser's localStorage and ride along as a header, so a key
 *  added here made Ask work while Slack still reported no key configured (NF-125). */
function KeySetup({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true); setErr(undefined);
    try { await api.setAnthropicKey(value.trim()); onSaved(); }
    catch (e) { setErr(String((e as Error).message ?? e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="panel" style={{ maxWidth: 560 }}>
      <h2 style={{ marginTop: 0 }}>Add your Anthropic API key</h2>
      <p className="help" style={{ whiteSpace: "normal" }}>
        The assistant runs on your Tares daemon using this key. It is stored on this instance and
        used by everything that reasons over your data: this assistant, Tares agents woken by
        triggers, and <span className="mono">/tares ask</span> in Slack. You can change or remove it
        later under <strong>Security</strong>. Get one at{" "}
        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com</a>.
      </p>
      {err && <div className="alert error">{err}</div>}
      <form onSubmit={(e) => { e.preventDefault(); if (value.trim()) save(); }}>
        <input type="password" placeholder="sk-ant-…" value={value}
               onChange={(e) => setValue(e.target.value)}
               style={{ width: "100%", boxSizing: "border-box", padding: "0.5rem 0.7rem" }} autoFocus />
        <div className="btnrow" style={{ marginTop: 12 }}>
          <button className="primary" disabled={!value.trim() || saving}>
            {saving ? "saving…" : "Save key"}
          </button>
        </div>
      </form>
    </div>
  );
}

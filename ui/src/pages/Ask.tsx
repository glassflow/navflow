import { useState } from "react";

import AskChat from "../components/AskChat";
import OrganizePanel from "../components/OrganizePanel";
import { api } from "../api";
import { ErrorState, usePolling } from "../components/bits";

// One assistant, two doors: Chat (free-form explore/debug; also summonable with ⌘K) and
// Organize (a goal-directed run that proposes labels/views as apply-or-skip cards). Same
// engine underneath — Organize is Ask with an intent and a consent surface.
type Tab = "chat" | "organize";

const DEFAULT_INTENT =
  "Review my sources and propose the labels/keys each should have and the views that would " +
  "serve agents best.";

export default function Ask() {
  const [tab, setTab] = useState<Tab>("chat");

  return (
    <>
      <h1>Ask</h1>
      <p className="subtitle">
        an assistant over your Tares data — <em>chat to explore and debug, or have it organize
        your labels &amp; views</em>
      </p>

      <div className="tabs">
        <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>Chat</button>
        <button className={tab === "organize" ? "active" : ""} onClick={() => setTab("organize")}>Organize</button>
      </div>

      {tab === "chat" && <AskChat />}
      {tab === "organize" && <OrganizeTab />}
    </>
  );
}

// Start gate: state the goal (prefilled with the generic sweep), then the agent runs and
// proposes. An explicit click, never on page load — a run spends model tokens.
function OrganizeTab() {
  const { data: sources, error, reload } = usePolling(() => api.sources(), 15000);
  const [intent, setIntent] = useState(DEFAULT_INTENT);
  const [started, setStarted] = useState<string>();   // the intent the run started with

  const total = sources?.reduce((n, s) => n + (s.health?.events_total ?? 0), 0) ?? 0;
  const unlabeled = (sources ?? []).filter(
    (s) => !((s.config?.labels as unknown[] | undefined)?.length)).length;

  if (started) return <OrganizePanel intent={started} />;

  return (
    <div className="panel" style={{ maxWidth: 680 }}>
      {/* A failed /api/sources reads as "0 sources, 0 events" — say so, or the disabled Start
          button below blames the user's data for a backend failure. */}
      {error && <ErrorState error={error} what="your sources" onRetry={reload} />}
      <p className="help" style={{ whiteSpace: "normal", marginTop: 0 }}>
        The agent inspects your sources&rsquo; field profiles and sample events, then proposes
        labels &amp; keys per source and views across sources — as cards you apply or skip.
        Nothing changes without your click. Tell it what you&rsquo;re trying to achieve, or keep
        the default full sweep:
      </p>
      <textarea className="code" style={{ width: "100%", minHeight: 88, boxSizing: "border-box" }}
                value={intent} onChange={(e) => setIntent(e.target.value)}
                placeholder={DEFAULT_INTENT} />
      <p className="help" style={{ whiteSpace: "normal" }}>
        e.g. &ldquo;my two GitHub sources and my OTLP source belong to one product — set up labels,
        views and triggers so an agent can debug errors seen on the running service&rdquo;
      </p>
      {sources && (
        <p className="help" style={{ whiteSpace: "normal" }}>
          Right now: {sources.length} source{sources.length === 1 ? "" : "s"},{" "}
          {total.toLocaleString()} events{unlabeled > 0 && (
            <> — <strong>{unlabeled} with no labels declared</strong></>
          )}.
        </p>
      )}
      <button className="primary" disabled={!total || !intent.trim()}
              onClick={() => setStarted(intent.trim())}>
        ✨ Start
      </button>
      {!total && !error && <p className="help" style={{ marginTop: 8 }}>needs at least one source with data</p>}
    </div>
  );
}

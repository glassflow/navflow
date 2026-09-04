import { useNavigate } from "react-router-dom";

import { api } from "../api";
import { ErrorState, usePolling } from "../components/bits";
import type { Template } from "../types";

// The gallery behind "Create new" on /projects: one card per way to start a project. Templates
// the console knows how to set up with a dedicated wizard; anything else the API lists still gets
// a card, routed to the generic (params-driven) form.
const WIZARDS: Record<string, string> = {
  shared_code_context: "/projects/new/shared_code_context",
};

// What each template wires up, in the user's words. The daemon's describe() may carry mode-aware
// facts (ai_sre_demo says different things against a hosted stack than against local docker);
// this map is the fallback for templates that don't, and for older daemons.
const TEMPLATE_FACTS: Record<string, { you: string[]; tares: string[] }> = {
  ai_sre_demo: {
    you: ["start the demo stack with docker compose", "give the agent an Anthropic key", "cause an incident from the project page"],
    tares: ["three sources keyed by service: Prometheus metrics, the api-server's logs, the alerts Prometheus fires", "one timeline per service to explore", "a trigger that wakes the agent when an alert fires", "an agent that writes the first incident note back onto the timeline"],
  },
  shared_code_context: {
    you: ["pick the code repos to watch", "pick the repo that holds the shared context", "choose when it runs and how it writes"],
    tares: ["a source for each repo, so its commits flow into Tares", "a timeline per repo you can explore and query", "a trigger that wakes the agent when new commits land", "an agent that reads each change and updates the context repo, opening a pull request"],
  },
};

function TemplateCard({ r }: { r: Template }) {
  const navigate = useNavigate();
  const to = WIZARDS[r.key] ?? `/projects/new/${encodeURIComponent(r.key)}`;
  const facts = r.facts ?? TEMPLATE_FACTS[r.key];
  return (
    <div className="panel uc-card">
      <div className="uc-card-main">
        <div className="uc-card-title">
          {r.title}
          {(r.tags ?? []).map((t) => <span key={t} className="badge" style={{ marginLeft: 8, verticalAlign: "middle" }}>{t}</span>)}
        </div>
        <div className="help" style={{ marginTop: 2 }}>Tares template</div>
        <p className="help uc-card-desc">
          {r.description}
          {r.guide && <> Follows the <a href={r.guide.url} target="_blank" rel="noreferrer">{r.guide.label}</a>.</>}
        </p>
        {facts && (
          <div className="uc-card-facts">
            <div>
              <div className="lbl">you</div>
              <ul>{facts.you.map((t) => <li key={t}>{t}</li>)}</ul>
            </div>
            <div>
              <div className="lbl">Tares sets up</div>
              <ul>{facts.tares.map((t) => <li key={t}>{t}</li>)}</ul>
            </div>
          </div>
        )}
      </div>
      <div className="uc-card-side">
        <button className="primary" onClick={() => navigate(to)}>Set up</button>
      </div>
    </div>
  );
}

export default function ProjectNew() {
  const navigate = useNavigate();
  const { data: rec, error: recError, reload: reloadRec } = usePolling(() => api.templates(), 60000);
  const templates = rec?.templates ?? [];

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>New project</h1>
          <p className="subtitle">
            start from a Tares template: answer a few questions and Tares creates the objects
            behind it, each visible and editable on its own page. Or assemble one from objects
            you already have.
          </p>
        </div>
      </div>

      {recError && <ErrorState error={recError} what="the project catalog" onRetry={reloadRec} />}
      {!rec && !recError && <div className="dim">loading…</div>}
      {rec && templates.length === 0 && (
        <div className="empty">No templates are registered on this instance yet.</div>
      )}
      <div className="uc-cards">
        {/* Hand-written: the builder is not a template, it assembles a custom project one step at
            a time with the assistant proposing each piece (ProjectNewAssist). */}
        {rec && (
          <div className="panel uc-card">
            <div className="uc-card-main">
              <div className="uc-card-title">Build with Tares</div>
              <div className="help" style={{ marginTop: 2 }}>AI-guided</div>
              <p className="help uc-card-desc">
                Describe what you need in your own words. Tares proposes the sources, views, triggers
                and agent from the connectors installed here; you confirm each one in place and fill
                in what only you know.
              </p>
              <div className="uc-card-facts">
                <div>
                  <div className="lbl">you</div>
                  <ul><li>say what you run and what should happen</li><li>fill in URLs, tokens and the Slack channel</li><li>apply or skip each proposal</li></ul>
                </div>
                <div>
                  <div className="lbl">Tares sets up</div>
                  <ul><li>the sources, tested before they are created</li><li>views and triggers grounded in your real data</li><li>an agent on the trigger, enabled and ready</li></ul>
                </div>
              </div>
            </div>
            <div className="uc-card-side">
              <button className="primary" onClick={() => navigate("/projects/new/assist")}>Build</button>
            </div>
          </div>
        )}
        {templates.map((r) => <TemplateCard key={r.key} r={r} />)}
        {rec && (
          <div className="panel uc-card">
            <div className="uc-card-main">
              <div className="uc-card-title">From existing objects</div>
              <p className="help uc-card-desc">
                Assemble a project from sources, views, triggers, agents and MCP servers you already have.
                Nothing is created; the project page shows their runs and firings.
              </p>
            </div>
            <div className="uc-card-side">
              <button className="primary" onClick={() => navigate("/projects/new/custom")}>Assemble</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

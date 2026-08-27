import { Link, useNavigate } from "react-router-dom";

import { api } from "../api";
import { ErrorState, TimeAgo, usePolling } from "../components/bits";
import type { Template, Project } from "../types";

// Projects are the opinionated entry point: pick one, answer a few questions, click Start, and
// Tares creates the sources, view, trigger and agent for you. Everything it creates is an ordinary
// object on its normal page; this page and the instance page are the combined view.

// Templates the console knows how to set up with a dedicated wizard. Anything else the API lists
// still gets a card, routed to the generic (params-driven) form.
const WIZARDS: Record<string, string> = {
  shared_code_context: "/projects/new/shared_code_context",
};

function statusClass(s: Project["status"]) {
  return s === "active" ? "ok" : s === "paused" ? "paused" : "error";
}

export function projectKindCounts(u: Project) {
  const c: Record<string, number> = {};
  for (const o of u.objects) c[o.kind] = (c[o.kind] ?? 0) + 1;
  return c;
}

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

export default function Projects() {
  const { data: rec, error: recError, reload: reloadRec } = usePolling(() => api.templates(), 60000);
  const { data: inst, error: instError, reload: reloadInst } = usePolling(() => api.projects(), 10000);
  const templates = rec?.templates ?? [];
  const projects = inst?.projects ?? [];

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Projects</h1>
          <p className="subtitle">
            what you set up and look after in Tares: a named set of sources, views, triggers and agents with one
            page. Start one from a Tares template: answer a few questions and Tares creates the objects behind it,
            each visible and editable on its own page.
          </p>
        </div>
      </div>

      {recError && <ErrorState error={recError} what="the project catalog" onRetry={reloadRec} />}
      {instError && <ErrorState error={instError} what="your projects" onRetry={reloadInst} />}

      {inst && projects.length > 0 && (
        <table style={{ marginBottom: 24 }}>
          <thead>
            <tr>
              <th>name</th><th>project</th><th>status</th><th>objects</th><th>updated</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {projects.map((u) => {
              const c = projectKindCounts(u);
              const missing = u.objects.filter((o) => o.missing).length;
              return (
                <tr key={u.id}>
                  <td><Link to={`/projects/${encodeURIComponent(u.id)}`}><strong>{u.name}</strong></Link></td>
                  <td>{u.template_title}</td>
                  <td>
                    <span className={`badge ${statusClass(u.status)}`}>{u.status}</span>
                    {missing > 0 && <span className="help" style={{ marginLeft: 6 }}>{missing} missing</span>}
                  </td>
                  <td className="help">
                    {c.source ?? 0} source{c.source === 1 ? "" : "s"}
                    {c.trigger ? `, ${c.trigger} trigger${c.trigger === 1 ? "" : "s"}` : ""}
                    {c.agent ? `, ${c.agent} agent${c.agent === 1 ? "" : "s"}` : ""}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}><TimeAgo ts={u.updated_at} /></td>
                  <td>
                    <div className="btnrow" style={{ justifyContent: "flex-end" }}>
                      <Link className="btn" to={`/projects/${encodeURIComponent(u.id)}`}>Open</Link>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h2 style={{ marginTop: projects.length > 0 ? 8 : 18 }}>{projects.length > 0 ? "Start another" : "Templates"}</h2>
      {!rec && !recError && <div className="dim">loading…</div>}
      {rec && templates.length === 0 && (
        <div className="empty">No templates are registered on this instance yet.</div>
      )}
      <div className="uc-cards">
        {templates.map((r) => <TemplateCard key={r.key} r={r} />)}
      </div>
    </>
  );
}

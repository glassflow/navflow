import { Link, useNavigate } from "react-router-dom";

import { api } from "../api";
import { ErrorState, TimeAgo, usePolling } from "../components/bits";
import type { Recipe, Usecase } from "../types";

// Use cases are the opinionated entry point: pick one, answer a few questions, click Start, and
// Tares creates the sources, view, trigger and agent for you. Everything it creates is an ordinary
// object on its normal page; this page and the instance page are the combined view.

// Recipes the console knows how to set up with a dedicated wizard. Anything else the API lists
// still gets a card, routed to the generic (params-driven) form.
const WIZARDS: Record<string, string> = {
  shared_code_context: "/usecases/new/shared_code_context",
};

function statusClass(s: Usecase["status"]) {
  return s === "active" ? "ok" : s === "paused" ? "paused" : "error";
}

export function usecaseKindCounts(u: Usecase) {
  const c: Record<string, number> = {};
  for (const o of u.objects) c[o.kind] = (c[o.kind] ?? 0) + 1;
  return c;
}

// What each recipe wires up, in the user's words. Keyed by recipe so a new recipe without an
// entry still gets a card, just without the "what it sets up" column.
const RECIPE_FACTS: Record<string, { you: string[]; tares: string[] }> = {
  shared_code_context: {
    you: ["pick the code repos to watch", "pick the repo that holds the shared context", "choose when it runs and how it writes"],
    tares: ["a source for each repo, so its commits flow into Tares", "a timeline per repo you can explore and query", "a trigger that wakes the agent when new commits land", "an agent that reads each change and updates the context repo, opening a pull request"],
  },
};

function RecipeCard({ r }: { r: Recipe }) {
  const navigate = useNavigate();
  const to = WIZARDS[r.key] ?? `/usecases/new/${encodeURIComponent(r.key)}`;
  const facts = RECIPE_FACTS[r.key];
  return (
    <div className="panel uc-card">
      <div className="uc-card-main">
        <div className="uc-card-title">{r.title}</div>
        <p className="help uc-card-desc">{r.description}</p>
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

export default function Usecases() {
  const { data: rec, error: recError, reload: reloadRec } = usePolling(() => api.recipes(), 60000);
  const { data: inst, error: instError, reload: reloadInst } = usePolling(() => api.usecases(), 10000);
  const recipes = rec?.recipes ?? [];
  const usecases = inst?.usecases ?? [];

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Use cases</h1>
          <p className="subtitle">
            pick what you want Tares to do. A use case is a ready-made setup: you answer a few questions and
            Tares creates the sources, view, trigger and agent behind it, each visible and editable on its own page.
          </p>
        </div>
      </div>

      {recError && <ErrorState error={recError} what="the use case catalog" onRetry={reloadRec} />}
      {instError && <ErrorState error={instError} what="your use cases" onRetry={reloadInst} />}

      {inst && usecases.length > 0 && (
        <table style={{ marginBottom: 24 }}>
          <thead>
            <tr>
              <th>name</th><th>use case</th><th>status</th><th>objects</th><th>updated</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {usecases.map((u) => {
              const c = usecaseKindCounts(u);
              const missing = u.objects.filter((o) => o.missing).length;
              return (
                <tr key={u.id}>
                  <td><Link to={`/usecases/${encodeURIComponent(u.id)}`}><strong>{u.name}</strong></Link></td>
                  <td>{u.recipe_title}</td>
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
                      <Link className="btn" to={`/usecases/${encodeURIComponent(u.id)}`}>Open</Link>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h2 style={{ marginTop: usecases.length > 0 ? 8 : 18 }}>{usecases.length > 0 ? "Set up another" : "Available"}</h2>
      {!rec && !recError && <div className="dim">loading…</div>}
      {rec && recipes.length === 0 && (
        <div className="empty">No use cases are registered on this instance yet.</div>
      )}
      <div className="uc-cards">
        {recipes.map((r) => <RecipeCard key={r.key} r={r} />)}
      </div>
    </>
  );
}

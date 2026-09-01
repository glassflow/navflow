import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { api } from "../api";
import { ErrorState, usePolling } from "../components/bits";
import type { Template } from "../types";
import ProjectShell from "./ProjectShell";

// The route behind /projects/:id. Fetches the summary and the template's description (for its
// declared actions) and hands both to ProjectShell, the one page every project shares.
export default function ProjectDetail() {
  const { id = "" } = useParams();
  const { data: s, error, reload } = usePolling(() => api.projectSummary(id), 10000);
  const [template, setTemplate] = useState<Template>();
  useEffect(() => {
    if (!s?.template) return;
    api.templates().then((r) => setTemplate(r.templates.find((x) => x.key === s.template))).catch(() => {});
  }, [s?.template]);

  if (error && !s) return <ErrorState error={error} what="this project" onRetry={reload} />;
  if (!s) return <div className="dim">loading…</div>;
  return <ProjectShell s={s} id={id} reload={reload} template={template} />;
}

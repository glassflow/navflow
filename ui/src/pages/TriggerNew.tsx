import { useNavigate, useSearchParams } from "react-router-dom";

import TriggerEditor from "../components/TriggerEditor";

export default function TriggerNew() {
  const nav = useNavigate();
  const [params] = useSearchParams();

  return (
    <>
      <h1>New trigger</h1>
      <p className="subtitle">
        a condition NavFlow evaluates continuously over a view — when it trips, subscribed agents
        are woken with the correlated timeline
      </p>
      <TriggerEditor presetView={params.get("view") ?? undefined}
                     onSaved={(name) => nav(`/triggers/${encodeURIComponent(name)}`)}
                     onCancel={() => nav("/triggers")} />
    </>
  );
}

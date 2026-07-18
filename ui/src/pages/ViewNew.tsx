import { useNavigate } from "react-router-dom";

import { api } from "../api";
import ViewEditor from "../components/ViewEditor";
import { usePolling } from "../components/bits";

export default function ViewNew() {
  const nav = useNavigate();
  const { data: sources } = usePolling(() => api.sources(), 15000);

  return (
    <>
      <h1>New view</h1>
      <p className="subtitle">
        pick the sources to correlate and the label agents will look entities up by
      </p>
      <ViewEditor sourceNames={(sources ?? []).map((s) => s.name)}
                  onSaved={(name) => nav(`/views/${encodeURIComponent(name)}`)}
                  onCancel={() => nav("/views")} />
    </>
  );
}

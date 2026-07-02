import { useEffect, useRef, useState } from "react";

export function StatusBadge({ status }: { status: string | undefined }) {
  const s = status ?? "starting";
  return <span className={`badge ${s}`}>{s}</span>;
}

export function TimeAgo({ ts }: { ts: string | null | undefined }) {
  if (!ts) return <span className="dim">—</span>;
  const secs = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  let label: string;
  if (secs < 60) label = `${Math.round(secs)}s ago`;
  else if (secs < 3600) label = `${Math.round(secs / 60)}m ago`;
  else if (secs < 86400) label = `${Math.round(secs / 3600)}h ago`;
  else label = `${Math.round(secs / 86400)}d ago`;
  return <span title={new Date(ts).toLocaleString()}>{label}</span>;
}

/** Fetch on mount and refetch on an interval; pause when the tab is hidden. */
export function usePolling<T>(fn: () => Promise<T>, intervalMs = 5000): {
  data: T | undefined;
  error: string | undefined;
  reload: () => void;
} {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    const load = () => {
      if (document.hidden) return;
      fnRef.current()
        .then((d) => { if (live) { setData(d); setError(undefined); } })
        .catch((e) => { if (live) setError(String(e.message ?? e)); });
    };
    load();
    const id = setInterval(load, intervalMs);
    return () => { live = false; clearInterval(id); };
  }, [intervalMs, tick]);

  return { data, error, reload: () => setTick((t) => t + 1) };
}

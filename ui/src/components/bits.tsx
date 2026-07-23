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

/** Input with styled suggestions — replaces native <datalist> (which can't be themed).
 *  Free text stays allowed; suggestions filter as you type. */
export function Combo({ value, onChange, options, placeholder, style, className, hints, hintClass }: {
  value: string; onChange: (v: string) => void; options: string[];
  placeholder?: string; style?: React.CSSProperties; className?: string;
  hints?: Record<string, string>;   // per-option annotation, right-aligned (e.g. coverage, a type tag)
  hintClass?: string;               // className for the annotation (default "dim"; "chip" for a tag)
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const needle = value.trim().toLowerCase();
  const shown = options.filter((o) => !needle || o.toLowerCase().includes(needle));

  const pick = (o: string) => { onChange(o); setOpen(false); };

  return (
    <div className={"combo" + (className ? ` ${className}` : "")} style={style}>
      <input type="text" value={value} placeholder={placeholder}
             onChange={(e) => { onChange(e.target.value); setOpen(true); setHi(0); }}
             onFocus={() => setOpen(true)}
             onBlur={() => setOpen(false)}
             onKeyDown={(e) => {
               if (!open || !shown.length) return;
               if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, shown.length - 1)); }
               else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
               else if (e.key === "Enter") { e.preventDefault(); pick(shown[hi]); }
               else if (e.key === "Escape") setOpen(false);
             }} />
      {open && shown.length > 0 && (
        <div className="combo-list">
          {shown.map((o, i) => (
            <div key={o} className={"combo-item" + (i === hi ? " active" : "")}
                 style={hints ? { display: "flex", justifyContent: "space-between", gap: 12 } : undefined}
                 onMouseDown={(e) => { e.preventDefault(); pick(o); }}
                 onMouseEnter={() => setHi(i)}>
              <span>{o}</span>
              {hints?.[o] && <span className={hintClass ?? "dim"}>{hints[o]}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

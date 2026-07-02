import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import AskChat from "./AskChat";
import { Close } from "./icons";

// The ⌘K overlay: the Ask assistant, floating over whatever page you're on, so you can ask a
// question without navigating away and losing your place. Same engine as the /ask page.
export default function CommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;
  return (
    <div className="cmdk-overlay" onClick={() => setOpen(false)}>
      <div className="cmdk" role="dialog" aria-label="Ask your data" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-head">
          <span className="cmdk-title">Ask your data</span>
          <div className="cmdk-actions">
            <Link to="/ask" className="cmdk-link" onClick={() => setOpen(false)}>Open in Ask ↗</Link>
            <button className="sheet-close" onClick={() => setOpen(false)} aria-label="Close"><Close /></button>
          </div>
        </div>
        <div className="cmdk-body">
          <AskChat />
        </div>
      </div>
    </div>
  );
}

import { useEffect } from "react";

import { Close } from "./icons";

// A read-only modal for a longer explanation behind a "?" button. Same chrome as ConfirmDialog,
// one Close action; Escape and the overlay close it.
export default function InfoDialog({ title, children, onClose }: {
  title: string; children: React.ReactNode; onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="sheet-overlay" style={{ zIndex: 100 }} onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width: "min(560px, 92vw)" }}>
        <div className="sheet-head">
          <div className="sheet-title"><h2 style={{ margin: 0 }}>{title}</h2></div>
          <button className="sheet-close" onClick={onClose} aria-label="Close"><Close /></button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="sheet-foot">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </>
  );
}

/** The small round "?" that opens an InfoDialog. */
export function HelpButton({ onClick, label = "What is this?" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="help-btn" onClick={onClick} aria-label={label} title={label}>?</button>
  );
}

import { useEffect } from "react";

import { Close } from "./icons";

// An integrated confirm modal — replaces native window.confirm so destructive actions match the
// console's look. Optional `children` for extra controls (e.g. a "purge events" checkbox).
export default function ConfirmDialog({
  title, message, confirmLabel = "Confirm", danger = false, children, onConfirm, onCancel,
}: {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  children?: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <>
      <div className="sheet-overlay" style={{ zIndex: 100 }} onClick={onCancel} />
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-head">
          <div className="sheet-title"><h2 style={{ margin: 0 }}>{title}</h2></div>
          <button className="sheet-close" onClick={onCancel} aria-label="Close"><Close /></button>
        </div>
        <div className="modal-body">
          {message && <p className="help" style={{ whiteSpace: "normal", margin: 0 }}>{message}</p>}
          {children}
        </div>
        <div className="sheet-foot">
          <button className={danger ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</button>
          <button onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </>
  );
}

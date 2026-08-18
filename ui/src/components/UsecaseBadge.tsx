import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api";
import type { Usecase } from "../types";

// "Part of use case <name>": the chip an object wears when a use case created it. Ownership is a
// badge, not a lock: the object stays editable and deletable on its own page. `customized` means
// it was edited by hand since, so the use case keeps that version on its next re-plan.
//
// The object rows only carry the use case id; the name comes from /api/usecases, fetched once per
// page and shared through a small module cache so five badges on one page cost one request.

let cache: { at: number; list: Usecase[] } | undefined;
let inflight: Promise<Usecase[]> | undefined;

async function usecaseList(): Promise<Usecase[]> {
  if (cache && Date.now() - cache.at < 15_000) return cache.list;
  if (!inflight) {
    inflight = api.usecases().then((r) => {
      cache = { at: Date.now(), list: r.usecases };
      inflight = undefined;
      return r.usecases;
    }).catch(() => { inflight = undefined; return cache?.list ?? []; });
  }
  return inflight;
}

export function useUsecaseName(id: string | null | undefined): Usecase | undefined {
  const [uc, setUc] = useState<Usecase>();
  useEffect(() => {
    if (!id) { setUc(undefined); return; }
    let live = true;
    usecaseList().then((list) => { if (live) setUc(list.find((u) => u.id === id)); });
    return () => { live = false; };
  }, [id]);
  return uc;
}

export default function UsecaseBadge({ ownedBy, customized, compact }: {
  ownedBy: string | null | undefined;
  customized?: boolean;
  compact?: boolean;   // table cells: just the chip, no lead-in
}) {
  const uc = useUsecaseName(ownedBy);
  if (!ownedBy) return null;
  const label = uc?.name ?? "a use case";
  return (
    <span className="uc-badge" title={customized
      ? "created by a use case, then edited here; the use case keeps your version"
      : "created by a use case; edit or delete it here like any other object"}>
      <Link to={`/usecases/${encodeURIComponent(ownedBy)}`} className="chip">
        {compact ? label : `Part of use case ${label}`}
      </Link>
      {customized && <span className="help">customized</span>}
    </span>
  );
}

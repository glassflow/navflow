"""Push dispatch — deliver a fired trigger to its subscribers' webhooks, with retry/backoff.

The dispatch body carries the rendered view payload, so the agent boots already holding the
correlated timeline (zero reads to begin). At-least-once; subscribers dedupe on `dispatch_id`.
"""
from __future__ import annotations

import asyncio
import uuid

import httpx

from .envelope import now_utc


class Dispatcher:
    def __init__(self, store):
        self.store = store

    async def fire(self, trigger, key: str, payload: str) -> None:
        subs = self.store.list_subscriptions(trigger.name)
        kind = trigger.emit.get("kind", trigger.name)
        dispatch_id = uuid.uuid4().hex
        body = {
            "dispatch_id": dispatch_id,
            "trigger": trigger.name,
            "kind": kind,
            "key": key,
            "fired_at": now_utc().isoformat(),
            "payload": payload,
        }
        delivered = 0
        for sid, _trig, url in subs:
            ok, error = await self._post(url, body)
            self.store.log_delivery(dispatch_id, sid, url, ok, error)   # per-agent delivery history
            if ok:
                delivered += 1
        # log every firing, even with zero subscribers — the UI shows what would have woken agents
        self.store.log_dispatch(dispatch_id, trigger.name, key, kind,
                                len(subs), delivered, payload)

    async def _post(self, url: str, body: dict, attempts: int = 5) -> tuple[bool, str | None]:
        """Deliver to one subscriber. Returns (ok, error): ok only on a 2xx. A 4xx is a definitive
        failure (bad secret / wrong path / gone) — recorded, not retried. 5xx and transport errors
        (unreachable, timeout, DNS) are retried with backoff; the last error is returned so the UI
        can say WHY a delivery shows 0, instead of a silent failure."""
        delay = 1.0
        error = None
        async with httpx.AsyncClient(timeout=10) as cx:
            for attempt in range(attempts):
                try:
                    r = await cx.post(url, json=body)
                    if 200 <= r.status_code < 300:
                        return True, None
                    error = f"HTTP {r.status_code}"
                    if r.status_code < 500:       # client error — won't self-heal, don't retry
                        return False, error
                except Exception as e:            # transport failure — unreachable / timeout / DNS
                    error = (type(e).__name__ + (f": {e}" if str(e).strip() else ""))[:200]
                if attempt < attempts - 1:        # no point sleeping after the final attempt
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, 30)
        return False, error

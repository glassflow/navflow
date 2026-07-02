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
        for _sid, _trig, url in subs:
            if await self._post(url, body):
                delivered += 1
        # log every firing, even with zero subscribers — the UI shows what would have woken agents
        self.store.log_dispatch(dispatch_id, trigger.name, key, kind,
                                len(subs), delivered, payload)

    async def _post(self, url: str, body: dict, attempts: int = 5) -> bool:
        delay = 1.0
        async with httpx.AsyncClient(timeout=10) as cx:
            for _ in range(attempts):
                try:
                    r = await cx.post(url, json=body)
                    if r.status_code < 500:
                        return True
                except Exception:
                    pass
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30)
        return False

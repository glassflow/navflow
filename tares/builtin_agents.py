"""Tares agents — the data plane reading its own data.

A Tares agent is a prompt attached to a trigger. It's a real agent (it reasons with an LLM),
configured inside Tares rather than connected over a webhook. When its trigger fires it's handed
the same correlated timeline the dispatch carries, may read a wider window or another entity, and
writes ONE finding back into Tares (plus an optional Slack post). Today it has exactly two tools,
`query` and `read`, both routed through Tares's own read path — it cannot reach anything else.

That closed tool set is the current boundary: a Tares agent reads and concludes, it does not act
on the customer's world (restarting, deploying, ticketing) — that's the customer's own agent's job.
The boundary is a property of this kind of agent, not the reason it's called something else.

Everything except the prompt is Tares's decision — model, round budget, token budget, the daily
cap. Making those configurable would turn a data-plane feature into an agent builder.

The dispatcher runs a Tares agent as a *subscriber* to its trigger (an internal subscription,
url = tares://agent/<name>), so it flows through the same dispatch, delivery log, roster and
recent-firings machinery as an external agent. This module is the in-process executor the dispatcher
calls for those subscriptions; it logs the run detail (rounds, finding) alongside the delivery.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import uuid

import httpx

from .config import FINDINGS_SOURCE, agent_url
from .slack import deep_link as _slack_deep_link
from .views import resolve_query_full, resolve_read

MODEL = os.getenv("TARES_AGENT_MODEL", "claude-sonnet-4-6")
# The model choices the console offers per agent. The instance default (TARES_AGENT_MODEL) is
# always first; an agent stores "" to mean "follow the instance default", so changing the
# instance default moves every agent that never chose one.
AGENT_MODELS = list(dict.fromkeys(
    [MODEL, "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"]))
# Overridable so the end-to-end test can point at a stub instead of the real API.
API_BASE = os.getenv("TARES_ANTHROPIC_BASE", "https://api.anthropic.com").rstrip("/")
MAX_ROUNDS = 6            # model-call rounds per run
MAX_TOKENS = 2048         # per model call
TOOL_TIMEOUT = 120        # per Anthropic request
# Cost ceiling. A trigger in a hot loop can fire far more often than anyone expects; without a cap
# the first surprise is the bill. Per-agent and per-day, counted from the run log.
DAILY_RUN_CAP = int(os.getenv("TARES_AGENT_DAILY_CAP", "50"))

# Starting points offered in the form. A preset only seeds the prompt box — the user edits freely,
# because we cannot know what sources they attached or what they need looked at.
PRESETS = {
    "what-changed": {
        "label": "What changed",
        "prompt": (
            "You are taking a first look at an entity in a system you monitor, because a condition "
            "you watch just tripped. You are handed the correlated timeline (logs, metrics, "
            "deploys, commits, alerts) for that entity at the moment it tripped — that is your "
            "evidence.\n\n"
            "Establish what is happening and what CHANGED just before it started. Connect the "
            "change to the signature in the evidence. If the timeline is too narrow, read a wider "
            "window (1h) once before concluding.\n\n"
            "Write a short note: 1) what is happening and since when, 2) the most likely "
            "explanation with the specific evidence lines that support it, 3) what you would look "
            "at next. Do not speculate beyond the evidence — if it is inconclusive, say so and say "
            "what you would need. Your final message is recorded on this entity's timeline."
        ),
    },
    "error-investigation": {
        "label": "Error investigation",
        "prompt": (
            "You are an SRE taking the first look when an error condition trips on a running "
            "service. You are handed the correlated timeline (logs, metrics, deploys, commits) for "
            "the affected entity — that is your primary evidence.\n\n"
            "Diagnose the most likely root cause: look for what changed (a deploy, a commit, a "
            "config value) just before the errors began, and connect it to the failure signature "
            "in the logs. If the timeline is insufficient, read a wider window (1h) once before "
            "concluding.\n\n"
            "Produce a tight incident note: 1) what is failing and since when, 2) most likely "
            "cause with the specific evidence lines, 3) suggested next action. Do not speculate "
            "beyond the evidence; say what you'd need if inconclusive. Your final message is "
            "recorded on this entity's timeline."
        ),
    },
    "summarize": {
        "label": "Summarize the window",
        "prompt": (
            "You are handed the correlated timeline for an entity at the moment a condition you "
            "watch tripped. Summarize what happened in that window in plain language: the notable "
            "events in order, which sources they came from, and anything that looks out of the "
            "ordinary. Do not diagnose beyond what the evidence supports. Your final message is "
            "recorded on this entity's timeline."
        ),
    },
}

TOOL_DEFS = [
    {
        "name": "read",
        "description": "Read one correlated, time-ordered timeline for an entity across ALL "
                       "sources. The selector is a {label: value} map (strict AND), e.g. "
                       "{\"service\": \"checkout\"}. Use this to widen the window or look at a "
                       "different entity than the one you were woken for.",
        "input_schema": {"type": "object", "properties": {
            "selector": {"type": "object", "description": "{label: value}, e.g. {\"service\": \"api\"}"},
            "window": {"type": "string", "description": "e.g. 15m, 1h, 24h", "default": "1h"}},
            "required": ["selector"]},
    },
    {
        "name": "query",
        "description": "Read a timeline through a saved view (narrower than `read`: only that "
                       "view's sources and filters). Select the entity by `key` or by `where`.",
        "input_schema": {"type": "object", "properties": {
            "view": {"type": "string"},
            "key": {"type": "string"},
            "where": {"type": "object"},
            "window": {"type": "string", "default": "1h"}},
            "required": ["view"]},
    },
]


def prompt_hash(prompt: str) -> str:
    """Short, stable id for the prompt that produced a finding. Without it, editing a prompt makes
    every earlier finding unattributable to the wording that caused it."""
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:12]


def resolve_key(store) -> tuple[str, str]:
    """(key, where-it-came-from). The env `ANTHROPIC_API_KEY` (the standard SDK name most users
    already have exported) wins over the console-stored value, so an operator's deployment config is
    never silently overridden by something typed into a UI months earlier."""
    val = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if val:
        return val, "env:ANTHROPIC_API_KEY"
    stored = (store.get_setting("anthropic_key") or "").strip()
    return (stored, "console") if stored else ("", "")


class AgentRunner:
    """Runs Tares agents in-process on the daemon's event loop, one per firing.

    In-process is right for a single-user local install (the whole point is that the loop closes on
    `tares up`, with nothing to deploy), and wrong for a shared instance — one run holds a slot
    for minutes and there is no isolation. A shared deployment should connect an external agent over
    a normal webhook subscription instead.

    The dispatcher calls `deliver()` for each internal subscription on a firing. Because a run takes
    minutes, deliver() does NOT block the dispatch: it logs a pending delivery, spawns the run, and
    resolves the delivery (ok/error) plus the run detail when it finishes — so a slow agent never
    delays an external webhook on the same trigger.
    """

    def __init__(self, store, runtime):
        self.store = store
        self.runtime = runtime
        self._tasks: set[asyncio.Task] = set()
        # (agent, key) currently running. Dispatch is at-least-once, so a retried delivery would
        # otherwise run the same investigation twice and pay for it twice.
        self._inflight: set[tuple[str, str]] = set()
        # Runs live in this process, so nothing can still be running from a previous one: any row
        # left `running` is an orphan from a daemon that was killed mid-run. Left alone it stays
        # running forever and keeps counting toward the daily cap.
        reaped = store.reap_stale_agent_runs()
        if reaped:
            print(f"taresd: reaped {reaped} interrupted agent run(s)")

    # ── entry point (called by the dispatcher, once per internal subscription) ─
    def deliver(self, agent_name: str, subscription_id: str, trigger_name: str, key: str,
                payload: str, dispatch_id: str) -> None:
        """Wake a Tares agent for one firing. Logs a pending delivery immediately, then runs the
        agent in the background. Never raises and never blocks — a run must not break the dispatch."""
        agent = self.store.get_catalog_agent(agent_name)
        if agent is None:   # subscription outlived its definition (shouldn't happen) — nothing to run
            self.store.log_delivery(dispatch_id, subscription_id, agent_url(agent_name), False,
                                    "no such agent")
            return
        # pending delivery: the firing already "reached" the agent; whether it concludes is async.
        self.store.log_delivery(dispatch_id, subscription_id, agent_url(agent_name), None)
        task = asyncio.create_task(self._guarded(agent, subscription_id, trigger_name, key,
                                                 payload, dispatch_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _guarded(self, agent: dict, subscription_id: str, trigger_name: str, key: str,
                       payload: str, dispatch_id: str) -> None:
        marker = (agent["name"], key)
        if marker in self._inflight:   # at-least-once dedupe
            self.store.update_delivery(dispatch_id, subscription_id, True, "deduped (already running)")
            return
        self._inflight.add(marker)
        run_id = "run_" + uuid.uuid4().hex[:12]
        self.store.start_agent_run(run_id, agent["name"], trigger_name, dispatch_id, key,
                                   prompt_hash(agent["prompt"]))
        try:
            status, error = await self._run(agent, trigger_name, key, payload, run_id)
        except Exception as e:
            detail = f"{type(e).__name__}: {str(e) or repr(e)}"
            self.store.finish_agent_run(run_id, "failed", error=detail[:500])
            status, error = "failed", detail[:500]
            print(f"[agent {agent['name']}] {detail}")
        finally:
            self._inflight.discard(marker)
        # resolve the delivery: ok when the agent concluded ('ok'); 'empty'/'capped' are not
        # failures (it ran and declined to conclude, or hit the cap) but aren't a delivered finding
        # either — mark ok=false with the reason so the firing row is honest without crying wolf.
        self.store.update_delivery(dispatch_id, subscription_id, status == "ok",
                                   None if status == "ok" else error)

    async def _run(self, agent: dict, trigger_name: str, key: str, payload: str,
                   run_id: str) -> tuple[str, str | None]:
        api_key, _ = resolve_key(self.store)
        if not api_key:
            msg = "no Anthropic key: set ANTHROPIC_API_KEY or add one in the console"
            self.store.finish_agent_run(run_id, "failed", error=msg)
            return "failed", msg
        # Count the runs BEFORE this one (its row is already inserted), so the cap fires at exactly
        # DAILY_RUN_CAP runs rather than one over it.
        if self.store.agent_runs_today(agent["name"], exclude_run_id=run_id) >= DAILY_RUN_CAP:
            msg = f"cap of {DAILY_RUN_CAP} runs in the last 24h reached for this agent"
            self.store.finish_agent_run(run_id, "capped", error=msg)
            return "capped", msg

        finding, rounds, tool_calls = await self._loop(agent, trigger_name, key, payload, api_key)
        if not finding:
            msg = "the model returned no conclusion"
            self.store.finish_agent_run(run_id, "empty", rounds=rounds, tool_calls=tool_calls,
                                        error=msg)
            return "empty", msg

        await self._record(agent, trigger_name, key, finding)
        self.store.finish_agent_run(run_id, "ok", rounds=rounds, tool_calls=tool_calls,
                                    finding=finding)
        return "ok", None

    # ── the bounded model loop ────────────────────────────────────────────────
    async def _loop(self, agent: dict, trigger_name: str, key: str, payload: str,
                    api_key: str) -> tuple[str, int, int]:
        messages = [{
            "role": "user",
            "content": (
                f'The condition "{trigger_name}" tripped for "{key}".\n\n'
                f"The correlated timeline at that moment:\n\n{payload}\n\n"
                f"Take a first look, per your instructions. You already hold the evidence above — "
                f"read again only if you need a wider window or a different entity."),
        }]
        rounds = tool_calls = 0
        async with httpx.AsyncClient(timeout=TOOL_TIMEOUT) as cx:
            for rounds in range(1, MAX_ROUNDS + 1):
                r = await cx.post(
                    f"{API_BASE}/v1/messages",
                    headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
                    json={"model": agent.get("model") or MODEL,
                          "max_tokens": MAX_TOKENS, "system": agent["prompt"],
                          "tools": TOOL_DEFS, "messages": messages})
                if r.status_code >= 400:
                    raise RuntimeError(f"anthropic {r.status_code}: {r.text[:300]}")
                msg = r.json()
                messages.append({"role": "assistant", "content": msg["content"]})

                uses = [b for b in msg["content"] if b.get("type") == "tool_use"]
                if not uses:
                    text = "\n".join(b.get("text", "") for b in msg["content"]
                                     if b.get("type") == "text")
                    return text.strip(), rounds, tool_calls

                results = []
                for u in uses:
                    tool_calls += 1
                    try:
                        out = self._tool(agent["name"], str(u["name"]), u.get("input") or {})
                    except Exception as e:   # a tool error is evidence, not a crash
                        out = f"tool error: {type(e).__name__}: {e}"
                    results.append({"type": "tool_result", "tool_use_id": u["id"], "content": out})
                messages.append({"role": "user", "content": results})

        return "", rounds, tool_calls   # round budget exhausted without a conclusion

    def _tool(self, agent_name: str, name: str, args: dict) -> str:
        """The two reads, in-process. No HTTP hop and no credential: a Tares agent IS Tares, so
        it reads through the same resolver the API serves rather than authenticating to itself."""
        catalog = self.runtime.catalog
        window = str(args.get("window") or "1h")
        if name == "read":
            selector = args.get("selector") or {}
            if not isinstance(selector, dict) or not selector:
                raise ValueError('read needs a selector, e.g. {"service": "checkout"}')
            payload, nrows, _sources, _rows = resolve_read(self.store, catalog, selector, window)
            self.store.log_query("r_" + uuid.uuid4().hex[:12], "(read)",
                                 ", ".join(f"{k}={v}" for k, v in selector.items()),
                                 window, nrows, f"agent:{agent_name}")
            return payload
        if name == "query":
            view = str(args.get("view") or "")
            if view not in catalog.views:
                raise KeyError(f"unknown view {view!r} (available: {', '.join(catalog.views)})")
            key = args.get("key")
            where = args.get("where") or None
            payload, nrows, _rows = resolve_query_full(self.store, catalog, view, key, window,
                                                       where=where)
            self.store.log_query("q_" + uuid.uuid4().hex[:12], view, str(key or where or ""),
                                 window, nrows, f"agent:{agent_name}")
            return payload
        raise ValueError(f"unknown tool {name!r}")

    # ── the finding: an event, plus an optional Slack copy ────────────────────
    def _entity_label(self, trigger_name: str) -> str | None:
        """Which label the firing entity was identified by — the key field of the trigger's view,
        else the primary label of one of that view's sources. The finding must be stamped with the
        same axis as its evidence, or a label-native `read` for the entity won't return it."""
        catalog = self.runtime.catalog
        trig = next((t for t in catalog.triggers if t.name == trigger_name), None)
        view = catalog.views.get(trig.view) if trig else None
        if view is None:
            return None
        if view.key_field:
            return view.key_field
        for src_name in view.sources:
            src = catalog.sources.get(src_name)
            for spec in (src.config.get("labels") or []) if src else []:
                if spec.get("primary"):
                    return spec.get("name")
        return None

    async def _record(self, agent: dict, trigger_name: str, key: str, finding: str) -> None:
        if FINDINGS_SOURCE not in self.runtime.catalog.sources:
            # provisioned on the first finding, like the memory source — a fresh install has no
            # reason to carry an empty one. No `labels` config: the runner stamps them per event.
            self.store.upsert_catalog_source(FINDINGS_SOURCE, "finding", "finding", "5s", {})
            self.runtime.reload_catalog()
            print(f"taresd: auto-provisioned findings source {FINDINGS_SOURCE!r}")

        label = self._entity_label(trigger_name)
        await self.runtime.ingest(FINDINGS_SOURCE, {
            "key": key, "finding": finding, "agent": agent["name"], "trigger": trigger_name,
            "prompt_hash": prompt_hash(agent["prompt"]),
            "labels": {label: key} if label else {},
        })
        # Notification: the workspace bot posting to a channel is the primary path (one token,
        # picked from a list, no credential per agent); the per-agent incoming webhook stays as
        # the secondary/legacy path. An agent uses one — channel wins when both are set.
        channel = (agent.get("slack_channel") or "").strip()
        hook = agent.get("slack_webhook")
        if channel:
            await self._slack_channel(agent["name"], channel, trigger_name, key, finding)
        elif hook:
            await self._slack(agent["name"], hook, trigger_name, key, finding)

    async def _slack_channel(self, agent_name: str, channel: str, trigger_name: str,
                             key: str, finding: str) -> None:
        """Post the finding through the workspace bot (`chat.postMessage`). Same message shape as
        the webhook path — the full finding, standing alone — but the credential is the one bot
        token the instance already holds, and the target is a channel picked from a list.

        One attempt, verdict from `slack.classify` (Slack answers HTTP 200 with ok:false), failure
        printed — a notification failing must never lose the finding, which is already stored."""
        from . import slack as _slack_mod
        token, _origin = _slack_mod.resolve_token(self.store)
        if not token:
            print(f"[agent {agent_name}] slack: no bot token configured, channel post skipped")
            return
        link = _slack_deep_link(key)
        text = f"*{agent_name}* · `{trigger_name}` fired for *{key}*\n\n{finding}{link}"
        try:
            async with httpx.AsyncClient(timeout=15) as cx:
                r = await cx.post(f"{_slack_mod.API_BASE}/chat.postMessage",
                                  json={"channel": channel, "text": text},
                                  headers={"authorization": f"Bearer {token}"})
                try:
                    data = r.json()
                except Exception:
                    data = None
                ok, error, _retry = _slack_mod.classify(r.status_code, data)
                if not ok:
                    print(f"[agent {agent_name}] slack: {error}")
        except Exception as e:   # notification failing must never lose the finding
            print(f"[agent {agent_name}] slack: {type(e).__name__}: {e}")

    async def _slack(self, agent_name: str, hook: str, trigger_name: str, key: str,
                     finding: str) -> None:
        """Slack carries the FULL finding, not a pointer. A local install has no reachable URL, and
        a link to 127.0.0.1 is worse than no link — so the message must stand alone. The text is the
        stored finding verbatim; a summary here would become a second, divergent record.

        A deep link is appended only when the instance knows it is reachable (TARES_PUBLIC_URL) —
        the same rule the slack:// dispatch sink applies, hence the shared helper.

        This is the ORIGINAL per-agent incoming-webhook path and stays as it is. The way forward is
        a `slack://channel/<id>` subscription (`tares/slack.py`), which is per-trigger, retried
        and logged in the delivery ledger; existing agents are not migrated.
        """
        link = _slack_deep_link(key)
        text = f"*{agent_name}* · `{trigger_name}` fired for *{key}*\n\n{finding}{link}"
        try:
            async with httpx.AsyncClient(timeout=15) as cx:
                r = await cx.post(hook, json={"text": text})
                if r.status_code >= 300:
                    print(f"[agent {agent_name}] slack: HTTP {r.status_code} {r.text[:120]}")
        except Exception as e:   # notification failing must never lose the finding
            print(f"[agent {agent_name}] slack: {type(e).__name__}: {e}")

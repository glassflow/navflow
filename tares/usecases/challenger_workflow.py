"""Use case: challenger workflow.

A user works in Claude Code on their laptop and marks a session as a challenger session (Claude
calls the `set_session_flow` MCP tool). From then on a second model, the Codex CLI running on the
laptop, challenges Claude's plan and every commit; the Tares plugin ships the whole exchange into
the `claude_code` source on one session timeline. Tares is the record and the after-session
brain, never the control point: nothing here decides whether Codex runs.

This recipe owns the Tares side: the `claude_code` source (adopted from the plugin, which creates
it on first run), a view per session, a trigger that fires when a challenger session ends, and a
Tares agent that reads the session and writes one finding: the session summary and up to five
memory proposals. Proposals live inside the finding; nothing is written to memory until a person
accepts one from the console, so only accepted memory ever exists.
"""
from __future__ import annotations

import re

from .base import PlannedObject, Recipe, UsecaseError
from .registry import register

FLOW = "challenger"
SOURCE = "claude_code"           # the plugin's own name for the source, adopted as is
VIEW = "challenger_session"
ENDS_VIEW = "challenger_session_ends"
TRIGGER = "challenger_session_ended"
AGENT = "challenger_summarizer"
PROPOSALS_HEADING = "Memory proposals"
MAX_PROPOSALS = 5

PROMPT = """You are handed the end of one Claude Code session that ran as a challenger session: the user \
worked with Claude, and Codex (a second model on the user's laptop) challenged Claude's plan and \
every commit. Your key is the session id. Before writing anything, call `read` with \
{{"session": "<the key>"}} and window "24h" once to get the whole session: user prompts, Claude's \
turns, tool calls, the plan, each Codex challenge (challenge_plan / challenge_commit events with a \
verdict and findings), fix rounds, waived findings, commits, and token usage.

Write the session summary in plain sentences, no em dashes, under these headings:

Summary
What the user asked for and what was built (name the commits). Whether the goal was reached.

Plan
What the plan was, what Codex found in it, and how the plan changed as a result.

Challenges
For each reviewed commit: the verdict, what Codex caught, how Claude resolved it, how many rounds \
it took. Findings the user waived and the reason if the session shows one.

Cost
Tokens and cost if the timeline carries them, otherwise say they were not recorded.

{heading}
Up to {max_proposals} durable facts about this repository or this user's way of working that would save \
time in the next session. One per line, starting with "- ". Only facts the session supports, none \
about this session's specifics. Skip the heading if there are none.

Do not speculate beyond the evidence. The summary is your final message and nothing else.
""".format(heading=PROPOSALS_HEADING, max_proposals=MAX_PROPOSALS)


class ChallengerWorkflow(Recipe):
    key = "challenger_workflow"
    title = "Challenger workflow"
    description = ("Let a second model challenge Claude Code's plan and every commit on your laptop, "
                   "keep the whole exchange on one session timeline, and get a session summary "
                   "with memory proposals when the session ends.")
    tags = ()
    guide = {"label": "Challenger workflow guide",
             "url": "https://docs.glassflow.ai/tares/guides/challenger-workflow"}

    PARAMS = {
        "slack_channel": {"type": "string", "default": "", "label": "Slack channel",
                          "help": "post each session summary to this channel id (needs the Slack "
                                  "surface set up); empty = console only"},
        "model": {"type": "string", "default": "", "label": "Model",
                  "help": "model for the summarizer (empty = the instance default)"},
    }

    SETUP = [
        {"title": "Install the Tares plugin in Claude Code",
         "text": "The plugin streams every session into Tares and registers the tares MCP server. "
                 "One install, then /reload-plugins.",
         "command": "/plugin marketplace add glassflow/tares\n/plugin install tares@tares"},
        {"title": "Install the challenger",
         "text": "Codex runs on your laptop and is billed to your OpenAI account; Tares never calls it.",
         "command": "npm install -g @openai/codex\ncodex login"},
        {"title": "Give the summarizer a key", "check": "anthropic_key",
         "text": "The summarizer is a real agent: it needs an Anthropic key. Set one here or under "
                 "Settings > Anthropic."},
        {"title": "Start a challenger session",
         "text": "In any Claude Code session say \"make this a challenger session\" or type "
                 "/tares:challenger. Claude marks the session; the plan and every commit get "
                 "challenged from then on, and the summary lands here when the session ends."},
    ]

    ACTIONS = [
        {"name": "summarize", "label": "Summarize a session now",
         "help": "run the summarizer on one session without waiting for it to end (the session id "
                 "is the key on the claude_code timeline)",
         "params": {"session": {"label": "session id", "type": "string"}}},
    ]

    def _facts(self) -> dict:
        return {"you": ["install the Tares plugin and Codex on your laptop",
                        "say \"make this a challenger session\" at the start of a session",
                        "accept or reject the memory proposals after each session"],
                "tares": ["the full Claude and Codex exchange on one timeline per session",
                          "a trigger that fires when a challenger session ends",
                          "an agent that writes the session summary and memory proposals",
                          "accepted memory handed to Claude at the next session start"]}

    def describe(self) -> dict:
        d = super().describe()
        d["facts"] = self._facts()
        return d

    # ── params ───────────────────────────────────────────────────────────────
    def validate(self, params: dict) -> dict:
        p = super().validate(params)
        ch = str(p.get("slack_channel") or "").strip()
        if ch and not re.fullmatch(r"[A-Z][A-Z0-9]{6,}", ch):
            raise UsecaseError("slack_channel must be a Slack channel id like C0123456789")
        p["slack_channel"] = ch
        p["model"] = str(p.get("model") or "").strip()
        return p

    # ── plan ─────────────────────────────────────────────────────────────────
    def plan(self, params: dict) -> list[PlannedObject]:
        objs = [
            # the same source the plugin creates on its first run (push is the connector's
            # default, so the stored config is empty either way): an existing one is adopted
            # unchanged rather than reconfigured
            PlannedObject("source", "source", {
                "name": SOURCE, "connector": "claude_code", "poll": "10s", "config": {}}),
            # the session timeline people and the agent read. The summarizer's finding lands on
            # the same session key and joins it through `read` (the findings source is internal,
            # provisioned by the daemon on the first finding, so a view must not name it).
            PlannedObject("view", "view", {
                "name": VIEW, "key_field": "session", "sources": [SOURCE]}),
            # the detection view: only the end-of-session line of a challenger session. The
            # plugin stamps `flow` on every line of a marked session and writes a session_end
            # line when the session closes.
            PlannedObject("view", "ends", {
                "name": ENDS_VIEW, "key_field": "session", "sources": [SOURCE],
                "filters": [{"field": "event_type", "op": "eq", "value": "session_end"},
                            {"field": "flow", "op": "eq", "value": FLOW}]}),
            PlannedObject("trigger", "trigger", {
                "name": TRIGGER, "view": ENDS_VIEW,
                "condition": {"aggregate": "count", "predicate": "> 0", "window": "5m",
                              "group_by": ["key_value"]},
                "emit": {"kind": "session_ended", "attach_view": True, "context_window": "24h"},
                "cooldown": "30m"}),
        ]
        agent = {"name": AGENT, "trigger": TRIGGER, "prompt": PROMPT, "enabled": True,
                 "max_rounds": 6}
        if params.get("model"):
            agent["model"] = params["model"]
        if params.get("slack_channel"):
            agent["slack_channel"] = params["slack_channel"]
        objs.append(PlannedObject("agent", "agent", agent))
        return objs

    # ── actions ──────────────────────────────────────────────────────────────
    def run_action(self, instance: dict, action: str, args: dict, store, runtime) -> dict:
        if action != "summarize":
            raise UsecaseError(f"{self.key}: no action {action!r}")
        session = str(args.get("session") or "").strip()
        if not session:
            raise UsecaseError("session id is required")
        agents = getattr(getattr(runtime, "dispatcher", None), "agents", None)
        if agents is None or not hasattr(agents, "run_now"):
            raise UsecaseError("the agent runner is not available")
        run_id = agents.run_now(AGENT, TRIGGER, session, f"summarize session {session} on request")
        return {"session": session, "run_id": run_id,
                "message": f"summarizer started on session {session}; its finding appears under Runs"}

    # ── summary (the use case page) ──────────────────────────────────────────
    def summary(self, instance: dict, store) -> dict:
        params = self.validate(instance["params"])
        stats = {x["source"]: x for x in store.event_stats()}
        st = stats.get(SOURCE) or {}
        runs = []
        for r in store.list_agent_runs(AGENT, limit=20):
            finding = r.get("finding") or ""
            runs.append({"id": r.get("id"), "started_at": _iso(r.get("started_at")),
                         "key": r.get("key"), "session": r.get("key"), "agent": AGENT,
                         "status": r.get("status"), "rounds": r.get("rounds"),
                         "max_rounds": r.get("max_rounds"), "finding": finding,
                         "proposals": parse_proposals(finding), "error": r.get("error")})
        return {"source": SOURCE, "events": int(st.get("events") or 0),
                "last_event": _iso(st.get("last_ingest")),
                "slack_channel": params["slack_channel"], "runs": runs, "runs_total": len(runs),
                "sessions_summarized": len({r["session"] for r in runs if r["status"] == "ok"}),
                "names": {"view": VIEW, "ends_view": ENDS_VIEW, "trigger": TRIGGER, "agent": AGENT},
                "guide": self.guide["url"]}


_HEADING_RE = re.compile(rf"^\s*#*\s*{PROPOSALS_HEADING}\s*:?\s*$", re.IGNORECASE | re.MULTILINE)


def parse_proposals(finding: str) -> list[str]:
    """The memory proposals section of a summarizer finding: the "- " lines after the heading, up
    to the next heading or the end. Empty when the agent skipped the section."""
    m = _HEADING_RE.search(finding or "")
    if not m:
        return []
    out = []
    for line in finding[m.end():].splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith(("- ", "* ")):
            out.append(s[2:].strip())
        elif out or not s.startswith(("-", "*")):
            break   # a new heading or prose ends the list
    return out[:MAX_PROPOSALS]


def _iso(v):
    if v is None:
        return None
    return v.isoformat() if hasattr(v, "isoformat") else str(v)


register(ChallengerWorkflow())

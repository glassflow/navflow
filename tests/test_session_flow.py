"""TR-195: the set_session_flow MCP tool only acknowledges, and the claude_code connector turns a
session_flow line (and a `flow` stamp on any line) into a `flow` label triggers and views can use."""
import asyncio
from types import SimpleNamespace

P = F = 0
def ck(l, c, d=""):
    global P, F; P += 1 if c else 0; F += 0 if c else 1
    print(("  ok   " if c else "  FAIL ") + l + ("" if c else f"  {d}"))


def main():
    from tares.connectors.claude_code import ClaudeCodeConnector
    from tares import mcp_server

    cfg = SimpleNamespace(name="claude_code", type="claude_code", config={})
    c = ClaudeCodeConnector(cfg, store=None)
    flow_line = {"sessionId": "s1", "type": "session_flow", "flow": "challenger",
                 "cwd": "/tmp/proj", "timestamp": "2026-08-26T10:00:00Z"}
    envs = c.map_payload([flow_line])
    ck("session_flow line maps to one event", len(envs) == 1)
    e = envs[0]
    ck("event_type is session_flow", e.event_type == "session_flow", e.event_type)
    ck("flow label set", e.labels.get("flow") == "challenger", str(e.labels))
    ck("text names the flow", e.text == "session flow: challenger", e.text)

    stamped = {"sessionId": "s1", "type": "assistant", "flow": "challenger", "cwd": "/tmp/proj",
               "timestamp": "2026-08-26T10:00:01Z",
               "message": {"role": "assistant", "content": [{"type": "text", "text": "hi"}]}}
    e = c.map_payload(stamped)[0]
    ck("flow stamp on an ordinary line becomes a label", e.labels.get("flow") == "challenger")
    ck("ordinary line keeps its type", e.event_type == "assistant")

    plain = {"sessionId": "s1", "type": "user", "cwd": "/tmp/proj",
             "message": {"role": "user", "content": "hello"}}
    e = c.map_payload(plain)[0]
    ck("no flow, no label", "flow" not in e.labels, str(e.labels))
    cleared = c.map_payload({"sessionId": "s1", "type": "session_flow", "flow": ""})[0]
    ck("cleared flow renders", cleared.text == "session flow: cleared", cleared.text)
    ck("flow is a declared axis", any(p["name"] == "flow" for p in ClaudeCodeConnector.PROVIDES))

    tools = asyncio.run(mcp_server.mcp.list_tools())
    ck("set_session_flow is an MCP tool", any(t.name == "set_session_flow" for t in tools))
    ack = asyncio.run(mcp_server.set_session_flow("challenger"))
    ck("ack names the flow", "challenger" in ack, ack)
    ack = asyncio.run(mcp_server.set_session_flow(""))
    ck("empty flow acks a clear", "clear" in ack, ack)

    print(f"\n{P} passed, {F} failed")
    raise SystemExit(1 if F else 0)


if __name__ == "__main__":
    main()

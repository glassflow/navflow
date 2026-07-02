"""A tiny webhook that prints NavFlow dispatches — stands in for the agent being woken.

    python examples/woke_receiver.py        # listens on http://127.0.0.1:9999/woke

Subscribe it to a trigger, then inject a fault on the platform and watch it wake up holding the
correlated timeline.
"""
from __future__ import annotations

from fastapi import FastAPI, Request
import uvicorn

app = FastAPI()


@app.post("/woke")
async def woke(req: Request):
    body = await req.json()
    print(f"\n=== WOKEN by trigger '{body.get('trigger')}' "
          f"(dispatch {body.get('dispatch_id')}) key={body.get('key')} ===", flush=True)
    print(body.get("payload", ""), flush=True)
    return {"ok": True}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=9999)

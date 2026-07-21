import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { api, auth } from "../api";
import { Close, Search } from "../components/icons";
import { TimeAgo, usePolling } from "../components/bits";
import type { DispatchLogEntry } from "../types";

// Two pages share this module: Connect (how an agent hooks up — one tab per integration mode)
// and AgentActivity (what agents have been doing — reads + trigger dispatches).
type ConnectTab = "mcp" | "push" | "rest" | "tools";
const CONNECT_LABELS: Record<ConnectTab, string> = {
  mcp: "MCP (pull)", push: "Webhook (push)", rest: "REST", tools: "Tools",
};

export function ConnectPage() {
  const [tab, setTab] = useState<ConnectTab>("mcp");

  return (
    <>
      <h1>Connect</h1>
      <p className="subtitle">
        hook an agent up to this NavFlow — <em>it pulls (MCP), gets pushed (webhook), or calls
        plain REST</em>
      </p>

      <div className="tabs">
        {(Object.keys(CONNECT_LABELS) as ConnectTab[]).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{CONNECT_LABELS[t]}</button>
        ))}
      </div>

      <Connect tab={tab} />
    </>
  );
}

type ActivityTab = "agents" | "queries" | "dispatches";
const ACTIVITY_LABELS: Record<ActivityTab, string> = {
  agents: "Agents", queries: "Reads", dispatches: "Trigger dispatches",
};

export default function AgentActivity() {
  const [tab, setTab] = useState<ActivityTab>("agents");

  return (
    <>
      <h1>Agents</h1>
      <p className="subtitle">who is connected, and what agents have been doing — every wake, read and dispatch</p>

      <div className="tabs">
        {(Object.keys(ACTIVITY_LABELS) as ActivityTab[]).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{ACTIVITY_LABELS[t]}</button>
        ))}
      </div>

      {tab === "agents" && <AgentsRoster />}
      {tab === "queries" && <Queries />}
      {tab === "dispatches" && <Dispatches />}
    </>
  );
}

/** Shared filter toolbar: a search box + a live "N of M" count. */
function Toolbar({ q, setQ, placeholder, shown, total }: {
  q: string; setQ: (s: string) => void; placeholder: string; shown: number; total: number;
}) {
  return (
    <div className="toolbar">
      <div className="search-box">
        <Search />
        <input type="text" className="search" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <span className="grow" />
      <span className="count">{shown} of {total}</span>
    </div>
  );
}

function Copy({ text, label = "copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="copybtn" onClick={() => { navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>
      {done ? "copied" : label}
    </button>
  );
}

function CodeBlock({ title, code }: { title: string; code: string }) {
  return (
    <div className="codeblock">
      <div className="codeblock-head"><span>{title}</span><Copy text={code} /></div>
      <pre className="payload">{code}</pre>
    </div>
  );
}

function Connect({ tab }: { tab: ConnectTab }) {
  const origin = window.location.origin;
  const [authReq, setAuthReq] = useState<boolean>();
  const [status, setStatus] = useState<"checking" | "live" | "absent">("checking");
  const [url, setUrl] = useState(`${origin}/mcp`);
  const [tools, setTools] = useState<{ name: string; description: string }[]>();
  const [triggers, setTriggers] = useState<{ name: string }[]>();
  const [trig, setTrig] = useState<string>();
  const [reveal, setReveal] = useState(false);
  const [toolQ, setToolQ] = useState("");
  const token = auth.get();

  useEffect(() => {
    api.health().then((h) => setAuthReq(h.auth_required)).catch(() => setAuthReq(false));
    api.mcpTools().then(setTools).catch(() => setTools([]));
    api.triggers().then((t) => { setTriggers(t); if (t.length) setTrig(t[0].name); })
      .catch(() => setTriggers([]));

    // The MCP endpoint sits in one of two places: same host/port behind a reverse proxy
    // (the compose deployment — Caddy routes /mcp to the MCP server), or on its own port
    // when `navflow mcp` runs as a separate process locally (the documented default, :8788).
    const loc = window.location;
    const sameOrigin = `${origin}/mcp`;
    const localPort = `${loc.protocol}//${loc.hostname}:8788/mcp`;

    const probe = async (target: string, ms = 2500): Promise<boolean> => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), ms);
      try {
        if (target === sameOrigin) {
          // same-origin: a real MCP server answers non-HTML; the SPA catch-all returns HTML.
          const r = await fetch(target, { headers: { Accept: "application/json, text/event-stream" }, signal: ctl.signal });
          return !(r.headers.get("content-type") || "").includes("text/html");
        }
        // cross-origin: the MCP server sends no CORS headers, so we can't read the response —
        // but a no-cors fetch that resolves (rather than failing on connection refused) means
        // something is listening on that port.
        await fetch(target, { mode: "no-cors", signal: ctl.signal });
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    };

    (async () => {
      if (await probe(sameOrigin)) { setUrl(sameOrigin); setStatus("live"); return; }
      if (localPort !== sameOrigin && (await probe(localPort))) { setUrl(localPort); setStatus("live"); return; }
      setStatus("absent");
    })();
  }, [origin]);
  const tok = authReq ? (token || "<your-access-token>") : "";
  const shownTok = authReq && !reveal && token ? "••••••••" : tok;

  const claudeCode = (t: string) =>
    `claude mcp add --transport http navflow ${url}` + (authReq ? ` --header "Authorization: Bearer ${t}"` : "");
  const httpJson = (t: string) => JSON.stringify({
    mcpServers: { navflow: { type: "http", url, ...(authReq ? { headers: { Authorization: `Bearer ${t}` } } : {}) } },
  }, null, 2);
  const stdioJson = (t: string) => JSON.stringify({
    mcpServers: { navflow: { command: "navflow-mcp", env: { NAVFLOWD_URL: origin, ...(authReq ? { NAVFLOW_AUTH_TOKEN: t } : {}) } } },
  }, null, 2);
  const subscribeCurl = (t: string) =>
    `curl -X POST ${origin}/subscribe \\\n` +
    `  -H 'Content-Type: application/json' \\\n` +
    (authReq ? `  -H 'Authorization: Bearer ${t}' \\\n` : "") +
    `  -d '{"trigger": "${trig ?? "<trigger>"}", "url": "https://your-agent.example.com/hook"}'`;
  const queryCurl = (t: string) =>
    `curl -X POST ${origin}/query \\\n` +
    `  -H 'Content-Type: application/json' \\\n` +
    (authReq ? `  -H 'Authorization: Bearer ${t}' \\\n` : "") +
    `  -d '{"view": "<view>", "key": "<entity>", "window": "15m"}'`;

  const shownTools = useMemo(() => {
    const needle = toolQ.trim().toLowerCase();
    return (tools ?? []).filter((t) =>
      !needle || t.name.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle));
  }, [tools, toolQ]);

  return (
    <div className="connect">
      {tab === "mcp" && (
        <div className={`mcp-status ${status}`}>
          {status === "checking" && "checking the MCP endpoint…"}
          {status === "live" && <span>MCP endpoint is live at <span className="mono">{url}</span></span>}
          {status === "absent" && <span>No MCP endpoint found — neither at <span className="mono">{origin}/mcp</span> (reverse-proxied) nor on the default port <span className="mono">:8788</span> (separate process). Run <span className="mono">navflow mcp</span> alongside the daemon (the compose deployment includes it), or use the <strong>stdio</strong> proxy below.</span>}
        </div>
      )}

      {tab === "mcp" && authReq && (
        <div className="panel" style={{ marginTop: 14 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <div><span className="lbl">access token</span> <span className="mono">{shownTok}</span></div>
            <div className="btnrow">
              <button onClick={() => setReveal((r) => !r)}>{reveal ? "hide" : "reveal"}</button>
              {token && <Copy text={token} label="copy token" />}
            </div>
          </div>
          <p className="help" style={{ marginTop: 6, whiteSpace: "normal" }}>
            This is your console access token — it works in the snippets below, but it carries{" "}
            <strong>full admin rights</strong>. For an agent, prefer a{" "}
            <span className="mono">read</span>-scoped API key from the{" "}
            <Link to="/security">Security page</Link> (add <span className="mono">ingest</span> if
            the agent also writes memories) and paste it in place of the token.
          </p>
        </div>
      )}

      {tab === "push" && (
        <>
          <p className="help" style={{ whiteSpace: "normal", marginTop: 14 }}>
            Flip the loop: NavFlow watches, the agent sleeps. When a trigger&rsquo;s condition
            trips, NavFlow POSTs the <strong>correlated timeline</strong> to a URL your agent
            listens on — the investigation starts with the evidence already attached,{" "}
            <strong>zero reads</strong>. (In our SRE incident benchmark the same diagnosis took 6
            fan-out reads baseline, 1 correlated read over MCP, 0 when pushed.)
          </p>

          <h3 style={{ marginBottom: 4 }}>1 · Give your agent an HTTP endpoint</h3>
          <p className="help" style={{ whiteSpace: "normal" }}>
            Anything that accepts a POST and starts your agent with the request body as context — a
            small FastAPI/Express route, a serverless function, a workflow-engine webhook. It must
            be reachable <em>from this NavFlow server</em>. Every delivery is JSON shaped like:
          </p>
          <CodeBlock title="what your endpoint receives on each firing" code={JSON.stringify({
            dispatch_id: "9f2c81d4…",
            trigger: trig ?? "error_spike",
            kind: "alert",
            key: "api-server",
            fired_at: "2026-07-17T09:14:03+00:00",
            payload: "…the correlated timeline for this entity, ready to hand to the model…",
          }, null, 2)} />
          <p className="help" style={{ whiteSpace: "normal" }}>
            Delivery is <strong>at-least-once</strong> with retries — dedupe on{" "}
            <span className="mono">dispatch_id</span>. Answer anything below 500 to acknowledge.
          </p>

          <h3 style={{ marginBottom: 4 }}>2 · Subscribe that endpoint to a trigger</h3>
          {triggers && triggers.length > 0 ? (
            <>
              <p className="help" style={{ whiteSpace: "normal" }}>
                A trigger is a condition NavFlow evaluates continuously over a view. Pick one,
                replace the URL with your endpoint, and run (needs a{" "}
                <span className="mono">read</span>-scoped <Link to="/security">API key</Link>;
                revoking the key removes its subscriptions):
              </p>
              <p className="help" style={{ whiteSpace: "normal" }}>
                Wiring happens on the trigger itself: open <Link to="/triggers">Triggers</Link>,
                hit <strong>agents</strong> on the trigger, and paste your endpoint there. From a
                script, the same action is:
              </p>
              <CodeBlock title="subscribe your agent's endpoint" code={subscribeCurl(shownTok)} />
            </>
          ) : (
            <p className="help" style={{ whiteSpace: "normal" }}>
              This instance has no triggers yet, so there is nothing to subscribe to — create one
              under <Link to="/triggers">Triggers</Link> (a condition over a view), then come back
              here.
            </p>
          )}

          <h3 style={{ marginBottom: 4 }}>3 · That&rsquo;s the loop</h3>
          <p className="help" style={{ whiteSpace: "normal" }}>
            From now on every firing wakes your agent with the timeline attached; it can query back
            over MCP or REST if it needs more, and <span className="mono">remember</span> its
            conclusion so the next dispatch arrives with prior findings included. Every wired
            endpoint shows up under <Link to="/activity">Agents</Link> with its delivery history
            (firings are logged even with no subscribers — useful to test a trigger before wiring
            the agent). Full walkthrough and a runnable incident-response example:{" "}
            <a href="https://www.navflow.ai/docs/agents" target="_blank" rel="noreferrer">
              navflow.ai/docs/agents</a>.
          </p>

        </>
      )}

      {tab === "rest" && (
        <>
          <p className="help" style={{ whiteSpace: "normal", marginTop: 14 }}>
            No MCP client? The same read surface is plain HTTP — one call returns the correlated
            timeline. Agents can also write conclusions back with{" "}
            <span className="mono">POST /remember</span> (needs <span className="mono">ingest</span>),
            so the next timeline arrives with prior findings attached.
          </p>
          <CodeBlock title="read a correlated timeline" code={queryCurl(shownTok)} />
        </>
      )}

      {tab === "mcp" && (
        <>
      <p className="help" style={{ whiteSpace: "normal", marginTop: 14 }}>
        The agent connects as an MCP client and reads on demand: <span className="mono">read</span>,{" "}
        <span className="mono">query</span>, <span className="mono">catalog_*</span> — one correlated
        timeline per call instead of fanning out across your systems. Needs a{" "}
        <span className="mono">read</span>-scoped key.
      </p>

      <h3 style={{ marginBottom: 4 }}>Any MCP client (HTTP)</h3>
      <CodeBlock title="add to the client's MCP config" code={httpJson(shownTok)} />

      <h3 style={{ marginBottom: 4 }}>Claude Code</h3>
      <CodeBlock title="run in your terminal" code={claudeCode(tok)} />

      <h3 style={{ marginBottom: 4 }}>stdio (agent on the same machine, or no /mcp endpoint)</h3>
      <p className="help" style={{ whiteSpace: "normal" }}>
        Requires <span className="mono">pip install navflow</span> where the agent runs; it proxies to this daemon.
      </p>
      <CodeBlock title="MCP config (stdio)" code={stdioJson(shownTok)} />
        </>
      )}

      {tab === "tools" && (
        <>
      <h3 style={{ marginTop: 14 }}>Tools the agent gets {tools && <span className="dim">· {tools.length}</span>}</h3>
      <p className="help" style={{ whiteSpace: "normal" }}>
        Exactly what a connected agent can call — read straight from this instance&rsquo;s MCP
        surface, so it always matches what MCP (pull) serves. The same read/query operations back
        the REST endpoints.
      </p>
      {tools && tools.length > 0 && (
        <>
          <div className="toolbar">
            <div className="search-box">
              <Search />
              <input type="text" className="search" placeholder="Filter tools…" value={toolQ} onChange={(e) => setToolQ(e.target.value)} />
            </div>
            <span className="grow" />
            <span className="count">{shownTools.length} of {tools.length}</span>
          </div>
          <table>
            <thead><tr><th>tool</th><th>what it does</th></tr></thead>
            <tbody>
              {shownTools.map((t) => (
                <tr key={t.name}><td className="mono">{t.name}</td><td className="help" style={{ whiteSpace: "normal" }}>{t.description}</td></tr>
              ))}
              {!shownTools.length && (
                <tr><td colSpan={2} className="dim" style={{ textAlign: "center", padding: 24 }}>no tools match “{toolQ}”</td></tr>
              )}
            </tbody>
          </table>
        </>
      )}
        </>
      )}
    </div>
  );
}

function AgentsRoster() {
  const { data, error } = usePolling(() => api.agents(), 10000);
  const [params] = useSearchParams();
  const [open, setOpen] = useState<string | undefined>(params.get("agent") ?? undefined);
  const [err, setErr] = useState<string>();

  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <div className="dim">loading…</div>;
  if (!data.agents.length) {
    return (
      <div className="empty">
        no agents connected — subscribe one to a trigger on the <Link to="/triggers">Triggers</Link> page
      </div>
    );
  }
  return (
    <>
      {err && <div className="alert error">{err}</div>}
      <table>
        <thead><tr><th>agent</th><th>endpoint</th><th>wakes on</th><th className="num">delivered</th><th className="num">failed</th><th>last woken</th><th></th></tr></thead>
        <tbody>
          {data.agents.map((a) => (
            <>
              <tr key={a.name} className="clickable" onClick={() => setOpen(open === a.name ? undefined : a.name)}>
                <td>
                  <strong>{a.name}</strong>
                  {a.unhealthy && <span className="badge error" style={{ marginLeft: 8 }} title={a.last_error ?? "last delivery failed"}>failing</span>}
                </td>
                <td className="mono">{a.endpoint}</td>
                <td>{a.triggers.map((t) => <span className="chip mono" key={t}>{t}</span>)}</td>
                <td className="num">{a.delivered_ok}</td>
                <td className="num" style={a.delivered_fail ? { color: "var(--err)" } : undefined}>{a.delivered_fail}</td>
                <td style={{ whiteSpace: "nowrap" }}>{a.last_woken ? <TimeAgo ts={a.last_woken} /> : <span className="help">never</span>}</td>
                <td className="dim">{open === a.name ? "▾" : "▸"}</td>
              </tr>
              {open === a.name && (
                <tr key={a.name + "-detail"}>
                  <td colSpan={7} style={{ background: "var(--wash, transparent)" }}>
                    <div style={{ padding: "8px 4px" }}>
                      <p className="help" style={{ margin: "0 0 8px", whiteSpace: "normal" }}>
                        first seen <TimeAgo ts={a.first_seen} />
                        {a.created_by.length > 0 && <> · wired by <span className="mono">{a.created_by.join(", ")}</span></>}
                      </p>
                      {a.subscriptions.map((sub) => (
                        <div key={sub.subscription_id} className="btnrow" style={{ marginBottom: 6, alignItems: "center" }}>
                          <span className="chip mono">{sub.trigger}</span>
                          <span className="help mono">{sub.subscription_id}</span>
                          <button className="danger" onClick={async (e) => {
                            e.stopPropagation();
                            try { await api.unsubscribe(sub.subscription_id); }
                            catch (ex) { setErr(String((ex as Error).message ?? ex)); }
                          }}>unsubscribe</button>
                        </div>
                      ))}
                      {a.recent.length > 0 && (
                        <>
                          <p className="help" style={{ margin: "10px 0 4px" }}>recent wakes</p>
                          <table>
                            <thead><tr><th>when</th><th>trigger</th><th>entity</th><th>delivery</th></tr></thead>
                            <tbody>
                              {a.recent.map((r, i) => (
                                <tr key={i}>
                                  <td style={{ whiteSpace: "nowrap" }}><TimeAgo ts={r.at} /></td>
                                  <td className="mono">{r.trigger}</td>
                                  <td className="mono">{r.key}</td>
                                  <td>{r.ok ? <span className="badge ok">delivered</span> : <span className="badge error" title={r.error ?? undefined}>failed{r.error ? `: ${r.error}` : ""}</span>}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Queries() {
  const { data, error } = usePolling(() => api.queries(150));
  const [q, setQ] = useState("");
  const [client, setClient] = useState("mcp");  // default to agent reads — the interesting traffic

  // Filter options: "all" + mcp (always, the important one) + whatever else appears (ui, http).
  const clientOpts = useMemo(
    () => ["all", ...Array.from(new Set(["mcp", ...(data ?? []).map((r) => r.client)]))],
    [data],
  );

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? []).filter((row) =>
      (client === "all" || row.client === client) &&
      (!needle || row.view.toLowerCase().includes(needle) || row.key.toLowerCase().includes(needle) ||
        row.client.toLowerCase().includes(needle)));
  }, [data, q, client]);

  if (error) return <div className="alert error">{error}</div>;
  if (!data?.length) return <div className="empty">no reads yet — connect an agent in Connect and its reads show up here.</div>;
  return (
    <>
      <div className="toolbar">
        <div className="search-box">
          <Search />
          <input type="text" className="search" placeholder="Filter by view, key, client…"
                 value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="seg small" aria-label="client">
          {clientOpts.map((c) => (
            <button key={c} className={client === c ? "active" : ""} onClick={() => setClient(c)}>{c}</button>
          ))}
        </div>
        <span className="grow" />
        <span className="count">{shown.length} of {data.length}</span>
      </div>
      {!shown.length ? (
        <div className="empty">
          no <span className="mono">{client}</span> reads{q && <> matching “{q}”</>} in the last {data.length}
          {client === "mcp" && <> — connect an agent in Connect, or switch the client filter above.</>}
        </div>
      ) : (
        <table>
          <thead><tr><th>when</th><th>client</th><th>view</th><th>key</th><th>window</th><th className="num">rows</th></tr></thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.id}>
                <td style={{ whiteSpace: "nowrap" }}><TimeAgo ts={row.queried_at} /></td>
                <td><span className={`badge ${row.client === "mcp" ? "agent" : "starting"}`}>{row.client}</span></td>
                <td className="mono">{row.view}</td>
                <td className="mono">{row.key}</td>
                <td className="mono">{row.window}</td>
                <td className="num">{row.rows_returned}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function deliveryBadge(d: DispatchLogEntry) {
  if (d.subscribers === 0) return <span className="badge starting">no subscribers</span>;
  const cls = d.delivered === d.subscribers ? "ok" : "error";
  return <span className={`badge ${cls}`}>{d.delivered}/{d.subscribers} delivered</span>;
}

function Dispatches() {
  const { data, error } = usePolling(() => api.dispatches(150));
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<DispatchLogEntry | null>(null);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? []).filter((d) =>
      !needle || d.trigger.toLowerCase().includes(needle) || d.key.toLowerCase().includes(needle) ||
      d.kind.toLowerCase().includes(needle));
  }, [data, q]);

  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSel(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel]);

  if (error) return <div className="alert error">{error}</div>;
  if (!data?.length) return <div className="empty">no trigger firings yet</div>;
  return (
    <>
      <Toolbar q={q} setQ={setQ} placeholder="Filter by trigger, key, kind…" shown={shown.length} total={data.length} />
      <table>
        <thead><tr><th>fired</th><th>trigger</th><th>key</th><th>kind</th><th>delivery</th></tr></thead>
        <tbody>
          {shown.map((d) => (
            <tr
              key={d.dispatch_id}
              className={"clickable" + (sel?.dispatch_id === d.dispatch_id ? " sel" : "")}
              onClick={() => setSel(d)}
            >
              <td style={{ whiteSpace: "nowrap" }}><TimeAgo ts={d.fired_at} /></td>
              <td className="mono">{d.trigger}</td>
              <td className="mono">{d.key}</td>
              <td className="mono">{d.kind}</td>
              <td>{deliveryBadge(d)}</td>
            </tr>
          ))}
          {!shown.length && <tr><td colSpan={5} className="dim" style={{ textAlign: "center", padding: 24 }}>no dispatches match “{q}”</td></tr>}
        </tbody>
      </table>

      {sel && (
        <>
          <div className="sheet-overlay" onClick={() => setSel(null)} />
          <aside className="sheet" role="dialog" aria-label="Dispatch detail">
            <div className="sheet-head">
              <div className="sheet-title">
                <h2><span className="mono">{sel.trigger}</span></h2>
                <span className="subtitle" style={{ margin: 0 }}>fired for <span className="mono">{sel.key}</span></span>
              </div>
              <button className="sheet-close" onClick={() => setSel(null)} aria-label="Close"><Close /></button>
            </div>
            <div className="sheet-body">
              <div className="kv">
                <span className="k">fired</span><span><TimeAgo ts={sel.fired_at} /></span>
                <span className="k">kind</span><span className="mono">{sel.kind}</span>
                <span className="k">delivery</span><span>{deliveryBadge(sel)}</span>
                {sel.error && <><span className="k">error</span><span className="mono" style={{ color: "var(--err)" }}>{sel.error}</span></>}
                <span className="k">dispatch id</span><span className="mono">{sel.dispatch_id}</span>
              </div>
              <h3 style={{ margin: "18px 0 6px" }}>Payload</h3>
              <pre className="payload">{sel.payload}</pre>
            </div>
          </aside>
        </>
      )}
    </>
  );
}


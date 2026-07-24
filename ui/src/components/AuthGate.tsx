import { useEffect, useState } from "react";

import { api, auth } from "../api";

// Gates the console when the instance requires a token (NAVFLOW_AUTH_TOKEN). The SPA shell is served
// publicly, so we ask /health whether auth is required; any 401 from an API call (token missing or
// expired) flips us back to the login screen via the "navflow-auth-required" event.
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"loading" | "ok" | "login">("loading");

  useEffect(() => {
    let alive = true;
    // `navflow up --auth` prints a login URL (…/?token=<root>). Capture the token into storage and
    // strip it from the address bar so it doesn't linger in history/bookmarks. A bad token here
    // just 401s on the first protected call and bounces to the login screen.
    const url = new URL(window.location.href);
    const t = url.searchParams.get("token");
    if (t) {
      auth.set(t.trim());
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    }
    api.health()
      .then((h) => { if (alive) setState(h.auth_required && !auth.get() ? "login" : "ok"); })
      .catch(() => { if (alive) setState("ok"); });
    const onAuth = () => setState("login");
    window.addEventListener("navflow-auth-required", onAuth);
    return () => { alive = false; window.removeEventListener("navflow-auth-required", onAuth); };
  }, []);

  if (state === "loading") return null;
  if (state === "login") return <Login onAuthed={() => setState("ok")} />;
  return <>{children}</>;
}

function Login({ onAuthed }: { onAuthed: () => void }) {
  const [token, setToken] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    auth.set(token.trim());
    try {
      await api.connectors(); // a protected endpoint validates the token
      onAuthed();
    } catch {
      auth.clear();
      setErr("Invalid token.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit}>
        <div className="brand">nav<em>flow</em> <small>console</small></div>
        <p className="muted">This instance requires an access token.</p>
        <input
          type="password"
          placeholder="access token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoFocus
        />
        {err && <div className="login-err">{err}</div>}
        <button className="btn" disabled={busy || !token.trim()}>
          {busy ? "…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

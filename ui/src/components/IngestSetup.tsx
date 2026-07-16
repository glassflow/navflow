import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api";

// Auth + setup hints shown next to a push source's ingest URL. When this instance requires an
// ingest token (a hosted cell always does), the bare URL is not enough — producers get a 401 —
// so surface the token header and a paste-ready snippet right where the URL is handed out.
// Renders nothing when ingest is open (a plain local install).
export default function IngestSetup({ connector, url }: { connector: string; url: string }) {
  const [sec, setSec] = useState<{ ingest_token: string | null; ingest_required: boolean }>();
  const [revealed, setRevealed] = useState(false);
  useEffect(() => { api.security().then(setSec).catch(() => {}); }, []);

  if (!sec?.ingest_required || !sec.ingest_token) return null;
  const token = sec.ingest_token;
  const shown = revealed ? token : mask(token);

  const snippet = connector === "otlp"
    ? [
        `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`,
        `OTEL_EXPORTER_OTLP_ENDPOINT=${new URL(url).origin}`,
        `OTEL_EXPORTER_OTLP_HEADERS=X-NavFlow-Token=${token}`,
      ].join("\n")
    : [
        `curl -X POST ${url} \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  -H 'X-NavFlow-Token: ${token}' \\`,
        `  -d '{"message": "hello from my producer"}'`,
      ].join("\n");

  return (
    <div className="ingest-setup">
      <p className="muted">
        This instance requires the <Link to="/security">ingest token</Link> — send it as an{" "}
        <span className="mono">X-NavFlow-Token</span> header (or{" "}
        <span className="mono">Authorization: Bearer</span>):
      </p>
      <div className="ingest-url">
        <code className="mono">X-NavFlow-Token: {shown}</code>
        <button onClick={() => setRevealed((r) => !r)}>{revealed ? "hide" : "reveal"}</button>
        <CopyBtn text={token} label="copy token" />
      </div>
      <p className="muted" style={{ marginTop: 12 }}>
        {connector === "otlp"
          ? <>Exporter setup — NavFlow accepts OTLP/HTTP <strong>JSON</strong> (not protobuf); use a
              JSON-capable exporter, e.g. the OTel Collector's <span className="mono">otlphttp</span>{" "}
              exporter with <span className="mono">encoding: json</span>:</>
          : <>Or test it right away:</>}
      </p>
      <div className="ingest-url">
        <code className="mono" style={{ whiteSpace: "pre-wrap" }}>
          {revealed ? snippet : snippet.replace(token, mask(token))}
        </code>
        <CopyBtn text={snippet} label="copy" />
      </div>
    </div>
  );
}

function mask(token: string) {
  return token.length > 8 ? `${token.slice(0, 4)}…${token.slice(-4)}` : "••••••••";
}

function CopyBtn({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => {
      navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }}>{copied ? "copied" : label}</button>
  );
}

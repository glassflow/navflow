# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Email
**ashish@glassflow.dev** with a description, reproduction steps, and impact, and
we'll acknowledge within 3 business days.

We support the latest released version.

## Deploying safely

NavFlow is self-hosted. By default the daemon binds `127.0.0.1` (local only) with
**no authentication**. If you expose it on a network:

- Run with `navflow up --auth` (or set `NAVFLOW_AUTH_TOKEN`) so the API, console, and ingest all
  require a credential. Hand producers and agents their own scoped API keys (console → Security).
- Put it behind TLS (a reverse proxy such as Caddy — see the deployment docs).

See https://www.navflow.ai/docs for the full deployment guide.

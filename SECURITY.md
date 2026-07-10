# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Email
**ashish@glassflow.dev** with a description, reproduction steps, and impact, and
we'll acknowledge within 3 business days.

We support the latest released version.

## Deploying safely

NavFlow is self-hosted. By default the daemon binds `127.0.0.1` (local only) with
**no authentication**. If you expose it on a network:

- Set `NAVFLOW_AUTH_TOKEN` so the API and console require a bearer token.
- Put it behind TLS (a reverse proxy such as Caddy — see the deployment docs).
- Consider `NAVFLOW_INGEST_TOKEN` to gate push/ingest endpoints.

See https://www.navflow.ai/docs for the full deployment guide.

# Deploying NavFlow

NavFlow is one engine (navflowd) with config **profiles** — the same image serves local, demo, and
self-hosted single-tenant.

```
deploy/
  docker/Dockerfile             one image: daemon + remote MCP (same image, different command)
  compose/docker-compose.yml    read-only demo (pulls the prebuilt image)
  compose/docker-compose.selfhost.yml   self-host, auth (pulls the prebuilt image)
  compose/docker-compose.build.yml      override to build the image locally instead of pulling
  demo/catalog.yaml             the operator's source config for the demo (real services)
.github/workflows/docker-publish.yml    CI: build + push the image to GHCR
```

## The image

One multi-stage image (compiles the console SPA, bakes it into the wheel, installs all connector
extras). **CI builds and publishes it to GHCR** on every push to `main` and on `v*` tags, so servers
**pull** a prebuilt image rather than building on the box. The image ref is
`${NAVFLOW_REGISTRY:-ghcr.io/glassflow/navflow}:${NAVFLOW_VERSION:-…}`.

- **Version:** the **self-host** compose defaults to a **pinned** tag (e.g. `0.0.1`) for reproducible
  deploys; the **demo** tracks `:latest`. Pin a different version without editing files via
  `NAVFLOW_VERSION=0.0.2`, or `git pull` to pick up a release's bumped default.
- **Registry:** `NAVFLOW_REGISTRY=registry.example.com/navflow` points at another registry (DOCR,
  Docker Hub).
- **GHCR access:** make the package public (GitHub → package settings) or `docker login ghcr.io` on
  the server with a PAT, so `docker compose pull` can fetch it.
- **Build locally** instead of pulling (dev, or no CI) — layer the build override and `build`, which
  inherits the base file's tag so a plain `up` uses it:
  ```sh
  docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.build.yml build
  ```

### Cutting a release (pinned versions)

```sh
scripts/release.sh 0.0.2          # bumps pyproject + the self-host pin, commits, tags v0.0.2
git push && git push origin v0.0.2
```

Pushing the tag triggers CI to publish `ghcr.io/glassflow/navflow:0.1.0` (plus `:0.0` and `:latest`
on main). Self-host deploys then upgrade by `git pull && docker compose -f …selfhost.yml pull && up -d`,
or by setting `NAVFLOW_VERSION=0.0.2`. **Tag `v0.0.1` once to publish the current pinned default.**

## Scenario 2 — the public read-only demo

`docker compose` brings up the daemon (read-only), the remote MCP server, and Caddy fronting both on
one hostname.

**Two planes.** Read-only disables the *control plane* (authoring — create/edit sources, derive,
remember) on both the UI and MCP, but the *data plane* stays open so real services keep ingesting:

- **You (the operator) configure sources in `deploy/demo/catalog.yaml`** — that's the admin
  interface. `NAVFLOW_CATALOG_SYNC=1` re-imports it on every boot, so editing the file and
  restarting manages the demo's sources (no API needed). It runs **real** services: GitHub commits,
  Prometheus, Docker logs (poll, reaching outward) and Vercel / OTLP / webhooks (push, received at
  `/ingest/<name>` and `/v1/*`).
- **Visitors get read-only.** Every authoring call is refused (403); the MCP surface exposes only
  the read tools (query, catalog_list, catalog_describe, list_connectors, list_sources).

Point real drains/exporters at the instance (`https://<host>/ingest/vercel`,
`https://<host>/v1/logs`). To keep ingest from being wide open, set `NAVFLOW_INGEST_TOKEN` and have
producers send it as `X-NavFlow-Token` (or `Authorization: Bearer …`). Docker logs from inside the
container needs the Docker socket mounted *and* the docker CLI in the image — or run navflowd on the
host for that source.

```sh
# local (plain HTTP on :80) — pulls the prebuilt image
docker compose -f deploy/compose/docker-compose.yml up -d
#  → console http://localhost  ·  MCP http://localhost/mcp  (streamable-http)

# a non-privileged host port instead of 80
NAVFLOW_HTTP_PORT=8820 docker compose -f deploy/compose/docker-compose.yml up -d

# real demo: a domain turns on automatic HTTPS (point its DNS A record at the host first)
NAVFLOW_DOMAIN=demo.navflow.dev docker compose -f deploy/compose/docker-compose.yml up -d
#  → console https://demo.navflow.dev  ·  MCP https://demo.navflow.dev/mcp
```

An agent connects by adding the `/mcp` URL as a streamable-http MCP server. Routing: `/mcp` and
`/sse` → the MCP service; everything else → navflowd (console + API).

## Scenario 3 — self-hosted single-tenant

A writable instance for one team, behind a shared token. `docker-compose.selfhost.yml` runs navflowd
(not read-only) + the MCP server + Caddy, all requiring `NAVFLOW_AUTH_TOKEN`.

```sh
export NAVFLOW_AUTH_TOKEN=$(openssl rand -hex 24)   # the access token (humans + agents)
export NAVFLOW_DOMAIN=navflow.acme.com
docker compose -f deploy/compose/docker-compose.selfhost.yml pull   # fetch the prebuilt image
docker compose -f deploy/compose/docker-compose.selfhost.yml up -d
# update later:  git pull && docker compose -f …selfhost.yml pull && up -d
```

- **Console:** browse to the host; the login screen takes the token.
- **MCP (agents):** add `https://<host>/mcp` as a streamable-http MCP server with
  `Authorization: Bearer $NAVFLOW_AUTH_TOKEN`. The token is required to connect and is forwarded to
  navflowd.
- **Ingest (producers):** set `NAVFLOW_INGEST_TOKEN` and have producers send it as `X-NavFlow-Token`
  (or Bearer). Ingest is *not* gated by the auth token — it's a separate, machine-facing secret.
- **Auth model:** one shared bearer token. For per-user SSO, front the console with oauth2-proxy /
  Tailscale / Caddy basic-auth (machine paths — MCP + ingest — keep their tokens).

**Single-writer.** DuckDB has one writer, so this is exactly one `navflowd` + one volume — **do not
scale to replicas.** Back up the data by snapshotting the `navflow-data` volume (or copying
`/data/navflow.duckdb`); restore by putting the file back before boot.

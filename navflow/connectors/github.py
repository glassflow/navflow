"""GitHub commits connector — polls the commits API for a repo, one Envelope per new commit.

Cursor is the newest seen commit SHA: each poll fetches the latest commits (newest first) and
ingests everything above the cursor, so there are no duplicates. Keyed by `repo` (one source =
one repo); `author` is a secondary label. Point it at a service's repo and commits land in that
service's timeline next to its metrics and logs.

Auth: a token (config `token` or the GITHUB_TOKEN env var) is optional for public repos, required
for private ones. `discover()` validates the repo, finds its default branch, and proposes labels.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone

import httpx

from ..envelope import Envelope, now_utc
from .base import Connector

_API_DEFAULT = "https://api.github.com"


def _parse_iso(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def _normalize_repo(repo) -> str:
    """Accept 'owner/name' but also pasted URLs (https://github.com/owner/name[.git][/…])."""
    r = str(repo or "").strip().rstrip("/")
    if "://" in r:
        r = r.split("://", 1)[1]
    parts = r.split("/")
    if parts and "." in parts[0]:   # a hostname (github.com, GHE) — owner names can't contain dots
        parts = parts[1:]
    if len(parts) < 2 or not parts[0] or not parts[1]:
        raise ValueError(f"repo must be owner/name (got {repo!r})")
    name = parts[1][:-4] if parts[1].endswith(".git") else parts[1]
    return f"{parts[0]}/{name}"


def _headers(token: str | None) -> dict:
    h = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


class GithubConnector(Connector):
    CONFIG_SCHEMA = {
        "repo": {"type": "string", "required": True,
                 "help": "owner/name, e.g. glassflow/navflow (a pasted GitHub URL works too)"},
        "branch": {"type": "string",
                   "help": "branch to follow (default: the repo's default branch)"},
        "token": {"type": "string",
                  "help": "GitHub token — required for private repos, recommended otherwise: "
                          "without one GitHub allows 60 API requests/hour per IP "
                          "(or set the GITHUB_TOKEN env var — kept out of the catalog)"},
        "limit": {"type": "number", "default": 20,
                  "help": "newest commits fetched per poll (the first poll imports this many)"},
        "api_url": {"type": "string", "advanced": True,
                    "help": "GitHub API base for GitHub Enterprise (default https://api.github.com)"},
    }

    PROVIDES = [
        {"name": "repo", "primary": True, "help": "owner/name"},
        {"name": "author", "help": "commit author (GitHub login)"},
        {"name": "branch", "help": "branch followed"},
    ]

    async def poll(self):
        c = self.cfg.config
        repo = _normalize_repo(c["repo"])
        api = (c.get("api_url") or _API_DEFAULT).rstrip("/")
        token = c.get("token") or os.getenv("GITHUB_TOKEN")
        params = {"per_page": int(c.get("limit", 20))}
        if c.get("branch"):
            params["sha"] = c["branch"]
        headers = _headers(token)
        # Conditional request: a 304 costs nothing against the rate limit (60/h unauthenticated),
        # so steady polling only spends quota when there are actually new commits.
        etag = getattr(self, "_etag", None)
        if etag:
            headers["If-None-Match"] = etag
        try:
            async with httpx.AsyncClient(timeout=15) as cx:
                r = await cx.get(f"{api}/repos/{repo}/commits", params=params, headers=headers)
        except Exception as e:
            raise ValueError(f"could not reach GitHub: {e}")
        if r.status_code == 304:
            return []   # unchanged since last poll
        if r.status_code in (403, 429) and r.headers.get("x-ratelimit-remaining") == "0":
            raise ValueError("GitHub rate limit exhausted (unauthenticated: 60 requests/hour per IP)"
                             " — set a token or raise the poll interval")
        if r.status_code == 404:
            raise ValueError(f"repo {repo!r} not found"
                             + (" — check owner/name (the token may also lack access)" if token
                                else " — private repos need a token"))
        if r.status_code == 401:
            raise ValueError("GitHub rejected the token (401 unauthorized)")
        if r.status_code != 200:
            raise ValueError(f"GitHub returned {r.status_code} for {repo!r}")
        self._etag = r.headers.get("etag")
        commits = r.json()
        if not isinstance(commits, list) or not commits:
            return []

        cursor = self.store.get_cursor(self.cfg.name)
        new = []
        for commit in commits:           # newest first; stop at the last-seen SHA
            if commit.get("sha") == cursor:
                break
            new.append(commit)
        self.store.set_cursor(self.cfg.name, commits[0].get("sha"))

        ctx_base = {"repo": repo, "branch": c.get("branch") or ""}
        return [self._commit_envelope(commit, ctx_base) for commit in reversed(new)]  # chronological

    def label_context(self, commit: dict | None) -> dict:
        # repo/branch come from config; author/sha are synthesized from the commit. Shared by ingest
        # and backfill so the synthesized labels survive a relabel.
        commit = commit or {}
        c = self.cfg.config
        cm = commit.get("commit") or {}
        cm_author = cm.get("author") or {}
        login = (commit.get("author") or {}).get("login") or cm_author.get("name") or "unknown"
        try:
            repo = _normalize_repo(c.get("repo"))
        except ValueError:
            repo = c.get("repo")
        return {"repo": repo, "branch": c.get("branch") or "", "author": login,
                "author_name": cm_author.get("name"), "sha": commit.get("sha", "")}

    def _commit_envelope(self, commit: dict, ctx_base: dict) -> Envelope:
        sha = commit.get("sha", "")
        cm = commit.get("commit") or {}
        cm_author = cm.get("author") or {}
        login = (commit.get("author") or {}).get("login") or cm_author.get("name") or "unknown"
        summary = (cm.get("message") or "").strip().splitlines()[0] if cm.get("message") else ""
        ctx = self.label_context(commit)
        labels, key = self.keyed(ctx, fallback=ctx_base["repo"])
        return Envelope(
            source=self.cfg.name, source_type=self.cfg.type, key_value=key,
            event_type="commit", text=f"{sha[:7]} {login}: {summary}"[:300],
            event_time=_parse_iso(cm_author.get("date")) or now_utc(),
            fields={}, payload=commit, labels=labels,
        )

    @classmethod
    async def discover(cls, config: dict) -> dict:
        if not config.get("repo"):
            raise ValueError("enter the repo (owner/name) first, then Discover")
        repo = _normalize_repo(config["repo"])
        api = (config.get("api_url") or _API_DEFAULT).rstrip("/")
        token = config.get("token") or os.getenv("GITHUB_TOKEN")
        async with httpx.AsyncClient(timeout=15) as cx:
            try:
                meta = await cx.get(f"{api}/repos/{repo}", headers=_headers(token))
            except Exception as e:
                raise ValueError(f"could not reach GitHub: {e}")
            if meta.status_code == 404:
                raise ValueError(f"repo {repo!r} not found"
                                 + (" — check owner/name (the token may also lack access)" if token
                                    else " (private repos need a token)"))
            if meta.status_code != 200:
                raise ValueError(f"GitHub returned {meta.status_code} for {repo!r}")
            info = meta.json()
            branch = info.get("default_branch") or "main"
            commits = (await cx.get(f"{api}/repos/{repo}/commits",
                                    params={"per_page": 10, "sha": branch},
                                    headers=_headers(token))).json()
        authors = sorted({(c.get("author") or {}).get("login")
                          or ((c.get("commit") or {}).get("author") or {}).get("name")
                          for c in commits if isinstance(c, dict)} - {None})
        return {
            "connector": "github",
            "summary": f"{repo} · default branch {branch}"
                       + (" · private" if info.get("private") else "")
                       + (f" · recent authors: {', '.join(authors[:6])}" if authors else ""),
            "recent_authors": authors[:8],
            "proposed_config": {
                "repo": repo, "branch": branch,
                "labels": [{"name": "repo", "field": "repo", "primary": True},
                           {"name": "author", "field": "author"}],
            },
        }

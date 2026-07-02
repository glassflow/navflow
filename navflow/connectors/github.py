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


def _headers(token: str | None) -> dict:
    h = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


class GithubConnector(Connector):
    CONFIG_SCHEMA = {
        "repo": {"type": "string", "required": True,
                 "help": "owner/name, e.g. glassflow/navflow"},
        "branch": {"type": "string",
                   "help": "branch to follow (default: the repo's default branch)"},
        "token": {"type": "string",
                  "help": "GitHub token for private repos / higher rate limits "
                          "(or set the GITHUB_TOKEN env var — kept out of the catalog)"},
        "limit": {"type": "number", "default": 20, "help": "commits to fetch per poll"},
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
        repo = c["repo"]
        api = (c.get("api_url") or _API_DEFAULT).rstrip("/")
        token = c.get("token") or os.getenv("GITHUB_TOKEN")
        params = {"per_page": int(c.get("limit", 20))}
        if c.get("branch"):
            params["sha"] = c["branch"]
        try:
            async with httpx.AsyncClient(timeout=15) as cx:
                r = await cx.get(f"{api}/repos/{repo}/commits", params=params, headers=_headers(token))
        except Exception:
            return []
        if r.status_code != 200:
            return []
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
        return {"repo": c.get("repo"), "branch": c.get("branch") or "", "author": login,
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
        repo = config.get("repo")
        if not repo:
            raise ValueError("enter the repo (owner/name) first, then Discover")
        api = (config.get("api_url") or _API_DEFAULT).rstrip("/")
        token = config.get("token") or os.getenv("GITHUB_TOKEN")
        async with httpx.AsyncClient(timeout=15) as cx:
            try:
                meta = await cx.get(f"{api}/repos/{repo}", headers=_headers(token))
            except Exception as e:
                raise ValueError(f"could not reach GitHub: {e}")
            if meta.status_code == 404:
                raise ValueError(f"repo {repo!r} not found (private repos need a token)")
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

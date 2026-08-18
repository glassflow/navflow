"""GitHub credentials: a token stored once, referenced by name from sources and MCP servers.

Before this, every `github` source carried its own token and an agent's GitHub MCP server carried
another copy. A stored credential is one place to paste, test and rotate it: sources set
`credential: <name>` instead of `token`, an MCP server sets `auth_value: credential:github/<name>`,
and both resolve the token at use time, so rotating the credential rotates everything at once.

`kind` is `token` today. A GitHub App credential (app id, installation id, private key) will be
another kind in the same table; callers only ever ask `resolve_github_token()` for a token.
"""
from __future__ import annotations

import time

import httpx

API_DEFAULT = "https://api.github.com"
CREDENTIAL_PREFIX = "credential:github/"
_REPOS_TTL = 300   # seconds a repo listing is reused (the wizard re-reads it on every keystroke)
_repos_cache: dict[str, tuple[float, list[dict]]] = {}


def _headers(token: str) -> dict:
    return {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
            "Authorization": f"Bearer {token}"}


def is_credential_ref(value: str | None) -> bool:
    return str(value or "").startswith(CREDENTIAL_PREFIX)


def credential_name(ref: str) -> str:
    """`credential:github/<name>` -> `<name>`; a bare name is returned as is."""
    ref = str(ref or "").strip()
    return ref[len(CREDENTIAL_PREFIX):] if ref.startswith(CREDENTIAL_PREFIX) else ref


def resolve_github_token(store, ref: str | None) -> str | None:
    """The token behind a credential name or `credential:github/<name>`; None if unknown or empty.
    Never raises: a missing credential is the caller's error to surface (the connector reports it
    as its last error, the MCP client as a connect failure)."""
    name = credential_name(ref)
    if not name:
        return None
    cred = store.get_github_credential(name)
    if not cred:
        return None
    return cred.get("token") or None


def resolve_api_url(store, ref: str | None) -> str | None:
    """The API base a credential was created for (GitHub Enterprise), if any."""
    cred = store.get_github_credential(credential_name(ref))
    return (cred or {}).get("api_url") or None


def redact(cred: dict) -> dict:
    """The wire form: everything except the token, plus whether one is set."""
    return {"name": cred["name"], "kind": cred.get("kind") or "token",
            "api_url": cred.get("api_url") or "", "account": cred.get("account") or "",
            "token_configured": bool(cred.get("token")),
            "created_at": cred.get("created_at"), "updated_at": cred.get("updated_at")}


async def test_credential(token: str, api_url: str | None = None) -> dict:
    """GET /user with the token: the login it belongs to and, for classic tokens, the scopes.
    Raises ValueError with a message that names the cause."""
    api = (api_url or API_DEFAULT).rstrip("/")
    async with httpx.AsyncClient(timeout=15) as cx:
        try:
            r = await cx.get(f"{api}/user", headers=_headers(token))
        except Exception as e:
            raise ValueError(f"could not reach GitHub: {e}")
    if r.status_code == 401:
        raise ValueError("GitHub rejected the token (401 unauthorized)")
    if r.status_code != 200:
        raise ValueError(f"GitHub returned {r.status_code} for /user")
    body = r.json() if r.content else {}
    scopes = [s.strip() for s in (r.headers.get("x-oauth-scopes") or "").split(",") if s.strip()]
    return {"login": body.get("login") or "", "name": body.get("name") or "",
            "scopes": scopes}


async def list_repos(name: str, token: str, api_url: str | None = None, query: str = "",
                     use_cache: bool = True) -> list[dict]:
    """Repos the token can see, newest push first: `[{full_name, default_branch, private,
    pushed_at}]`. Paginates /user/repos; the full list is cached per credential for 5 minutes and
    the query filters the cached list, so a wizard's search box does not hit GitHub per keystroke.
    Fine-grained tokens list only the repositories they were granted."""
    api = (api_url or API_DEFAULT).rstrip("/")
    cache_key = f"{name}@{api}"
    now = time.monotonic()
    hit = _repos_cache.get(cache_key) if use_cache else None
    if hit and now - hit[0] < _REPOS_TTL:
        repos = hit[1]
    else:
        repos = []
        async with httpx.AsyncClient(timeout=20) as cx:
            page = 1
            while page <= 30:      # 3,000 repos is plenty for a picker
                try:
                    r = await cx.get(f"{api}/user/repos", headers=_headers(token),
                                     params={"affiliation": "owner,collaborator,organization_member",
                                             "per_page": 100, "sort": "pushed", "page": page})
                except Exception as e:
                    raise ValueError(f"could not reach GitHub: {e}")
                if r.status_code == 401:
                    raise ValueError("GitHub rejected the token (401 unauthorized)")
                if r.status_code != 200:
                    raise ValueError(f"GitHub returned {r.status_code} for /user/repos")
                batch = r.json() or []
                if not isinstance(batch, list):
                    break
                for repo in batch:
                    if not isinstance(repo, dict) or not repo.get("full_name"):
                        continue
                    repos.append({"full_name": repo["full_name"],
                                  "default_branch": repo.get("default_branch") or "main",
                                  "private": bool(repo.get("private")),
                                  "pushed_at": repo.get("pushed_at")})
                if len(batch) < 100:
                    break
                page += 1
        _repos_cache[cache_key] = (now, repos)
    q = (query or "").strip().lower()
    if not q:
        return list(repos)
    return [r for r in repos if q in r["full_name"].lower()]


def forget_repos(name: str) -> None:
    """Drop the cached listing for a credential (called when it is updated or deleted)."""
    for key in [k for k in _repos_cache if k.startswith(f"{name}@")]:
        _repos_cache.pop(key, None)

#!/usr/bin/env bash
# Cut a pinned release: bump the package version, pin the self-host compose to it, commit + tag.
# Pushing the tag triggers CI (.github/workflows/docker-publish.yml) to build and publish
#   ghcr.io/glassflow/navflow:<version>  (+ :<major>.<minor> and :latest on main).
#
#   scripts/release.sh 0.0.2
#   git push && git push origin v0.0.2     # then publish (review first)
set -euo pipefail

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: scripts/release.sh <version>   e.g. 0.0.2" >&2
  exit 1
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SELFHOST="$ROOT/deploy/compose/docker-compose.selfhost.yml"

# package version
sed -i.bak -E "s/^version = \".*\"/version = \"$VERSION\"/" "$ROOT/pyproject.toml"
# the self-host compose's pinned default tag (NAVFLOW_VERSION:-<here>)
sed -i.bak -E "s/(NAVFLOW_VERSION:-)[0-9][^}]*/\1$VERSION/g" "$SELFHOST"
rm -f "$ROOT/pyproject.toml.bak" "$SELFHOST.bak"

git -C "$ROOT" add pyproject.toml "$SELFHOST"
git -C "$ROOT" commit -m "Release v$VERSION"
git -C "$ROOT" tag "v$VERSION"

echo
echo "Prepared v$VERSION (committed + tagged). Review, then publish:"
echo "  git push && git push origin v$VERSION"

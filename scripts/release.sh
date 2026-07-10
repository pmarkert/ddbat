#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: scripts/release.sh <patch|minor|major> [--access-public]" >&2
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 1
fi

BUMP_TYPE="$1"
ACCESS_PUBLIC="${2:-}"

if [[ "$BUMP_TYPE" != "patch" && "$BUMP_TYPE" != "minor" && "$BUMP_TYPE" != "major" ]]; then
  usage
  exit 1
fi

if [[ -n "$ACCESS_PUBLIC" && "$ACCESS_PUBLIC" != "--access-public" ]]; then
  usage
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Release aborted: working tree is not clean." >&2
  echo "Commit, stash, or discard local changes and try again." >&2
  exit 1
fi

if ! npm whoami >/dev/null 2>&1; then
  echo "Release aborted: npm CLI is not authenticated." >&2
  echo "Run 'npm login' and try again." >&2
  exit 1
fi

echo "Running verification checks..."
npm run lint
npm run build
npm pack --dry-run >/dev/null

echo "Bumping version ($BUMP_TYPE)..."
NEW_TAG=$(npm version "$BUMP_TYPE")

echo "Publishing $NEW_TAG..."
if [[ "$ACCESS_PUBLIC" == "--access-public" ]]; then
  npm publish --access public
else
  npm publish
fi

echo "Pushing commit and tags..."
git push
git push --tags

echo "Release complete: $NEW_TAG"

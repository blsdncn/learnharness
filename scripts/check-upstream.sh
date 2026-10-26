#!/usr/bin/env bash
# Check upstream LearnHarness releases against this maintained branch.
# Read-only: never modifies the working tree or installed app.
# Usage: scripts/check-upstream.sh [--json]
set -euo pipefail
cd "$(dirname "$0")/.."
git fetch origin --tags -q 2>/dev/null || true
git fetch upstream --tags -q 2>/dev/null || true
BASE=$(git merge-base HEAD origin/main 2>/dev/null || git rev-parse HEAD)
BEHIND=$(git rev-list --count "$BASE"..origin/main 2>/dev/null || echo "?")
LATEST_TAG=$(git tag --sort=-v:refname | head -1)
LATEST_RELEASE=""
if command -v gh >/dev/null 2>&1; then
  LATEST_RELEASE=$(gh api repos/amosblomqvist/learnharness/releases/latest --jq '{tag: .tag_name, published: .published_at}' 2>/dev/null || true)
fi
if [ "${1:-}" = "--json" ]; then
  python3 -c "import json; print(json.dumps({'behindOriginMain': '$BEHIND', 'latestTag': '$LATEST_TAG', 'latestRelease': '''$LATEST_RELEASE''', 'branch': '$(git branch --show-current)'}))"
else
  echo "branch: $(git branch --show-current)"
  echo "behind origin/main: $BEHIND commit(s)"
  echo "latest local tag: $LATEST_TAG"
  [ -n "$LATEST_RELEASE" ] && echo "latest GitHub release: $LATEST_RELEASE"
  echo "candidate updates must be built and validated separately before replacing the installed app."
fi

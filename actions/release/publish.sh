#!/usr/bin/env bash
#
# publish.sh — the "Publish" step of actions/release.
#
# Creates the GitHub Release of TAG, or updates it on a re-run. Its notes are
# the release PR's description — the AI summary above the git-cliff changelog,
# as actions/auto-pr wrote it — else git-cliff's changelog since the previous
# vX.Y.Z.
#
# Env: GH_TOKEN, GH_REPO, PR_BODY, TAG, plus the runner's RUNNER_TEMP. Needs the
# root package installed (git-cliff).
set -euo pipefail

ci_root="$(dirname "${BASH_SOURCE[0]}")/../.."
notes="$RUNNER_TEMP/release-notes.md"

if [ -n "${PR_BODY//[[:space:]]/}" ]; then
  printf '%s\n' "$PR_BODY" > "$notes"
else
  # From the previous vX.Y.Z (the moving major tags do not match) to TAG.
  range="$TAG"
  if previous="$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' "$TAG^" 2>/dev/null)"; then
    range="$previous..$TAG"
  fi
  {
    echo '## Changes'
    NO_COLOR=1 "$ci_root/node_modules/.bin/git-cliff" --config "$ci_root/config/cliff.toml" \
      --strip all "$range"
  } > "$notes"
fi

if gh release view "$TAG" >/dev/null 2>&1; then
  gh release edit "$TAG" --title "$TAG" --notes-file "$notes" >/dev/null
  echo "::notice::Updated the GitHub Release $TAG."
else
  gh release create "$TAG" --verify-tag --title "$TAG" --notes-file "$notes" >/dev/null
  echo "::notice::Published the GitHub Release $TAG."
fi

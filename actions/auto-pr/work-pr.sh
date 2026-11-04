#!/usr/bin/env bash
#
# work-pr.sh — the "Find or open PR" step of actions/auto-pr on a work branch.
#
# Checks the branch is <type>/<description>, then finds its open PR or opens a
# one into AUTO_BASE_BRANCH. The type, the type list and the title come from
# scripts/types.mjs. Writes to GITHUB_OUTPUT:
#   label    the branch's type, the PR's label
#   url      the PR's URL; not set when the branch has nothing to merge yet
#
# Env: GH_TOKEN, GH_REPO, plus the runner's GITHUB_* and RUNNER_TEMP.
set -euo pipefail

types="$(dirname "${BASH_SOURCE[0]}")/../../scripts/types.mjs"
base="${AUTO_BASE_BRANCH:?}"
branch="$GITHUB_REF_NAME"

if ! type="$(node "$types" branch-type "$branch")"; then
  echo "::error::Branch '$branch' is not <type>/<description> with a type of: $(node "$types" list). Rename it."
  exit 1
fi
echo "label=$type" >> "$GITHUB_OUTPUT"

if [ "$(git rev-list --count "origin/$base..HEAD")" -eq 0 ]; then
  echo "::notice::'$branch' has no commits that are not on '$base' yet; no PR to open."
  exit 0
fi

url="$(gh pr list --head "$branch" --state open --json url --jq '.[0].url // empty')"
if [ -z "$url" ]; then
  title="$(node "$types" first-title "$type" "origin/$base..HEAD")"
  if [ -z "$title" ]; then
    description="${branch#*/}"
    title="$type: ${description//[-_]/ }"
  fi
  body="$RUNNER_TEMP/auto-pr-commits.md"
  { echo '## Commits'; echo; git log --reverse --format='- %s' "origin/$base..HEAD"; } > "$body"
  url="$(gh pr create --base "$base" --head "$branch" --title "$title" --body-file "$body")"
  echo "::notice::Opened $url"
fi
echo "url=$url" >> "$GITHUB_OUTPUT"

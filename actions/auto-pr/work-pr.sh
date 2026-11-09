#!/usr/bin/env bash
#
# work-pr.sh — the "Find or open PR" step of actions/auto-pr on a work branch.
#
# Checks the branch is <type>/<description>, then finds its open PR or opens
# one into AUTO_BASE_BRANCH, titled after the branch in the Conventional shape:
# `refact/ifc-parsing` → `refact: ifc parsing`, `refact!: …` when a commit on
# the branch is breaking (`!` or a BREAKING CHANGE footer). On an open PR the
# title is left alone, except that a breaking commit pushed later adds the `!`:
# the title becomes the squash commit, which is what makes the release major.
# The type, the type list and the title come from scripts/types.mjs. Writes to
# GITHUB_OUTPUT:
#   label    the branch's type, the PR's label
#   url      the PR's URL; not set when the branch has nothing to merge yet
#
# Env: GH_TOKEN (opens the PR), EDIT_TOKEN (edits it, starting no workflow),
# GH_REPO, plus the runner's GITHUB_* and RUNNER_TEMP.
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

title="$(node "$types" work-title "$branch" "origin/$base..HEAD")"
pr="$(gh pr list --head "$branch" --state open --json url,title --jq '.[0] // empty')"
if [ -n "$pr" ]; then
  url="$(jq -r .url <<< "$pr")"
  if [[ "$title" == "$type!:"* ]] && breaking="$(node "$types" with-breaking "$(jq -r .title <<< "$pr")")" &&
    [ -n "$breaking" ]; then
    # REST, not `gh pr edit`: see sync-metadata.sh. EDIT_TOKEN: the push already
    # started PR Checks, which waits for this run.
    GH_TOKEN="$EDIT_TOKEN" gh api -X PATCH "repos/$GH_REPO/pulls/${url##*/}" \
      -f "title=$breaking" >/dev/null
    echo "::notice::$url: a commit is breaking, so the title is now '$breaking'."
  fi
else
  body="$RUNNER_TEMP/auto-pr-commits.md"
  { echo '## Commits'; echo; git log --reverse --format='- %s' "origin/$base..HEAD"; } > "$body"
  url="$(gh pr create --base "$base" --head "$branch" --title "$title" --body-file "$body")"
  echo "::notice::Opened $url"
fi
echo "url=$url" >> "$GITHUB_OUTPUT"

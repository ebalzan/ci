#!/usr/bin/env bash
#
# sync-metadata.sh — the "Sync metadata" step of actions/auto-pr.
#
# Puts on the PR: the type label (created when missing, with its color from
# config/types.json), the pusher as assignee, AUTO_MILESTONE_TITLE and the
# AUTO_PROJECT_NUMBER board. Each is best-effort: a failure is a warning, and
# the work-PR check then names what is missing.
#
# Env: GH_TOKEN, GH_REPO, PR_URL, PR_TYPE, plus the runner's GITHUB_*.
set -uo pipefail

color="$(jq -r --arg t "$PR_TYPE" '.[$t].color' "$(dirname "${BASH_SOURCE[0]}")/../../config/types.json")"
# Fails when the label exists — left as it is.
gh label create "$PR_TYPE" --color "$color" --description "Changes for '$PR_TYPE' branches" >/dev/null 2>&1

gh pr edit "$PR_URL" --add-label "$PR_TYPE" >/dev/null ||
  echo "::warning::Could not add the '$PR_TYPE' label."
gh pr edit "$PR_URL" --add-assignee "$GITHUB_ACTOR" >/dev/null ||
  echo "::warning::Could not assign $GITHUB_ACTOR."

if [ -n "${AUTO_MILESTONE_TITLE:-}" ]; then
  gh pr edit "$PR_URL" --milestone "$AUTO_MILESTONE_TITLE" >/dev/null ||
    echo "::warning::Could not set the milestone '$AUTO_MILESTONE_TITLE' (AUTO_MILESTONE_TITLE): it must exist and be open."
fi

if [ -n "${AUTO_PROJECT_NUMBER:-}" ]; then
  owner="${AUTO_PROJECT_OWNER:-$GITHUB_REPOSITORY_OWNER}"
  gh project item-add "$AUTO_PROJECT_NUMBER" --owner "$owner" --url "$PR_URL" >/dev/null ||
    echo "::warning::Could not add the PR to project $AUTO_PROJECT_NUMBER of $owner (AUTO_PROJECT_NUMBER): GH_PROJECT_TOKEN must be a classic PAT with the project scope."
fi
exit 0

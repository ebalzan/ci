#!/usr/bin/env bash
#
# verify-merge.sh — the "Verify merge" step of actions/release.
#
# The release PR must be merged with a merge commit: its second parent is the
# PR's head, so dev's commits reached main with their SHAs and dev can catch up
# without a force-push. A squash merge (one parent) or a rebase merge (the head
# is not a parent) rewrote them; the release stops here, before anything is
# tagged.
#
# Env: HEAD_SHA (the PR's head), MERGE_SHA (the PR's merge_commit_sha).
set -euo pipefail

dev="${AUTO_BASE_BRANCH:-dev}"
main="${AUTO_RELEASE_BRANCH:-main}"
read -r -a commit <<< "$(git rev-list --parents -n 1 "$MERGE_SHA")"

if [ "${#commit[@]}" -ne 3 ] || [ "${commit[2]}" != "$HEAD_SHA" ]; then
  echo "::error::The release PR was not merged with a merge commit (squash and rebase rewrite '$dev''s commits), so nothing was released. Merge '$main' into '$dev', then merge the next release PR with \"Create a merge commit\" — the ruleset in config/rulesets/require-release-pr.json allows only that."
  exit 1
fi
echo "Merge commit $MERGE_SHA: '$dev' at $HEAD_SHA merged into '$main'."

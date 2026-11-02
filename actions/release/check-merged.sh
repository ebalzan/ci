#!/usr/bin/env bash
#
# check-merged.sh — the "Check merged" step of actions/release, when the
# release PR is closed as merged.
#
# The release fast-forwards main to dev, which puts the PR's head on main and
# makes GitHub mark the PR merged: nothing to do. A head that is not on main
# means the PR was merged with a GitHub button — squash and rebase rewrite
# dev's commits, so main and dev diverged and nothing was released. Fails with
# how to put main back.
#
# Env: HEAD_SHA (the PR's head), MERGE_SHA (the PR's merge_commit_sha).
set -euo pipefail

dev="${AUTO_BASE_BRANCH:?}"
main="${AUTO_RELEASE_BRANCH:?}"

git fetch --quiet origin "+refs/heads/$main:refs/remotes/origin/$main"
if git merge-base --is-ancestor "$HEAD_SHA" "origin/$main"; then
  echo "The release PR's head $HEAD_SHA is on '$main': it was released by fast-forward."
  exit 0
fi

base="$(git merge-base "$HEAD_SHA" "$MERGE_SHA" || true)"
echo "::error::The release PR was merged with a GitHub merge button, so '$main' has commits '$dev' does not and nothing was released. Release PRs ship with the 'ship' label, which fast-forwards '$main' to '$dev'. To recover, an admin puts '$main' back: git push --force-with-lease=$main:$MERGE_SHA origin ${base:-<the commit before the merge>}:refs/heads/$main (the 'ci: protect main' ruleset must allow it). Then run Auto PR on '$dev' (Actions → Auto PR → Run workflow) to reopen the release PR, and label it 'ship'."
exit 1

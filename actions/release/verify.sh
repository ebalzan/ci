#!/usr/bin/env bash
#
# verify.sh — the "Verify" step of actions/release, on the `ship` label.
#
# Main only ever fast-forwards to dev: the release PR is shipped as the exact
# commits dev has, so dev and main keep the same SHAs and history stays linear.
# Before anything is tagged:
#   - the head is already on main: a re-run (release.sh finds the tag); passes.
#   - dev is still the PR's head (it did not move since the label).
#   - main is in the head's history, so main fast-forwards to it.
#   - main..head has no merge commit.
#   - CHECK_NAME passed on the head; while it is queued or running, waits
#     (CHECK_TIMEOUT seconds, default 900, polling every CHECK_POLL, default 15).
#
# Env: GH_TOKEN, GH_REPO, HEAD_SHA (the PR's head), CHECK_NAME.
set -euo pipefail

dev="${AUTO_BASE_BRANCH:?}"
main="${AUTO_RELEASE_BRANCH:?}"
relabel="Once it is fixed and the check passes, remove the 'ship' label and add it again."

git fetch --quiet origin \
  "+refs/heads/$main:refs/remotes/origin/$main" "+refs/heads/$dev:refs/remotes/origin/$dev"

if git merge-base --is-ancestor "$HEAD_SHA" "origin/$main"; then
  echo "::notice::$HEAD_SHA is already on '$main': a re-run."
  exit 0
fi

dev_sha="$(git rev-parse "origin/$dev")"
if [ "$dev_sha" != "$HEAD_SHA" ]; then
  echo "::error::'$dev' moved since the release PR was labelled (it is at $dev_sha, the PR's head was $HEAD_SHA). Nothing was released. Auto PR updates the release PR; $relabel"
  exit 1
fi

if ! git merge-base --is-ancestor "origin/$main" "$HEAD_SHA"; then
  echo "::error::'$main' has commits that '$dev' does not, so it cannot fast-forward to '$dev'. Nothing was released. '$main' only moves through a release: bring '$dev' up to '$main' first. $relabel"
  exit 1
fi

merges="$(git rev-list --merges --count "origin/$main..$HEAD_SHA")"
if [ "$merges" -gt 0 ]; then
  echo "::error::'$dev' has $merges merge commit(s) that '$main' does not: history must stay linear. Nothing was released. $relabel"
  exit 1
fi

# The newest run of CHECK_NAME on the head: "<status> <conclusion>", or "".
latest_check() {
  gh api -X GET "repos/$GH_REPO/commits/$HEAD_SHA/check-runs" \
    -f "check_name=$CHECK_NAME" -f filter=all -f per_page=100 \
    --jq '.check_runs | sort_by(.id) | last | select(.) | "\(.status) \(.conclusion)"'
}

deadline=$((SECONDS + ${CHECK_TIMEOUT:-900}))
while :; do
  if ! check="$(latest_check)"; then
    echo "::error::Could not read '$CHECK_NAME' on $HEAD_SHA (the job needs checks: read). Nothing was released."
    exit 1
  fi
  read -r status conclusion <<< "$check" || true
  case "${status:-}" in
    completed)
      if [ "$conclusion" = success ]; then
        echo "'$CHECK_NAME' passed on $HEAD_SHA; '$main' fast-forwards to '$dev'."
        exit 0
      fi
      echo "::error::'$CHECK_NAME' concluded '$conclusion' on $HEAD_SHA. Nothing was released. $relabel"
      exit 1
      ;;
    '')
      echo "::error::'$CHECK_NAME' never ran on $HEAD_SHA (a draft?). Nothing was released. $relabel"
      exit 1
      ;;
  esac
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "::error::'$CHECK_NAME' is still '$status' on $HEAD_SHA. Nothing was released. $relabel"
    exit 1
  fi
  echo "'$CHECK_NAME' is $status; waiting."
  sleep "${CHECK_POLL:-15}"
done

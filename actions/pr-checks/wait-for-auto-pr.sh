#!/usr/bin/env bash
#
# wait-for-auto-pr.sh — the "Wait for Auto PR" step of actions/pr-checks.
#
# A push starts Auto PR and PR Checks together, and Auto PR then fills the PR in
# with edits that start no workflow. So the check waits for the Auto PR run of
# the same commit, to judge the finished PR. Always exits 0: past a limit, or
# with no such run, the check goes on and names whatever is missing.
#
# Env: GH_TOKEN (Actions read), GH_REPO, HEAD_SHA. Seconds: WAIT_TIMEOUT for the
# run to finish, WAIT_GRACE for it to appear, WAIT_INTERVAL between looks.
set -uo pipefail

timeout="${WAIT_TIMEOUT:-300}"
grace="${WAIT_GRACE:-30}"
interval="${WAIT_INTERVAL:-5}"

seen=false
while :; do
  # "<runs> <unfinished>". A failed look counts as no run yet. The path, not the
  # name: repos rename the workflow.
  counts="$(gh api "repos/$GH_REPO/actions/runs?head_sha=$HEAD_SHA&event=push&per_page=100" |
    jq -r '[.workflow_runs[] | select(.path | endswith("auto-pr.yml"))]
      | "\(length) \(map(select(.status != "completed")) | length)"')" || counts='0 0'
  read -r runs unfinished <<< "$counts"

  if [ "${runs:-0}" -gt 0 ]; then
    seen=true
    if [ "${unfinished:-0}" -eq 0 ]; then
      echo "Auto PR has finished for $HEAD_SHA."
      exit 0
    fi
  fi

  if [ "$seen" = false ] && [ "$SECONDS" -ge "$grace" ]; then
    echo "::notice::No Auto PR run for $HEAD_SHA after ${grace}s: checking the PR as it is."
    exit 0
  fi
  if [ "$SECONDS" -ge "$timeout" ]; then
    echo "::warning::Auto PR is still running for $HEAD_SHA after ${timeout}s: checking the PR as it is."
    exit 0
  fi
  sleep "$interval"
done

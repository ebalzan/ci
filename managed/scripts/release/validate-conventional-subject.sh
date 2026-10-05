#!/usr/bin/env sh
#
# MANAGED BY tracebim-ci (managed/scripts/release/validate-conventional-subject.sh).
# Do not edit this copy: change it in tracebim-ci, then run
# `bin/sync-managed.sh --all`. PR Checks fails while a repo's copy differs.
#
# The one Conventional Commits rule, used by the husky commit-msg hook (locally)
# and by tracebim-ci's PR-title check (in CI). The allowed types must match
# branchReleaseTypes in tracebim-ci scripts/release/release-utils.mjs and
# TYPE_CONFIG in actions/auto-work-items/src/config.ts.
set -eu

subject="${1-}"
label="${2-commit message}"
commit_regex='^(feat|fix|docs|style|refact|perf|test|build|ci|chore|revert)(\([^)]+\))?(!)?: .+'

if [ -z "$subject" ]; then
  echo "Invalid $label: value is empty."
  echo "Use Conventional Commits, for example:"
  echo "  feat(viewer): add section filters"
  echo "  fix: prevent null model crash"
  exit 1
fi

printf '%s\n' "$subject" | grep -qE "$commit_regex" && exit 0

echo "Invalid $label: \"$subject\""
echo "Use Conventional Commits, for example:"
echo "  feat(viewer): add section filters"
echo "  fix: prevent null model crash"
exit 1

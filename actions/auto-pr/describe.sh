#!/usr/bin/env bash
#
# describe.sh — the "Describe" step of actions/auto-pr.
#
# Runs Claude Code headless on the branch and writes its reply as the PR
# description: describe-prompt.md for a work PR, describe-release-prompt.md for
# the release PR (__BRANCH__, __TYPE__ and __BASE__ filled in). The release PR's
# description is that summary followed by the changelog (CHANGELOG, from
# release-pr.sh). Best-effort: any failure is a warning and leaves a work PR's
# description as it was, a release PR's as the changelog alone.
#
# Env: GH_TOKEN, GH_REPO, ANTHROPIC_API_KEY, PR_URL, PR_KIND, PR_LABEL, CHANGELOG
# (release PR only), CLAUDE_CODE (the pinned npm spec), plus the runner's
# GITHUB_* and RUNNER_TEMP.
set -uo pipefail

if [ "${PR_KIND:-work}" = release ]; then
  base="${AUTO_RELEASE_BRANCH:-main}"
  prompt_file=describe-release-prompt.md
else
  base="${AUTO_BASE_BRANCH:-dev}"
  prompt_file=describe-prompt.md
fi
model="${AUTO_DESCRIBE_MODEL:-claude-sonnet-5-5}"
args=(--model "$model")
# Haiku rejects the effort setting.
[[ "$model" == claude-haiku* ]] || args+=(--effort "${AUTO_DESCRIBE_EFFORT:-low}")

# publish SUMMARY — SUMMARY, then the changelog when there is one, as the
# description.
publish() {
  local body="$RUNNER_TEMP/auto-pr-body.md"
  {
    if [ -s "$1" ]; then cat "$1"; echo; fi
    if [ -n "${CHANGELOG:-}" ]; then cat "$CHANGELOG"; fi
  } > "$body"
  [ -s "$body" ] || return 0
  gh pr edit "$PR_URL" --body-file "$body" >/dev/null ||
    echo "::warning::Could not update the description."
}

# give_up WHY — a warning; a release PR still gets its changelog.
give_up() {
  if [ -n "${CHANGELOG:-}" ]; then
    echo "::warning::$1 The description is the changelog alone."
    publish /dev/null
  else
    echo "::warning::$1 The description is left as it was."
  fi
  exit 0
}

prompt="$(< "$(dirname "${BASH_SOURCE[0]}")/$prompt_file")"
prompt="${prompt//__BRANCH__/$GITHUB_REF_NAME}"
prompt="${prompt//__TYPE__/$PR_LABEL}"
prompt="${prompt//__BASE__/$base}"

# --bare: none of the branch's own Claude settings, hooks or CLAUDE.md.
# Read-only tools; git limited to log/diff/show; a hard cost cap.
out="$RUNNER_TEMP/auto-pr-claude.json"
if ! printf '%s\n' "$prompt" |
  npx --yes "$CLAUDE_CODE" -p --bare --no-session-persistence --output-format json \
    "${args[@]}" --max-budget-usd 1 \
    --tools 'Bash,Read,Grep,Glob' \
    --allowedTools 'Bash(git log:*),Bash(git diff:*),Bash(git show:*),Read,Grep,Glob' \
    > "$out"; then
  give_up "Claude Code failed."
fi

description="$RUNNER_TEMP/auto-pr-description.md"
jq -r 'select(.is_error | not) | .result // empty' "$out" > "$description"
if [ ! -s "$description" ]; then
  give_up "Claude Code returned no description ($(jq -r '.subtype // "unknown"' "$out"))."
fi
publish "$description"

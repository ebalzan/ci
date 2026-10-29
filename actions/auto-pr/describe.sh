#!/usr/bin/env bash
#
# describe.sh — the "Describe" step of actions/auto-pr.
#
# Runs Claude Code headless on the branch with describe-prompt.md (__BRANCH__,
# __TYPE__ and __BASE__ filled in) and writes its reply as the PR description.
# Best-effort: any failure is a warning and leaves the description as it was.
#
# Env: GH_TOKEN, GH_REPO, ANTHROPIC_API_KEY, PR_URL, PR_TYPE, CLAUDE_CODE (the
# pinned npm spec), plus the runner's GITHUB_* and RUNNER_TEMP.
set -uo pipefail

base="${AUTO_BASE_BRANCH:-dev}"
model="${AUTO_DESCRIBE_MODEL:-claude-sonnet-5-5}"
args=(--model "$model")
# Haiku rejects the effort setting.
[[ "$model" == claude-haiku* ]] || args+=(--effort "${AUTO_DESCRIBE_EFFORT:-low}")

prompt="$(< "$(dirname "${BASH_SOURCE[0]}")/describe-prompt.md")"
prompt="${prompt//__BRANCH__/$GITHUB_REF_NAME}"
prompt="${prompt//__TYPE__/$PR_TYPE}"
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
  echo "::warning::Claude Code failed; the description is left as it was."
  exit 0
fi

description="$RUNNER_TEMP/auto-pr-description.md"
jq -r 'select(.is_error | not) | .result // empty' "$out" > "$description"
if [ ! -s "$description" ]; then
  echo "::warning::Claude Code returned no description ($(jq -r '.subtype // "unknown"' "$out")); the description is left as it was."
  exit 0
fi
gh pr edit "$PR_URL" --body-file "$description" >/dev/null ||
  echo "::warning::Could not update the description."

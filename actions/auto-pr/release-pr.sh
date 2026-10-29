#!/usr/bin/env bash
#
# release-pr.sh — the "Find or open PR" step of actions/auto-pr on a push to
# AUTO_BASE_BRANCH (dev): the release PR into AUTO_RELEASE_BRANCH (main).
#
# Finds the open dev → main PR or opens a DRAFT one, and keeps its title on the
# release merging it would cut: `<type>[!]: release vX.Y.Z`
# (scripts/release-title.mjs, git-cliff). The body is the changelog of the
# unreleased commits (config/cliff.toml); when the Describe step runs it puts a
# summary above it, so here only a new PR gets the bare changelog. Writes to
# GITHUB_OUTPUT:
#   label      release
#   changelog  the changelog file, for the Describe step
#   url        the PR's URL; not set when dev has nothing to release
#   created    true when this run opened the PR
#
# Env: GH_TOKEN, GH_REPO, DESCRIBE (true when the Describe step runs), plus the
# runner's GITHUB_* and RUNNER_TEMP. Needs the root package installed (git-cliff).
set -euo pipefail

ci_root="$(dirname "${BASH_SOURCE[0]}")/../.."
head="${AUTO_BASE_BRANCH:-dev}"
base="${AUTO_RELEASE_BRANCH:-main}"
echo "label=release" >> "$GITHUB_OUTPUT"

if [ "$(git rev-list --count "origin/$base..HEAD")" -eq 0 ]; then
  echo "::notice::'$head' has no commits that are not on '$base'; no release PR to open."
  exit 0
fi

title="$(node "$ci_root/scripts/release-title.mjs")"
if [ -z "$title" ]; then
  echo "::notice::'$head' has no Conventional Commit since the last release; no release PR to open."
  exit 0
fi

changelog="$RUNNER_TEMP/auto-pr-changelog.md"
{
  echo '## Changes'
  NO_COLOR=1 "$ci_root/node_modules/.bin/git-cliff" --config "$ci_root/config/cliff.toml" \
    --unreleased --bump --strip all
} > "$changelog"
echo "changelog=$changelog" >> "$GITHUB_OUTPUT"

pr="$(gh pr list --head "$head" --base "$base" --state open --json url,title --jq '.[0] // empty')"
if [ -z "$pr" ]; then
  url="$(gh pr create --draft --base "$base" --head "$head" --title "$title" --body-file "$changelog")"
  echo "created=true" >> "$GITHUB_OUTPUT"
  echo "::notice::Opened $url: $title"
else
  url="$(jq -r .url <<< "$pr")"
  # Only what changed: every edit is a PR event that re-runs PR Checks.
  edit=()
  [ "$(jq -r .title <<< "$pr")" = "$title" ] || edit+=(--title "$title")
  [ "${DESCRIBE:-false}" = true ] || edit+=(--body-file "$changelog")
  [ ${#edit[@]} -eq 0 ] || gh pr edit "$url" "${edit[@]}" >/dev/null
  echo "::notice::$url: $title"
fi
echo "url=$url" >> "$GITHUB_OUTPUT"

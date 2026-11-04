#!/usr/bin/env bash
#
# release-pr.sh — the "Find or open PR" step of actions/auto-pr on a push to
# AUTO_BASE_BRANCH (dev): the release PR into AUTO_RELEASE_BRANCH (main).
#
# Finds the open dev → main PR or opens one, and keeps its title on the release
# merging it would cut: `<type>[!]: release vX.Y.Z`
# (scripts/release-title.mjs, git-cliff). The body is the changelog of the
# unreleased commits (scripts/changelog.mjs); when the Describe step runs it puts a
# summary above it, so here only a new PR gets the bare changelog. Writes to
# GITHUB_OUTPUT:
#   label      release
#   changelog  the changelog file, for the Describe step
#   url        the PR's URL; not set when dev has nothing to release
#
# Env: GH_TOKEN (opens the PR), EDIT_TOKEN (edits it, starting no workflow),
# GH_REPO, DESCRIBE (true when the Describe step runs), plus the runner's
# GITHUB_* and RUNNER_TEMP. Needs the root package installed (git-cliff).
set -euo pipefail

ci_root="$(dirname "${BASH_SOURCE[0]}")/../.."
head="${AUTO_BASE_BRANCH:?}"
base="${AUTO_RELEASE_BRANCH:?}"
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
node "$ci_root/scripts/changelog.mjs" --unreleased --bump > "$changelog"
echo "changelog=$changelog" >> "$GITHUB_OUTPUT"

pr="$(gh pr list --head "$head" --base "$base" --state open --json url,title --jq '.[0] // empty')"
if [ -z "$pr" ]; then
  url="$(gh pr create --base "$base" --head "$head" --title "$title" --body-file "$changelog")"
  echo "::notice::Opened $url: $title"
else
  url="$(jq -r .url <<< "$pr")"
  # REST, not `gh pr edit`: see sync-metadata.sh. EDIT_TOKEN: the push already
  # started PR Checks, which waits for this run.
  edit=()
  [ "$(jq -r .title <<< "$pr")" = "$title" ] || edit+=(-f "title=$title")
  [ "${DESCRIBE:-false}" = true ] || edit+=(-F "body=@$changelog")
  [ ${#edit[@]} -eq 0 ] ||
    GH_TOKEN="$EDIT_TOKEN" gh api -X PATCH "repos/$GH_REPO/pulls/${url##*/}" "${edit[@]}" >/dev/null
  echo "::notice::$url: $title"
fi
echo "url=$url" >> "$GITHUB_OUTPUT"

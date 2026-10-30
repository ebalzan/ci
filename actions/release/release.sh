#!/usr/bin/env bash
#
# release.sh — the "Version and tag" step of actions/release.
#
# A re-run first: when the tag the PR title names exists and contains this
# merge, it is the output and nothing is pushed. (git-cliff starts from the
# newest vX.Y.Z tag in the repo, reachable or not, so it would find nothing to
# release here.) Otherwise recomputes the release title on main
# (scripts/release-title.mjs, git-cliff): it must equal the merged PR's title,
# which the PR check held to the same computation on dev. vX.Y.Z comes from it.
# With a package.json, a `chore(release): X.Y.Z` commit bumps it (and the
# lockfile) and the tag goes on that commit; without one, on the merge commit.
# Main and the tag are pushed in one atomic push, a fast-forward: when main
# moved meanwhile it is rejected and nothing is left half done. Writes to
# GITHUB_OUTPUT:
#   tag      vX.Y.Z
#   version  X.Y.Z
#   sha      the commit the tag points at
#
# Env: PR_TITLE, MERGE_SHA (the checked-out merge commit). Needs the root
# package installed (git-cliff).
set -euo pipefail

ci_root="$(dirname "${BASH_SOURCE[0]}")/../.."
main="${AUTO_RELEASE_BRANCH:-main}"

pattern='release v([0-9]+\.[0-9]+\.[0-9]+)$'

if [[ "$PR_TITLE" =~ $pattern ]] && git rev-parse -q --verify "refs/tags/v${BASH_REMATCH[1]}" >/dev/null; then
  version="${BASH_REMATCH[1]}"
  tag="v$version"
  sha="$(git rev-parse "$tag^{commit}")"
  if ! git merge-base --is-ancestor "$MERGE_SHA" "$sha"; then
    echo "::error::$tag already exists and does not contain this merge: it was released from something else."
    exit 1
  fi
  { echo "tag=$tag"; echo "version=$version"; echo "sha=$sha"; } >> "$GITHUB_OUTPUT"
  echo "::notice::$tag already exists ($sha); not tagging again."
  exit 0
fi

title="$(node "$ci_root/scripts/release-title.mjs")"
if [ -z "$title" ]; then
  echo "::error::There is no Conventional Commit on '$main' since the last release: nothing to release."
  exit 1
fi
if [ "$title" != "$PR_TITLE" ]; then
  echo "::error::The release PR is titled '$PR_TITLE', but '$main' computes '$title'. Nothing was released."
  exit 1
fi
[[ "$title" =~ $pattern ]]
version="${BASH_REMATCH[1]}"
tag="v$version"
{ echo "tag=$tag"; echo "version=$version"; } >> "$GITHUB_OUTPUT"

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'

# A repo without package.json (Go, Python, docs, …) is released tag-only.
if [ -f package.json ]; then
  npm version "$version" --no-git-tag-version --allow-same-version --ignore-scripts >/dev/null
  git add package.json
  for lockfile in package-lock.json npm-shrinkwrap.json; do
    if [ -f "$lockfile" ]; then git add "$lockfile"; fi
  done
  git diff --cached --quiet || git commit --quiet -m "chore(release): $version"
fi

git tag -a "$tag" -m "Release $tag"
sha="$(git rev-parse HEAD)"
git push --quiet --atomic origin "HEAD:refs/heads/$main" "refs/tags/$tag"
echo "sha=$sha" >> "$GITHUB_OUTPUT"
echo "::notice::Released $tag ($sha)."

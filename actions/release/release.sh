#!/usr/bin/env bash
#
# release.sh — the "Version and tag" step of actions/release.
#
# A re-run first: when the tag the PR title names exists and contains the PR's
# head, it is the output and only a missing or older major tag is pushed (see
# below). (git-cliff starts from the
# newest vX.Y.Z tag in the repo, reachable or not, so it would find nothing to
# release here.) Otherwise recomputes the release title on the checked-out head
# (scripts/release-title.mjs, git-cliff): it must equal the PR's title, which
# the PR check held to the same computation. vX.Y.Z comes from it
# (release-title.mjs --version-of, which also reads the PR title for a re-run).
# With a package.json, a `chore(release): X.Y.Z` commit bumps it (and the
# lockfile) and the tag goes on that commit; without one, on the head itself.
# Main and dev (both fast-forwarded to that commit), the tag and the moving
# major tag vX (what callers pin, e.g. `uses: …@v1`) are pushed in one atomic
# push: when main or dev moved meanwhile it is rejected and nothing is left
# half done. Main and dev end on the same commit, so the next release PR starts
# from the release. git-cliff and publish.sh match vX.Y.Z only, so vX never
# ends a changelog range. Writes to GITHUB_OUTPUT:
#   tag  vX.Y.Z
#   sha  the commit the tag points at
#
# Env: PR_TITLE, HEAD_SHA (the checked-out PR head). Needs the root package
# installed (git-cliff).
set -euo pipefail

ci_root="$(dirname "${BASH_SOURCE[0]}")/../.."
dev="${AUTO_BASE_BRANCH:?}"
main="${AUTO_RELEASE_BRANCH:?}"
# version_of TITLE — the X.Y.Z a release title names, or nothing.
version_of() { node "$ci_root/scripts/release-title.mjs" --version-of "$1"; }

version="$(version_of "$PR_TITLE")"
if [ -n "$version" ] && git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
  tag="v$version"
  sha="$(git rev-parse "$tag^{commit}")"
  if ! git merge-base --is-ancestor "$HEAD_SHA" "$sha"; then
    echo "::error::$tag already exists and does not contain the PR's head ($HEAD_SHA): it was released from something else."
    exit 1
  fi
  { echo "tag=$tag"; echo "sha=$sha"; } >> "$GITHUB_OUTPUT"
  echo "::notice::$tag already exists ($sha); not tagging again."
  # The major tag catches up when it is missing or behind, never moves back.
  major="v${version%%.*}"
  current="$(git rev-parse -q --verify "refs/tags/$major^{commit}" || true)"
  if [ "$current" != "$sha" ] && { [ -z "$current" ] || git merge-base --is-ancestor "$current" "$sha"; }; then
    git push --quiet --force origin "$sha:refs/tags/$major"
    echo "::notice::Moved $major to $tag ($sha)."
  fi
  exit 0
fi

title="$(node "$ci_root/scripts/release-title.mjs")"
if [ -z "$title" ]; then
  echo "::error::There is no Conventional Commit on '$dev' since the last release: nothing to release."
  exit 1
fi
if [ "$title" != "$PR_TITLE" ]; then
  echo "::error::The release PR is titled '$PR_TITLE', but its head computes '$title'. Nothing was released."
  exit 1
fi
version="$(version_of "$title")"
tag="v$version"
echo "tag=$tag" >> "$GITHUB_OUTPUT"

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

major="v${version%%.*}"
git tag -a "$tag" -m "Release $tag"
sha="$(git rev-parse HEAD)"
git tag --force "$major" "$sha" >/dev/null
if ! git push --quiet --atomic origin \
  "HEAD:refs/heads/$main" "HEAD:refs/heads/$dev" "refs/tags/$tag" "+refs/tags/$major"; then
  echo "::error::'$main' or '$dev' moved during the release, so nothing was pushed. Remove the 'ship' label from the release PR and add it again."
  exit 1
fi
echo "sha=$sha" >> "$GITHUB_OUTPUT"
echo "::notice::Released $tag ($sha): '$main' and '$dev' fast-forwarded to it; $major points at it."

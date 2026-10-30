#!/usr/bin/env bash
#
# sync-dev.sh — the "Sync dev" step of actions/release.
#
# Brings dev up to the release — its commit, package.json version and tag — so
# the next release PR starts from it (the PR check fails while dev is behind
# main). Never a force-push:
#   - dev is in the release's history (the usual case): dev fast-forwards to it.
#   - work landed on dev during the release: main is merged into dev
#     ("Merge branch 'main' into dev" — commitlint and git-cliff skip it). A
#     conflict stops here with what to do by hand.
#   - dev no longer contains the release PR's head (it was rewritten): error.
# When dev moves during the push, it tries once more.
#
# Env: HEAD_SHA (the release PR's head), RELEASE_SHA (the tagged commit),
# DEV_TOKEN (optional: pushes with it, so the push triggers Auto PR), plus the
# runner's GITHUB_SERVER_URL and GITHUB_REPOSITORY.
set -euo pipefail

dev="${AUTO_BASE_BRANCH:-dev}"
main="${AUTO_RELEASE_BRANCH:-main}"

# push SHA — SHA to dev, refused unless it is a fast-forward.
push() {
  if [ -n "${DEV_TOKEN:-}" ]; then
    # An empty extraheader drops the checkout's GITHUB_TOKEN for this push.
    git -c "http.$GITHUB_SERVER_URL/.extraheader=" push --quiet \
      "${GITHUB_SERVER_URL/:\/\//://x-access-token:$DEV_TOKEN@}/$GITHUB_REPOSITORY.git" \
      "$1:refs/heads/$dev"
  else
    git push --quiet origin "$1:refs/heads/$dev"
  fi
}

for attempt in 1 2; do
  git fetch --quiet origin "+refs/heads/$dev:refs/remotes/origin/$dev"
  dev_sha="$(git rev-parse "origin/$dev")"

  if [ "$dev_sha" = "$RELEASE_SHA" ]; then
    echo "::notice::'$dev' is already at the release ($RELEASE_SHA)."
    exit 0
  elif git merge-base --is-ancestor "$dev_sha" "$RELEASE_SHA"; then
    target="$RELEASE_SHA"
    done_message="Fast-forwarded '$dev' to the release ($RELEASE_SHA)."
  elif git merge-base --is-ancestor "$HEAD_SHA" "$dev_sha"; then
    git checkout --quiet --detach "$dev_sha"
    if ! git merge --quiet --no-ff --no-edit -m "Merge branch '$main' into $dev" "$RELEASE_SHA"; then
      git merge --abort
      echo "::error::Merging '$main' into '$dev' conflicts. By hand: git switch $dev && git merge origin/$main, resolve, push. Until then the release PR check fails ('$dev' is behind '$main')."
      exit 1
    fi
    target="$(git rev-parse HEAD)"
    done_message="Merged '$main' into '$dev': work landed on it during the release."
  else
    echo "::error::'$dev' ($dev_sha) no longer contains the release PR's head ($HEAD_SHA): it was rewritten. By hand: git switch $dev && git merge origin/$main, push."
    exit 1
  fi

  if push "$target"; then
    echo "::notice::$done_message"
    exit 0
  fi
  [ "$attempt" -eq 2 ] || echo "::notice::'$dev' moved during the push; trying again."
done

echo "::error::Could not update '$dev'. By hand: git switch $dev && git merge origin/$main, push."
exit 1

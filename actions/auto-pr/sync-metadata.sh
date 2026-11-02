#!/usr/bin/env bash
#
# sync-metadata.sh — the "Sync metadata" step of actions/auto-pr.
#
# Puts on the PR: its label (created when missing — a type label with its color
# from config/types.json via scripts/types.mjs, or `release` on the release PR), the pusher as
# assignee, AUTO_MILESTONE_TITLE and the AUTO_PROJECT_NUMBER board. On the
# release PR it also creates the `ship` label, which releases it
# (templates/.github/workflows/release.yml), but never adds it. Each is
# best-effort: a failure is a warning, and the PR check then names what is
# missing.
#
# Env: GH_TOKEN, GH_REPO, PR_URL, PR_LABEL, plus the runner's GITHUB_*.
set -uo pipefail

if [ "$PR_LABEL" = release ]; then
  color=0E8A16
  description="Release PR: ${AUTO_BASE_BRANCH:?} → ${AUTO_RELEASE_BRANCH:?}"
else
  color="$(node "$(dirname "${BASH_SOURCE[0]}")/../../scripts/types.mjs" color "$PR_LABEL")"
  description="Changes for '$PR_LABEL' branches"
fi
# Fails when the label exists — left as it is.
gh label create "$PR_LABEL" --color "$color" --description "$description" >/dev/null 2>&1
if [ "$PR_LABEL" = release ]; then
  gh label create ship --color 5319E7 \
    --description "Releases the release PR: fast-forwards $AUTO_RELEASE_BRANCH to $AUTO_BASE_BRANCH" >/dev/null 2>&1
fi

# REST, not `gh pr edit`: that one reads the PR's team review requests over
# GraphQL first, which a classic PAT without `read:org` cannot.
number="${PR_URL##*/}"

gh api -X POST "repos/$GH_REPO/issues/$number/labels" -f "labels[]=$PR_LABEL" >/dev/null ||
  echo "::warning::Could not add the '$PR_LABEL' label."
# A user who cannot be assigned is dropped without an error: check the result.
assignees="$(gh api -X POST "repos/$GH_REPO/issues/$number/assignees" \
  -f "assignees[]=$GITHUB_ACTOR" --jq '.assignees[].login')"
grep -qxF "$GITHUB_ACTOR" <<< "$assignees" ||
  echo "::warning::Could not assign $GITHUB_ACTOR."

if [ -n "${AUTO_MILESTONE_TITLE:-}" ]; then
  milestone="$(gh api "repos/$GH_REPO/milestones?state=open&per_page=100" --paginate |
    jq -rs --arg title "$AUTO_MILESTONE_TITLE" 'add | map(select(.title == $title))[0].number // empty')"
  if [ -z "$milestone" ] ||
    ! gh api -X PATCH "repos/$GH_REPO/issues/$number" -F "milestone=$milestone" >/dev/null; then
    echo "::warning::Could not set the milestone '$AUTO_MILESTONE_TITLE' (AUTO_MILESTONE_TITLE): it must exist and be open."
  fi
fi

# The GraphQL API directly, not `gh project item-add`: that one queries the
# owner as both a user and an organization, and without `read:org` the
# organization half fails ("unknown owner type"). Scopes are checked on every
# field asked for, even in a fragment that does not apply, so the owner's type
# comes first and then only that type is queried.
if [ -n "${AUTO_PROJECT_NUMBER:-}" ]; then
  owner="${AUTO_PROJECT_OWNER:-$GITHUB_REPOSITORY_OWNER}"
  project=''
  case "$(gh api graphql -f "login=$owner" \
    -f query='query($login: String!) { repositoryOwner(login: $login) { __typename } }' \
    --jq '.data.repositoryOwner.__typename // empty')" in
    User) kind=user ;;
    Organization) kind=organization ;;
    *) kind='' ;;
  esac
  if [ -n "$kind" ]; then
    project="$(gh api graphql -f "login=$owner" -F "number=$AUTO_PROJECT_NUMBER" -f query="
      query(\$login: String!, \$number: Int!) {
        $kind(login: \$login) { projectV2(number: \$number) { id } }
      }" --jq ".data.$kind.projectV2.id // empty")"
  fi
  pr_id="$(gh api "repos/$GH_REPO/pulls/$number" --jq .node_id)"
  # Adding an item already on the board returns it: safe on every push.
  if [ -z "$project" ] || [ -z "$pr_id" ] ||
    ! gh api graphql -f "project=$project" -f "pr=$pr_id" -f query='
      mutation($project: ID!, $pr: ID!) {
        addProjectV2ItemById(input: { projectId: $project, contentId: $pr }) { item { id } }
      }' >/dev/null; then
    echo "::warning::Could not add the PR to project $AUTO_PROJECT_NUMBER of $owner (AUTO_PROJECT_NUMBER): GH_PROJECT_TOKEN must be a classic PAT with the project scope."
  fi
fi
exit 0

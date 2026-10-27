#!/usr/bin/env bash
#
# onboard.sh — bring a repo under the shared rules in one step.
#
# In the repo's checkout it:
#   1. creates a branch (ci/onboard-ebalzan-ci) from dev — or from the default
#      branch when dev does not exist yet;
#   2. writes the templates/ files: the four thin workflow callers, a starter
#      .github/actions.env, renovate.json and, for a Node repo, the husky
#      commit-msg hook. A file that already exists is kept (--force replaces it);
#   3. for a Node repo (package.json), installs this package and husky as
#      devDependencies and sets `prepare: husky` when no prepare script exists;
#   4. commits it all as `ci: onboard <ci repo>`.
# Then, unless --no-push:
#   5. creates the dev branch on GitHub if it is missing;
#   6. tags the repo with REPOS_TOPIC (config/repos.env), so `--all` finds it;
#   7. runs the bootstrap (variables, secrets, settings, rulesets);
#   8. pushes the branch. The auto-pr.yml it adds runs on that very push and
#      opens the tracking issue and the PR into dev. Review and squash-merge it.
#
# Usage:
#   ebalzan-ci onboard [options]          # the repo in the current directory
#   ebalzan-ci onboard -C ../my-repo [options]
#
# Options:
#   -C, --repo-dir DIR     Checkout of the repo to onboard (default: .)
#   -R, --repo OWNER/REPO  Its slug (default: from DIR's git remote)
#       --runs-on LABEL    Runner label for every job (default: ubuntu-latest)
#       --ref REF          Ref the callers pin (default: v<major of this package>)
#       --branch NAME      Branch to commit on (default: ci/onboard-ebalzan-ci)
#       --force            Overwrite files that already exist
#       --no-npm           Skip the npm installs even when package.json exists
#       --no-push          Stop after the local commit (no GitHub changes at all)
#   -n, --dry-run          Show what would happen; change nothing
#   -y, --yes              Skip the confirmations (also for the bootstrap)
#   -h, --help             Show this help
#
# Requirements: git; gh authenticated with admin on the repo (not needed with
# --no-push or --dry-run); npm for a Node repo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CI_ROOT="$(dirname "$SCRIPT_DIR")"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

TEMPLATES_DIR="$CI_ROOT/templates"
REPOS_FILE="$CI_ROOT/config/repos.env"
CI_REPO="$(unquote "$(env_get "$REPOS_FILE" CI_REPO)")"
CI_PACKAGE="$(node "$SCRIPT_DIR/_json.mjs" get "$CI_ROOT/package.json" name)"
CI_VERSION="$(node "$SCRIPT_DIR/_json.mjs" get "$CI_ROOT/package.json" version)"
TOPIC="$(unquote "$(env_get "$REPOS_FILE" REPOS_TOPIC)")"

# ---- args --------------------------------------------------------------------
REPO_DIR="."
REPO=""
RUNS_ON="ubuntu-latest"
REF="v${CI_VERSION%%.*}"
BRANCH="ci/onboard-ebalzan-ci"
FORCE=false
NPM=true
PUSH=true
DRY_RUN=false
ASSUME_YES=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    -C|--repo-dir) REPO_DIR="${2:-}"; shift 2 ;;
    -R|--repo)     REPO="${2:-}"; shift 2 ;;
    --runs-on)     RUNS_ON="${2:-}"; shift 2 ;;
    --ref)         REF="${2:-}"; shift 2 ;;
    --branch)      BRANCH="${2:-}"; shift 2 ;;
    --force)       FORCE=true; shift ;;
    --no-npm)      NPM=false; shift ;;
    --no-push)     PUSH=false; shift ;;
    -n|--dry-run)  DRY_RUN=true; shift ;;
    -y|--yes)      ASSUME_YES=true; shift ;;
    -h|--help)     print_help "${BASH_SOURCE[0]}"; exit 0 ;;
    *)             die "Unknown option: $1 (try --help)" ;;
  esac
done

[[ -n "$CI_REPO" ]] || die "CI_REPO is not set in $REPOS_FILE."
[[ -n "$RUNS_ON" && -n "$REF" && -n "$BRANCH" ]] || die "--runs-on, --ref and --branch need a value."

# ---- preconditions -----------------------------------------------------------
[[ -d "$REPO_DIR/.git" || -f "$REPO_DIR/.git" ]] || die "$REPO_DIR is not a git checkout."
REPO_DIR="$(cd "$REPO_DIR" && pwd)"
git_() { git -C "$REPO_DIR" "$@"; }

if $PUSH && ! $DRY_RUN; then
  require_gh
  require_auth
fi
if [[ -z "$REPO" ]] && command -v gh >/dev/null 2>&1; then REPO="$(detect_repo "$REPO_DIR")"; fi
if $PUSH && [[ -z "$REPO" ]]; then
  die "Could not determine the repo for $REPO_DIR. Pass --repo OWNER/REPO (or --no-push)."
fi
if [[ -n "$(git_ status --porcelain)" ]] && ! $DRY_RUN; then
  die "$REPO_DIR has uncommitted changes. Commit or stash them first."
fi
if git_ rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null; then
  die "Branch $BRANCH already exists in $REPO_DIR. Delete it or pass --branch."
fi

# Branch point: dev if it exists, else the default branch, else HEAD (no remote).
HAS_ORIGIN=false
git_ remote get-url origin >/dev/null 2>&1 && HAS_ORIGIN=true
if $HAS_ORIGIN && ! $DRY_RUN; then git_ fetch --quiet origin || warn "git fetch origin failed; using local refs."; fi
DEV_EXISTS=false
if $HAS_ORIGIN && git_ rev-parse --verify --quiet refs/remotes/origin/dev >/dev/null; then
  DEV_EXISTS=true; BASE_REF="origin/dev"
elif $HAS_ORIGIN && git_ rev-parse --verify --quiet refs/remotes/origin/HEAD >/dev/null; then
  BASE_REF="$(git_ symbolic-ref --short refs/remotes/origin/HEAD)"
else
  BASE_REF="HEAD"
fi

IS_NODE=false
[[ -f "$REPO_DIR/package.json" ]] && IS_NODE=true

# ---- plan --------------------------------------------------------------------
# applies REL — whether template REL belongs in this repo at all.
applies() {
  case "$1" in
    .husky/*) $IS_NODE; return ;;
    renovate.json)
      # Any existing Renovate config is the repo's own; extend the preset there.
      local f
      for f in renovate.json renovate.json5 .renovaterc .renovaterc.json .github/renovate.json .github/renovate.json5; do
        if [[ -e "$REPO_DIR/$f" ]] && ! $FORCE; then return 1; fi
      done ;;
  esac
  return 0
}

PLAN=()   # "action<TAB>rel" with action = create | overwrite | keep | skip
while IFS= read -r rel; do
  if ! applies "$rel"; then PLAN+=("skip	$rel")
  elif [[ -e "$REPO_DIR/$rel" ]]; then
    if $FORCE; then PLAN+=("overwrite	$rel"); else PLAN+=("keep	$rel"); fi
  else PLAN+=("create	$rel")
  fi
done < <(cd "$TEMPLATES_DIR" && find . -type f | sed 's#^\./##' | sort)

info ""
info "${BOLD}Onboard${RESET}   ${DIM}${REPO:-$(basename "$REPO_DIR")}  ←  $CI_REPO@$REF (runs-on: $RUNS_ON)${RESET}"
info ""
info "  ${BOLD}files${RESET} ${DIM}(branch $BRANCH from $BASE_REF)${RESET}"
for entry in "${PLAN[@]}"; do
  action="${entry%%	*}"; rel="${entry#*	}"
  case "$action" in
    create|overwrite) printf '    %-10s %s\n' "$action" "$rel" ;;
    keep)             printf '    %s%-10s %s (exists — --force replaces it)%s\n' "$DIM" keep "$rel" "$RESET" ;;
    skip)             printf '    %s%-10s %s (%s)%s\n' "$DIM" skip "$rel" "$([[ "$rel" == .husky/* ]] && echo 'no package.json' || echo 'repo has its own Renovate config')" "$RESET" ;;
  esac
done
if $IS_NODE && $NPM; then
  info "  ${BOLD}npm${RESET}"
  info "    install --save-dev $CI_PACKAGE@^${CI_VERSION%%.*}.0.0 (and husky, if missing)"
fi
if $PUSH; then
  info "  ${BOLD}GitHub${RESET} ${DIM}($REPO)${RESET}"
  $DEV_EXISTS || info "    create branch dev from $BASE_REF"
  [[ -z "$TOPIC" ]] || info "    add topic '$TOPIC'"
  info "    bootstrap: variables, secrets, settings, rulesets"
  info "    push $BRANCH → auto-pr.yml opens the PR into dev"
else
  info "  ${DIM}--no-push: GitHub is left untouched${RESET}"
fi
info ""

if $DRY_RUN; then
  ok "Dry run complete — nothing was changed."
  exit 0
fi

# ---- local changes -----------------------------------------------------------
git_ switch --quiet --no-track -c "$BRANCH" "$BASE_REF"

render() { # render REL — template → repo, placeholders filled in
  local src="$TEMPLATES_DIR/$1" dest="$REPO_DIR/$1"
  mkdir -p "$(dirname "$dest")"
  sed -e "s#__CI_REPO__#$CI_REPO#g" \
      -e "s#__CI_REPO_NAME__#${CI_REPO#*/}#g" \
      -e "s#__CI_REF__#$REF#g" \
      -e "s#__CI_PACKAGE__#$CI_PACKAGE#g" \
      -e "s#__RUNS_ON__#$RUNS_ON#g" "$src" > "$dest"
  [[ ! -x "$src" && "$1" != .husky/* ]] || chmod +x "$dest"
}

for entry in "${PLAN[@]}"; do
  action="${entry%%	*}"; rel="${entry#*	}"
  case "$action" in create|overwrite) render "$rel"; ok "$action $rel" ;; esac
done

if $IS_NODE && $NPM; then
  step "Installing devDependencies"
  (cd "$REPO_DIR" && npm install --save-dev --no-audit --no-fund "$CI_PACKAGE@^${CI_VERSION%%.*}.0.0") \
    || warn "Could not install $CI_PACKAGE (is it published?). The hook skips the local check until it is installed."
  if ! (cd "$REPO_DIR" && node -e 'const p=require("./package.json");process.exit((p.devDependencies||{}).husky||(p.dependencies||{}).husky?0:1)'); then
    (cd "$REPO_DIR" && npm install --save-dev --no-audit --no-fund husky) || warn "Could not install husky."
  fi
  if [[ "$(cd "$REPO_DIR" && npm pkg get scripts.prepare)" == "{}" ]]; then
    (cd "$REPO_DIR" && npm pkg set scripts.prepare=husky) && ok "set scripts.prepare = husky"
  fi
fi

git_ add -A
if git_ diff --cached --quiet; then
  warn "Nothing to commit — every file already exists. Use --force to replace them."
  git_ switch --quiet -
  git_ branch --quiet -D "$BRANCH"
  exit 0
fi
git_ commit --quiet -m "ci: onboard $CI_REPO shared workflows and rules"
ok "Committed on $BRANCH: $(git_ log -1 --pretty=%s)"

if ! $PUSH; then
  info ""
  ok "${BOLD}Local onboarding done.${RESET} Review with: git -C $REPO_DIR show --stat"
  info "Then push it yourself, or re-run without --no-push after deleting the branch."
  exit 0
fi

# ---- GitHub ------------------------------------------------------------------
if ! $ASSUME_YES; then
  confirm "Apply the GitHub steps above to $REPO and push $BRANCH?" || die "Stopped. The local commit on $BRANCH is kept."
fi

if ! $DEV_EXISTS; then
  default_branch="$(gh repo view "$REPO" --json defaultBranchRef -q .defaultBranchRef.name)"
  sha="$(gh api "repos/$REPO/commits/$default_branch" -q .sha)"
  gh api -X POST "repos/$REPO/git/refs" -f ref=refs/heads/dev -f sha="$sha" >/dev/null
  ok "created branch dev from $default_branch (${sha:0:7})"
fi

if [[ -n "$TOPIC" ]]; then
  gh repo edit "$REPO" --add-topic "$TOPIC" >/dev/null && ok "added topic '$TOPIC'"
fi

BOOTSTRAP_ARGS=(--repo-dir "$REPO_DIR" --repo "$REPO")
$ASSUME_YES && BOOTSTRAP_ARGS+=(--yes)
"$SCRIPT_DIR/gh-bootstrap.sh" "${BOOTSTRAP_ARGS[@]}" \
  || warn "Bootstrap did not finish; fix the cause and re-run: ebalzan-ci bootstrap -C $REPO_DIR"

git_ push --quiet -u origin "$BRANCH"
ok "pushed $BRANCH"

info ""
ok "${BOLD}$REPO is onboarded.${RESET}"
info "  1. The PR into dev opens within a minute (auto-pr.yml). If it does not:"
info "     https://github.com/$REPO/compare/dev...$BRANCH"
info "  2. Add the repo's own checks to .github/workflows/pr-checks.yml and its"
info "     ship job to release.yml (both have a commented example)."
info "  3. Squash-merge the PR, then the dev → main PR: the first release."

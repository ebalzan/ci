#!/usr/bin/env bash
#
# gh-reset.sh — delete GitHub Actions variables (and optionally secrets) on a repo.
#
# Lists what exists on the repo, shows it, and deletes it after a typed
# confirmation. Destructive and irreversible — use --dry-run first.
#
# Repository scope by default (organization-level config is never touched).
# By default only variables are removed; secret deletion must be requested
# explicitly. Settings and rulesets are not reset here — edit or delete them in
# the repo's Settings, or let `ebalzan-ci bootstrap --prune` remove managed
# rulesets no file defines.
#
# --env NAME switches to an ENVIRONMENT's config instead of the repository's.
# The two scopes are separate namespaces — a repo-scope run cannot see, list, or
# delete an environment's secrets, which is why clearing deploy credentials
# needs the flag:
#
#   ebalzan-ci reset -R owner/repo --env production --secrets-only --dry-run
#
# Note that gh-bootstrap.sh strips a _FILE suffix when it sets a secret, so
# FOO_FILE in a dotenv file is named FOO on GitHub.
#
# Re-running the bootstrap after a reset restores the repo's variables and
# the merged shared + repo secrets. To remove only keys that no file defines any more, prefer
# `gh-bootstrap.sh --prune`, which works out the stale set for you.
#
# Usage:
#   ebalzan-ci reset [options]                # repo in the current directory
#   ebalzan-ci reset -C ../my-repo [options]
#   ebalzan-ci reset -R owner/repo [options]  # no checkout needed
#   bin/gh-reset.sh [options]                 # same, from a checkout of ebalzan/ci
#
# Options:
#   -C, --repo-dir DIR    Repo checkout whose remote picks the target (default: .)
#   -R, --repo OWNER/REPO Target repo (default: detected from DIR's git remote)
#   -e, --env NAME        Target the environment NAME instead of the repository
#       --include-secrets Also delete secrets (default: variables only)
#       --secrets-only    Delete secrets only, leave variables
#   -m, --match REGEX     Only delete names matching this extended regex
#   -n, --dry-run         List what would be deleted; delete nothing
#   -y, --yes             Skip the typed confirmation (dangerous)
#   -h, --help            Show this help
#
# Requirements: gh (GitHub CLI), authenticated with admin on the target repo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# ---- args --------------------------------------------------------------------
REPO=""
REPO_DIR="."
ENVIRONMENT=""
DO_VARS=true
DO_SECRETS=false
MATCH=""
DRY_RUN=false
ASSUME_YES=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    -C|--repo-dir)     REPO_DIR="${2:-}"; shift 2 ;;
    -R|--repo)         REPO="${2:-}"; shift 2 ;;
    -e|--env)          ENVIRONMENT="${2:-}"; shift 2 ;;
    --include-secrets) DO_SECRETS=true; shift ;;
    --secrets-only)    DO_SECRETS=true; DO_VARS=false; shift ;;
    -m|--match)        MATCH="${2:-}"; shift 2 ;;
    -n|--dry-run)      DRY_RUN=true; shift ;;
    -y|--yes)          ASSUME_YES=true; shift ;;
    -h|--help)         print_help "${BASH_SOURCE[0]}"; exit 0 ;;
    *)                 die "Unknown option: $1 (try --help)" ;;
  esac
done

# ---- preconditions & targets -------------------------------------------------
require_gh
require_auth
[[ -n "$REPO" ]] || REPO="$(detect_repo "$REPO_DIR")"
[[ -n "$REPO" ]] || die "Could not determine the repo. Pass --repo OWNER/REPO."

# Repo scope unless --env was given. Every gh call takes these flags, so the two
# scopes can never be mixed up halfway through a run.
GH_SCOPE=(--repo "$REPO")
if [[ -n "$ENVIRONMENT" ]]; then
  gh api "repos/$REPO/environments/$ENVIRONMENT" >/dev/null 2>&1 \
    || die "Environment '$ENVIRONMENT' does not exist on $REPO."
  GH_SCOPE+=(--env "$ENVIRONMENT")
fi
SCOPE_LABEL="$REPO${ENVIRONMENT:+ · environment: $ENVIRONMENT}"

# List the names of a kind (variable|secret) in scope, filtered by --match.
list_names() { # list_names KIND
  local names
  names="$(gh "$1" list "${GH_SCOPE[@]}" --json name --jq '.[].name' 2>/dev/null || true)"
  [[ -n "$MATCH" ]] && names="$(printf '%s\n' "$names" | grep -E "$MATCH" || true)"
  printf '%s' "$names"
}

# ---- one kind batch ----------------------------------------------------------
reset_batch() { # reset_batch KIND   (KIND = variable|secret)
  local kind="$1" names count
  names="$(list_names "$kind")"
  count="$(printf '%s\n' "$names" | grep -c . || true)"

  if [[ "$count" -eq 0 ]]; then
    info "  ${DIM}no ${kind}s${MATCH:+ matching /$MATCH/}${RESET}"
    return
  fi

  step "${kind}s to delete from ${BOLD}$SCOPE_LABEL${RESET} ($count)"
  printf '  - %s\n' $names

  if $DRY_RUN; then return; fi

  if ! $ASSUME_YES; then
    confirm_typed "$REPO" \
      "Type '${BOLD}$REPO${RESET}' to permanently delete these $count ${kind}(s) from ${BOLD}$SCOPE_LABEL${RESET}:" \
      || { warn "Skipped ${kind}s (confirmation did not match)."; return; }
  fi

  local name
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    gh "$kind" delete "$name" "${GH_SCOPE[@]}" && ok "deleted $kind $name"
  done <<< "$names"
}

# ---- execute -----------------------------------------------------------------
info ""
info "${BOLD}Reset GitHub Actions config${RESET}   ${DIM}repo: $SCOPE_LABEL${MATCH:+ · match: /$MATCH/}${DRY_RUN:+ · dry-run}${RESET}"
info ""

# An environment holds secrets far more often than variables, and the default
# is variables-only — so say so rather than reporting an empty run as success.
if [[ -n "$ENVIRONMENT" ]] && ! $DO_SECRETS; then
  warn "Only variables are in scope. Environment secrets need --secrets-only (or --include-secrets)."
fi

if $DO_VARS;    then reset_batch variable; fi
if $DO_SECRETS; then reset_batch secret;   fi

info ""
if $DRY_RUN; then
  ok "Dry run complete — nothing was deleted."
else
  ok "${BOLD}Reset complete.${RESET}"
fi

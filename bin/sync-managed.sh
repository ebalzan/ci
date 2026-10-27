#!/usr/bin/env bash
#
# sync-managed.sh — refresh repos' local copies of ebalzan/ci's managed/ files.
#
# DEPRECATED since 2.0. managed/ holds files a repo's local tooling runs —
# today only the Conventional Commits validator behind the husky commit-msg
# hook. Repos now run it from the npm package (`ebalzan-ci commit-msg`, see
# templates/.husky/commit-msg) and keep NO copy. This script remains for repos
# that still keep a verbatim copy at <repo>/<path>: it keeps those copies
# current until they move to the package. The PR-title check
# (actions/pr-title) fails on any copy that differs.
#
# Only copies that already exist are updated; --install creates missing ones.
#
# Usage:
#   ebalzan-ci sync-managed [-C DIR | --all] [--check | --install]
#
# Options:
#   -C, --repo-dir DIR   Repo checkout to update (default: current directory)
#   -a, --all            Every repo config/repos.env selects that has a local
#                        checkout under $CI_REPOS_ROOT
#       --check          Report differing copies; change nothing (exit 1 on drift)
#       --install        Also create copies the repo does not have yet
#   -h, --help           Show this help
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CI_ROOT="$(dirname "$SCRIPT_DIR")"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"
MANAGED_DIR="$CI_ROOT/managed"

REPO_DIRS=()
ALL=false
CHECK=false
INSTALL=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    -C|--repo-dir) REPO_DIRS+=("${2:-}"); shift 2 ;;
    -a|--all)      ALL=true; shift ;;
    --check)       CHECK=true; shift ;;
    --install)     INSTALL=true; shift ;;
    -h|--help)     print_help "${BASH_SOURCE[0]}"; exit 0 ;;
    *)             die "Unknown option: $1 (try --help)" ;;
  esac
done

if $ALL; then
  require_gh
  require_auth
  for slug in $(managed_repos "$CI_ROOT/config/repos.env" "$CI_ROOT"); do
    dir="$(local_checkout "$slug" "$CI_ROOT")"
    if [[ -n "$dir" ]]; then REPO_DIRS+=("$dir"); else info "${DIM}$slug — no local checkout, skipped${RESET}"; fi
  done
fi
[[ ${#REPO_DIRS[@]} -gt 0 ]] || REPO_DIRS=(".")

drift=0
for dir in "${REPO_DIRS[@]}"; do
  [[ -d "$dir" ]] || { warn "No checkout at $dir — skipped."; drift=1; continue; }
  step "$(basename "$(cd "$dir" && pwd)")"
  while IFS= read -r rel; do
    target="$dir/$rel"
    if [[ ! -f "$target" ]] && ! $INSTALL; then
      info "  ${DIM}$rel — no local copy (the hook runs it from the package)${RESET}"; continue
    fi
    if [[ -f "$target" ]] && cmp -s "$MANAGED_DIR/$rel" "$target"; then
      ok "$rel up to date"; continue
    fi
    if $CHECK; then
      warn "$rel differs"; drift=1; continue
    fi
    mkdir -p "$(dirname "$target")"
    cp "$MANAGED_DIR/$rel" "$target"
    chmod +x "$target"
    ok "$rel updated"
  done < <(cd "$MANAGED_DIR" && find . -type f | sed 's#^\./##' | sort)
done

if $CHECK && [[ "$drift" -ne 0 ]]; then die "Managed files out of date — run sync-managed without --check."; fi
exit 0

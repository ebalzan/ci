#!/usr/bin/env bash
#
# sync-managed.sh — refresh repos' local copies of tracebim-ci's managed/ files.
#
# managed/ holds files a repo's local tooling runs — today only the
# Conventional Commits validator its husky commit-msg hook calls. The preferred
# setup keeps NO copy: the hook runs it from the sibling ../tracebim-ci checkout
# (or $TRACEBIM_CI_DIR), as tracebim-api does. A repo that wants the hook to
# work without that checkout keeps a verbatim copy at <repo>/<path> instead
# (tracebim-ci is private, so it cannot be npm-installed), and this script
# keeps those copies current.
#
# Only copies that already exist are updated; --install creates missing ones.
# The PR-title check (actions/pr-title) fails on any copy that differs.
#
# Usage:
#   bin/sync-managed.sh [-C DIR | --all] [--check | --install]
#
# Options:
#   -C, --repo-dir DIR   Repo checkout to update (default: current directory)
#   -a, --all            Every repo in config/repos.env
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
    -h|--help)     awk 'NR>1 && /^#/{ sub(/^# ?/, ""); print; next } NR>1{ exit }' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)             die "Unknown option: $1 (try --help)" ;;
  esac
done

if $ALL; then
  root="${TRACEBIM_REPOS_ROOT:-$(dirname "$CI_ROOT")}"
  for name in $(env_get "$CI_ROOT/config/repos.env" REPOS); do REPO_DIRS+=("$root/$name"); done
fi
[[ ${#REPO_DIRS[@]} -gt 0 ]] || REPO_DIRS=(".")

drift=0
for dir in "${REPO_DIRS[@]}"; do
  [[ -d "$dir" ]] || { warn "No checkout at $dir — skipped."; drift=1; continue; }
  step "$(basename "$(cd "$dir" && pwd)")"
  while IFS= read -r rel; do
    target="$dir/$rel"
    if [[ ! -f "$target" ]] && ! $INSTALL; then
      info "  ${DIM}$rel — no local copy (hook runs tracebim-ci directly)${RESET}"; continue
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

if $CHECK && [[ "$drift" -ne 0 ]]; then die "Managed files out of date — run bin/sync-managed.sh without --check."; fi
exit 0

#!/usr/bin/env bash
#
# _lib.sh — shared helpers for the tracebim-ci GitHub-config tools.
# This file is *sourced*, not executed. The sourcing script owns `set -euo pipefail`.
#
# Also sourced by repo-local admin tools (tracebim-api scripts/provision-host.sh,
# tracebim-frontend .github/scripts/vercel-env.sh) through
# ${TRACEBIM_CI_DIR:-<repo>/../tracebim-ci}/bin/_lib.sh, so keep it free of
# anything specific to one script.
#
# Bash 3.2 compatible (macOS /bin/bash): no associative arrays, no mapfile.

# ---- pretty output -----------------------------------------------------------
if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; CYAN=''; RESET=''
fi
info() { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$CYAN$BOLD" "$RESET" "$*"; }
ok()   { printf '%s ✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s ! %s%s\n' "$YELLOW" "$*" "$RESET"; }
die()  { printf '%s ✗ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

# ---- dotenv helpers ----------------------------------------------------------
# Print only KEY=VALUE lines (drop comments and blanks). Missing file → nothing.
clean_env() { [[ -f "$1" ]] && grep -vE '^[[:space:]]*(#|$)' "$1" || true; }
# Print just the key names from an env file.
env_keys()  { clean_env "$1" | sed -E 's/=.*//'; }
# Count the KEY=VALUE lines in an env file (0 if missing/empty).
env_count() { clean_env "$1" | grep -c . || true; }
# Read a single value: env_get FILE KEY. A missing key or file prints nothing
# and still succeeds, so `x="$(env_get ...)"` is safe under `set -e`.
env_get()   { { clean_env "$1" | grep -E "^$2=" | head -1 | cut -d= -f2-; } || true; }
# Strip one pair of matching surrounding quotes, as dotenv parsers do.
unquote()   {
  local v="$1"
  if [[ ${#v} -ge 2 && ( ( "${v:0:1}" == '"' && "${v: -1}" == '"' ) || ( "${v:0:1}" == "'" && "${v: -1}" == "'" ) ) ]]; then
    v="${v:1:${#v}-2}"
  fi
  printf '%s' "$v"
}

# ---- gh helpers --------------------------------------------------------------
require_gh() {
  command -v gh >/dev/null 2>&1 \
    || die "GitHub CLI (gh) is not installed: https://cli.github.com"
}
require_auth() {
  gh auth status >/dev/null 2>&1 \
    || die "gh is not authenticated. Run: gh auth login   (board scope: gh auth refresh -s project)"
}

# detect_repo [DIR] — OWNER/REPO of the checkout at DIR (default: cwd). Prints it.
# Starts from the git remote, then asks GitHub for the canonical name, so a repo
# that was transferred (whose old remote URL still redirects) resolves to where
# it lives now — the scope its variables and secrets actually belong to.
detect_repo() {
  local dir="${1:-.}" repo canonical
  repo="$(git -C "$dir" remote get-url origin 2>/dev/null \
    | sed -E 's#(git@|ssh://git@|https://)([^/:]+)[:/]##; s#\.git$##' || true)"
  if [[ -n "$repo" ]]; then
    canonical="$(gh repo view "$repo" --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
    [[ -n "$canonical" ]] && repo="$canonical"
  fi
  printf '%s' "$repo"
}

# Web URL of a Projects (v2) board. User-owned boards live under /users/, not
# /orgs/ — the owner type decides, so ask the API and default to users.
project_url() { # project_url OWNER NUMBER
  local kind
  kind="$(gh api "users/$1" -q .type 2>/dev/null || true)"
  if [[ "$kind" == "Organization" ]]; then
    printf 'https://github.com/orgs/%s/projects/%s' "$1" "$2"
  else
    printf 'https://github.com/users/%s/projects/%s' "$1" "$2"
  fi
}

# ---- prompts -----------------------------------------------------------------
# confirm "question" → 0 if the user answers y/Y
confirm() {
  local reply
  printf '%s%s [y/N] %s' "$YELLOW" "$1" "$RESET"
  read -r reply
  [[ "$reply" =~ ^[Yy]$ ]]
}
# confirm_typed EXPECTED "prompt" → 0 only if the user types EXPECTED verbatim
confirm_typed() {
  local reply
  printf '%s%s%s ' "$YELLOW" "$2" "$RESET"
  read -r reply
  [[ "$reply" == "$1" ]]
}

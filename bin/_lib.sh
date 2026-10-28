#!/usr/bin/env bash
#
# _lib.sh — shared helpers for the ebalzan/ci GitHub-config tools.
# This file is *sourced*, not executed. The sourcing script owns `set -euo pipefail`.
#
# Also meant to be sourced by a repo's own admin scripts, so keep it free of
# anything specific to one script. Find it with the CLI:
#
#   source "$(npx --no-install ebalzan-ci path)/bin/_lib.sh"
#
# Bash 3.2 compatible (macOS /bin/bash): no associative arrays, no mapfile.

# ---- pretty output -----------------------------------------------------------
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
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

# ---- repo discovery ----------------------------------------------------------
# ci_repos_root CI_ROOT — where `--all` looks for local checkouts
# (<root>/<repo name>). TRACEBIM_REPOS_ROOT is the pre-2.0 name, still honoured.
ci_repos_root() {
  printf '%s' "${CI_REPOS_ROOT:-${TRACEBIM_REPOS_ROOT:-$(dirname "$1")}}"
}

# managed_repos REPOS_FILE CI_ROOT — every OWNER/REPO `--all` acts on, one per
# line, de-duplicated: the repos of REPOS_OWNER (default: the gh user) tagged
# with REPOS_TOPIC, plus the explicit REPOS list. A REPOS entry without a slash
# is a pre-2.0 checkout directory name under ci_repos_root; its slug comes from
# that checkout's remote.
managed_repos() {
  local file="$1" ci_root="$2" topic owner entry root
  topic="$(unquote "$(env_get "$file" REPOS_TOPIC)")"
  owner="$(unquote "$(env_get "$file" REPOS_OWNER)")"
  root="$(ci_repos_root "$ci_root")"
  {
    if [[ -n "$topic" ]]; then
      [[ -n "$owner" ]] || owner="$(gh api user -q .login 2>/dev/null || true)"
      [[ -n "$owner" ]] || die "REPOS_TOPIC is set but the gh user is unknown. Run gh auth login, or set REPOS_OWNER."
      gh repo list "$owner" --topic "$topic" --no-archived --limit 1000 \
        --json nameWithOwner -q '.[].nameWithOwner' \
        || die "Could not list $owner's repos tagged '$topic'."
    fi
    for entry in $(unquote "$(env_get "$file" REPOS)"); do
      if [[ "$entry" == */* ]]; then
        printf '%s\n' "$entry"
      elif [[ -d "$root/$entry" ]]; then
        detect_repo "$root/$entry"; printf '\n'
      else
        warn "REPOS entry '$entry' has no checkout at $root/$entry — use OWNER/REPO."
      fi
    done
  } | awk 'NF && !seen[tolower($0)]++'
}

# local_checkout SLUG CI_ROOT — the local checkout of SLUG, if there is one:
# this repo itself, or <ci_repos_root>/<repo name> whose remote is SLUG. Prints
# nothing otherwise.
local_checkout() {
  local slug="$1" ci_root="$2" dir found
  for dir in "$ci_root" "$(ci_repos_root "$ci_root")/${slug#*/}"; do
    [[ -d "$dir/.git" || -f "$dir/.git" ]] || continue
    found="$(detect_repo "$dir")"
    if [[ "$(printf '%s' "$found" | tr '[:upper:]' '[:lower:]')" == "$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]')" ]]; then
      (cd "$dir" && pwd); return 0
    fi
  done
  return 0
}

# print_help SCRIPT — the script's leading comment block, minus the shebang.
print_help() {
  awk 'NR>1 && /^#/{ sub(/^# ?/, ""); print; next } NR>1{ exit }' "$1"
}

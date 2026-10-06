#!/usr/bin/env bash
#
# gh-bootstrap.sh — sync GitHub Actions variables & secrets onto a repo,
# merging tracebim-ci's SHARED config with the repo's OWN config.
#
# Layers, lowest precedence first — for any key, the repo's value wins:
#
#   variables            tracebim-ci/config/actions.env      (read at run time, never pushed)
#                        <repo>/.github/actions.env          (pushed)
#   repository secrets   tracebim-ci/config/secrets.env
#                        <repo>/.github/secrets.env
#   environment secrets  tracebim-ci/config/secrets.<environment>.env
#   (environment <name>) <repo>/.github/secrets.<environment>.env
#
# A repo can therefore override any shared key and add any key of its own,
# in any scope. Every environment named by a file in either layer is created on
# the repo and synced. Secrets files are gitignored; each has a committed
# .example beside it.
#
# Variables vs secrets. Shared VARIABLES are not copied onto repos: the actions
# read config/actions.env from the copy of tracebim-ci the runner downloads for
# `uses: …@v1` (actions/auto-work-items/src/sharedVars.ts) and fill only what
# the repo leaves unset. So a shared variable changes by moving the v1 tag, and
# only the repo's own keys are pushed — --prune deletes old shared copies.
# Shared SECRETS cannot work that way (they are not committed), so they are
# still merged in at sync time: after changing one, re-run with --all.
#
# Secret mechanics:
#   - A KEY ending in _FILE is a path: the secret is set from that file's
#     contents under the stripped name (multiline values cannot live in a
#     dotenv file). A relative path is relative to the env file's directory.
#     FOO_FILE in a repo overrides a shared FOO, and vice versa.
#   - LOCAL_ONLY_KEYS in the repo's .github/bootstrap.conf are never pushed:
#     they are read only by local tools (e.g. tracebim-api's
#     scripts/provision-host.sh), so keeping them on GitHub would only widen
#     exposure.
#   - Empty values and placeholder values (xxxx, sk-ant-xxx, github_pat_xxx)
#     are refused: a secret cannot be read back to notice a bad write.
#
# Removing a key from a file does NOT delete it on GitHub — pass --prune, which
# deletes every variable/secret in a synced scope that no layer defines (after a
# confirmation listing them). Environments that no file names are left alone.
#
# Usage:
#   bin/gh-bootstrap.sh [options]                  # repo in the current directory
#   bin/gh-bootstrap.sh -C ../tracebim-api         # one repo
#   bin/gh-bootstrap.sh --all                      # every repo in config/repos.env
#   npm run gh:bootstrap -- [options]              # from inside a repo
#
# Options:
#   -C, --repo-dir DIR      Repo checkout to sync (default: current directory)
#   -a, --all               Sync every repo listed in config/repos.env
#   -R, --repo OWNER/REPO   Target slug (default: from DIR's git remote)
#       --prune             Also delete config on GitHub that no layer defines
#   -n, --dry-run           Show the merged plan; change nothing
#   -y, --yes               Skip the confirmation prompts
#   -h, --help              Show this help
#
# Requirements: gh (GitHub CLI), authenticated with admin on the target repo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CI_ROOT="$(dirname "$SCRIPT_DIR")"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

SHARED_DIR="$CI_ROOT/config"
REPOS_FILE="$SHARED_DIR/repos.env"
PLACEHOLDER_RE='(xxxx|sk-ant-xxx|github_pat_xxx)'

# ---- args --------------------------------------------------------------------
REPO_DIR="."
REPO=""
ALL=false
PRUNE=false
DRY_RUN=false
ASSUME_YES=false
PASSTHROUGH=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -C|--repo-dir) REPO_DIR="${2:-}"; shift 2 ;;
    -R|--repo)     REPO="${2:-}"; shift 2 ;;
    -a|--all)      ALL=true; shift ;;
    --prune)       PRUNE=true; PASSTHROUGH+=("$1"); shift ;;
    -n|--dry-run)  DRY_RUN=true; PASSTHROUGH+=("$1"); shift ;;
    -y|--yes)      ASSUME_YES=true; PASSTHROUGH+=("$1"); shift ;;
    -h|--help)     awk 'NR>1 && /^#/{ sub(/^# ?/, ""); print; next } NR>1{ exit }' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)             die "Unknown option: $1 (try --help)" ;;
  esac
done

# ---- --all: re-run once per repo ---------------------------------------------
if $ALL; then
  [[ -z "$REPO" ]] || die "--repo cannot be combined with --all."
  root="${TRACEBIM_REPOS_ROOT:-$(dirname "$CI_ROOT")}"
  failed=()
  for name in $(env_get "$REPOS_FILE" REPOS); do
    info ""
    info "${BOLD}━━ $name ━━${RESET}"
    if [[ ! -d "$root/$name" ]]; then
      warn "No checkout at $root/$name — skipped."; failed+=("$name"); continue
    fi
    "${BASH_SOURCE[0]}" --repo-dir "$root/$name" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"} || failed+=("$name")
  done
  info ""
  [[ ${#failed[@]} -eq 0 ]] || die "Not synced: ${failed[*]}"
  ok "${BOLD}All repos processed.${RESET}"
  exit 0
fi

# ---- preconditions & targets -------------------------------------------------
require_gh
$DRY_RUN || require_auth
[[ -d "$REPO_DIR/.git" || -f "$REPO_DIR/.git" ]] || die "$REPO_DIR is not a git checkout."
REPO_DIR="$(cd "$REPO_DIR" && pwd)"
REPO_GITHUB_DIR="$REPO_DIR/.github"
[[ -n "$REPO" ]] || REPO="$(detect_repo "$REPO_DIR")"
[[ -n "$REPO" ]] || die "Could not determine the repo for $REPO_DIR. Pass --repo OWNER/REPO."
OWNER="${REPO%%/*}"

CI_REPO="$(env_get "$REPOS_FILE" CI_REPO)"
if [[ -n "$CI_REPO" && "${CI_REPO%%/*}" != "$OWNER" ]]; then
  warn "$REPO is not owned by ${CI_REPO%%/*}: its workflows cannot call the private $CI_REPO."
fi

LOCAL_ONLY_KEYS="$(env_get "$REPO_GITHUB_DIR/bootstrap.conf" LOCAL_ONLY_KEYS)"
is_local_only() { [[ " $LOCAL_ONLY_KEYS " == *" $1 "* ]]; }

# Usable secrets source: the real file if present, else the committed example.
secrets_src() { if [[ -f "$1" ]]; then printf '%s' "$1"; elif [[ -f "$1.example" ]]; then printf '%s' "$1.example"; fi; }

# Seed a gitignored secrets file from its example on first run (real runs only).
seed_secret_file() {
  [[ -f "$1.example" && ! -f "$1" ]] || return 0
  cp "$1.example" "$1"
  if [[ "$(env_count "$1")" -gt 0 ]]; then
    warn "Created $1 from its example — fill in real values before syncing."
  fi
}

# Environment names from secrets.<env>.env (or its .example) in either layer.
environments() {
  local f base
  for f in "$SHARED_DIR"/secrets.*.env "$SHARED_DIR"/secrets.*.env.example \
           "$REPO_GITHUB_DIR"/secrets.*.env "$REPO_GITHUB_DIR"/secrets.*.env.example; do
    [[ -e "$f" ]] || continue
    base="$(basename "$f")"; base="${base%.example}"; base="${base#secrets.}"; base="${base%.env}"
    printf '%s\n' "$base"
  done | sort -u
}

# merge_layers STRIP_FILE_SUFFIX FILE... — the merged key set, one line per key:
#   NAME <tab> FILE <tab> RAW_KEY <tab> LAYER
# Later files win. LAYER is "shared", "repo", "repo (overrides shared)", or
# "repo (same as shared: redundant)" — a repo line that only repeats the shared
# value can be deleted from the repo's file.
# With STRIP_FILE_SUFFIX=1, FOO_FILE and FOO are the same key (secrets only).
merge_layers() {
  local strip="$1" f layer; shift
  for f in "$@"; do
    [[ -n "$f" && -f "$f" ]] || continue
    if [[ "$f" == "$SHARED_DIR"/* ]]; then layer=shared; else layer=repo; fi
    clean_env "$f" | awk -v file="$f" -v layer="$layer" -v strip="$strip" '
      { i = index($0, "="); raw = substr($0, 1, i - 1); value = substr($0, i + 1)
        name = raw; if (strip == 1) sub(/_FILE$/, "", name)
        print name "\t" file "\t" raw "\t" layer "\t" value }'
  done | awk -F'\t' '
    { if (!($1 in row)) order[++n] = $1
      else if (layer[$1] == "shared" && $4 == "repo")
        note[$1] = ($5 == value[$1] && $3 == raw[$1]) ? "repo (same as shared: redundant)" : "repo (overrides shared)"
      row[$1] = $1 "\t" $2 "\t" $3; layer[$1] = $4; value[$1] = $5; raw[$1] = $3 }
    END { for (i = 1; i <= n; i++) { k = order[i]
            print row[k] "\t" (k in note ? note[k] : layer[k]) } }'
}

# Drop LOCAL_ONLY_KEYS from a merged listing (secrets only).
without_local_only() {
  local name rest
  while IFS=$'\t' read -r name rest; do
    is_local_only "$name" || is_local_only "${name}_FILE" || printf '%s\t%s\n' "$name" "$rest"
  done
}

print_plan() { # print_plan TITLE  (merged listing on stdin)
  local title="$1" name file raw layer any=false
  while IFS=$'\t' read -r name file raw layer; do
    $any || { info "  ${BOLD}$title${RESET}"; any=true; }
    printf '    %-34s %s%s%s\n' "$name" "$DIM" "$layer" "$RESET"
  done
  return 0
}

# Read a merged entry's value: a _FILE key yields the referenced file's contents.
entry_value() { # entry_value FILE RAW_KEY
  local value path
  value="$(unquote "$(env_get "$1" "$2")")"
  if [[ "$2" == *_FILE ]]; then
    path="${value/#\~/$HOME}"
    [[ "$path" == /* ]] || path="$(dirname "$1")/$path"
    [[ -f "$path" ]] || die "$2 in $1 points to '$value', which does not exist."
    cat "$path"
  else
    printf '%s' "$value"
  fi
}

# Refuse empty and placeholder values before anything is pushed.
check_values() { # (merged secrets listing on stdin)
  local name file raw layer value
  while IFS=$'\t' read -r name file raw layer; do
    [[ "$raw" == *_FILE ]] && continue
    value="$(unquote "$(env_get "$file" "$raw")")"
    [[ -n "$value" ]] || die "$raw has an empty value in $file. Fill it in, or comment the line out."
    if printf '%s' "$value" | grep -qiE "$PLACEHOLDER_RE"; then
      die "$raw in $file is still a placeholder. Fill it in and re-run (or use --dry-run)."
    fi
  done
}

# ---- apply -------------------------------------------------------------------
set_vars() { # (merged vars listing on stdin)
  local tmp name file raw layer n=0
  tmp="$(mktemp)"
  while IFS=$'\t' read -r name file raw layer; do
    clean_env "$file" | grep -E "^$raw=" | head -1 >> "$tmp"; n=$((n + 1))
  done
  if [[ "$n" -gt 0 ]]; then
    step "Setting $n repo variable(s)"
    gh variable set --repo "$REPO" --env-file "$tmp" || { rm -f "$tmp"; die "gh variable set failed."; }
    ok "done"
  fi
  rm -f "$tmp"
}

set_secrets() { # set_secrets [ENV]  (merged secrets listing on stdin)
  local envname="${1:-}" name file raw layer names=() scope=(--repo "$REPO")
  [[ -z "$envname" ]] || scope+=(--env "$envname")
  while IFS=$'\t' read -r name file raw layer; do
    entry_value "$file" "$raw" | gh secret set "$name" "${scope[@]}"
    names+=("$name")
  done
  [[ ${#names[@]} -gt 0 ]] && ok "${envname:+environment '$envname' }secrets synced (values not shown): ${names[*]}"
  return 0
}

# prune KIND MERGED_NAMES [ENV] — delete KIND (variable|secret) entries in scope
# that are not in MERGED_NAMES (newline-separated).
prune() {
  local kind="$1" keep="$2" envname="${3:-}" scope=(--repo "$REPO") existing stale name
  [[ -z "$envname" ]] || scope+=(--env "$envname")
  existing="$(gh "$kind" list "${scope[@]}" --json name --jq '.[].name' 2>/dev/null || true)"
  stale="$(comm -23 <(printf '%s\n' "$existing" | grep . | sort -u) <(printf '%s\n' "$keep" | grep . | sort -u) || true)"
  [[ -n "$stale" ]] || return 0
  step "Stale ${kind}s on ${envname:+environment '$envname' of }$REPO (no layer defines them):"
  printf '    - %s\n' $stale
  $DRY_RUN && return 0
  if ! $ASSUME_YES; then
    confirm "Delete these?" || { warn "Kept."; return 0; }
  fi
  while IFS= read -r name; do
    [[ -n "$name" ]] && gh "$kind" delete "$name" "${scope[@]}" && ok "deleted $kind $name"
  done <<< "$stale"
}

names_of() { cut -f1; }

# ---- plan --------------------------------------------------------------------
if ! $DRY_RUN; then
  seed_secret_file "$SHARED_DIR/secrets.env"
  seed_secret_file "$REPO_GITHUB_DIR/secrets.env"
fi

# ALL_VARS is the merged view, for the plan and the board check; VARS is the
# repo's own keys — the only variables pushed (see "Variables vs secrets").
ALL_VARS="$(merge_layers 0 "$SHARED_DIR/actions.env" "$REPO_GITHUB_DIR/actions.env")"
VARS="$(printf '%s\n' "$ALL_VARS" | awk -F'\t' '$4 != "shared"')"
RUNTIME_VARS="$(printf '%s\n' "$ALL_VARS" | awk -F'\t' '$4 == "shared" { printf "%s ", $1 }')"
SECRETS="$(merge_layers 1 "$(secrets_src "$SHARED_DIR/secrets.env")" \
  "$(secrets_src "$REPO_GITHUB_DIR/secrets.env")" | without_local_only)"
ENVS="$(environments)"

info ""
info "${BOLD}Bootstrap Actions config${RESET}   ${DIM}$REPO  ←  $REPO_DIR${RESET}"
info ""
printf '%s\n' "$VARS" | grep . | print_plan "repository variables" || true
[[ -z "$RUNTIME_VARS" ]] || info "  ${DIM}shared variables, read at run time (not pushed): ${RUNTIME_VARS% }${RESET}"
printf '%s\n' "$SECRETS" | grep . | print_plan "repository secrets" || true
for env in $ENVS; do
  merge_layers 1 "$(secrets_src "$SHARED_DIR/secrets.$env.env")" \
    "$(secrets_src "$REPO_GITHUB_DIR/secrets.$env.env")" | without_local_only \
    | print_plan "environment '$env' secrets"
done
[[ -z "$LOCAL_ONLY_KEYS" ]] || info "  ${DIM}local only, never pushed: $LOCAL_ONLY_KEYS${RESET}"
info ""

if $DRY_RUN; then
  if $PRUNE && gh auth status >/dev/null 2>&1; then
    prune variable "$(printf '%s\n' "$VARS" | names_of)"
    prune secret "$(printf '%s\n' "$SECRETS" | names_of)"
  fi
  ok "Dry run complete — nothing was changed."
  exit 0
fi

printf '%s\n' "$SECRETS" | grep . | check_values || true
for env in $ENVS; do
  merge_layers 1 "$(secrets_src "$SHARED_DIR/secrets.$env.env")" \
    "$(secrets_src "$REPO_GITHUB_DIR/secrets.$env.env")" | without_local_only | check_values
done

if ! $ASSUME_YES; then
  confirm "Push this config → $REPO?" || die "Aborted."
fi

# ---- execute -----------------------------------------------------------------
printf '%s\n' "$VARS" | grep . | set_vars || true
printf '%s\n' "$SECRETS" | grep . | set_secrets || true
if $PRUNE; then
  prune variable "$(printf '%s\n' "$VARS" | names_of)"
  prune secret "$(printf '%s\n' "$SECRETS" | names_of)"
fi

for env in $ENVS; do
  env_secrets="$(merge_layers 1 "$(secrets_src "$SHARED_DIR/secrets.$env.env")" \
    "$(secrets_src "$REPO_GITHUB_DIR/secrets.$env.env")" | without_local_only)"
  # Environments are per-repo; a job only sees these secrets when it declares
  # `environment: <name>`. Created idempotently before syncing.
  gh api -X PUT "repos/$REPO/environments/$env" >/dev/null
  printf '%s\n' "$env_secrets" | grep . | set_secrets "$env" || true
  if $PRUNE; then prune secret "$(printf '%s\n' "$env_secrets" | names_of)" "$env"; fi
done

# ---- verify project board (best effort) --------------------------------------
var_value() { # var_value NAME — merged variable value
  local line; line="$(printf '%s\n' "$ALL_VARS" | awk -F'\t' -v k="$1" '$1 == k' | head -1)"
  [[ -n "$line" ]] && env_get "$(cut -f2 <<< "$line")" "$1"
}
PROJECT_OWNER="$(var_value AUTO_PROJECT_OWNER || true)"
[[ -n "$PROJECT_OWNER" ]] || PROJECT_OWNER="$OWNER"
NUMBER="$(var_value AUTO_PROJECT_NUMBER || true)"
if [[ -n "$NUMBER" ]]; then
  step "Checking Projects (v2) board"
  if gh project view "$NUMBER" --owner "$PROJECT_OWNER" >/dev/null 2>&1; then
    ok "Board reachable: $(project_url "$PROJECT_OWNER" "$NUMBER")"
  else
    warn "Could not verify board — grant scope with: ${BOLD}gh auth refresh -s project${RESET}"
  fi
fi

info ""
ok "${BOLD}Bootstrap complete for $REPO.${RESET}"

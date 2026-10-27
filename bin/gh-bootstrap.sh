#!/usr/bin/env bash
#
# gh-bootstrap.sh — apply the shared rules to a GitHub repo: Actions variables
# and secrets, repository settings and branch rulesets, each merged from the
# SHARED layer (this package's config/) and the repo's OWN layer (.github/).
#
# Layers, lowest precedence first — for any key, the repo's value wins:
#
#   variables            config/actions.env                  (read at run time, never pushed)
#                        <repo>/.github/actions.env          (pushed)
#   repository secrets   <shared secrets dir>/secrets.env
#                        <repo>/.github/secrets.env
#   environment secrets  <shared secrets dir>/secrets.<environment>.env
#   (environment <name>) <repo>/.github/secrets.<environment>.env
#   repository settings  config/repo-settings.json           (deep-merged JSON)
#                        <repo>/.github/repo-settings.json
#   branch rulesets      config/rulesets/<file>.json         (deep-merged per file name)
#                        <repo>/.github/rulesets/<file>.json
#
# A repo can therefore override any shared key and add any key of its own, in
# any scope. Every environment named by a secrets file in either layer is
# created on the repo and synced. Secrets files are gitignored; each has a
# committed .example beside it.
#
# Shared secrets dir: $CI_SECRETS_DIR if set; else config/ when this is a git
# checkout of ebalzan/ci; else ${XDG_CONFIG_HOME:-~/.config}/ebalzan-ci (the
# place for them when the tools run from the npm package).
#
# Variables vs secrets. Shared VARIABLES are not copied onto repos: the actions
# read config/actions.env from the copy of ebalzan/ci the runner downloads for
# `uses: …@v2` (actions/auto-work-items/src/sharedVars.ts) and fill only what
# the repo leaves unset. So a shared variable changes by moving the major tag,
# and only the repo's own keys are pushed — --prune deletes old shared copies.
# Shared SECRETS cannot work that way (they are not committed), so they are
# merged in at sync time: after changing one, re-run with --all.
#
# Secret mechanics:
#   - A KEY ending in _FILE is a path: the secret is set from that file's
#     contents under the stripped name (multiline values cannot live in a
#     dotenv file). A relative path is relative to the env file's directory.
#     FOO_FILE in a repo overrides a shared FOO, and vice versa.
#   - LOCAL_ONLY_KEYS in the repo's .github/bootstrap.conf are never pushed:
#     they are read only by local tools, so keeping them on GitHub would only
#     widen exposure.
#   - Empty values and placeholder values (xxxx, sk-ant-xxx, github_pat_xxx)
#     are refused: a secret cannot be read back to notice a bad write.
#
# Settings and rulesets: keys starting with `$` (e.g. "$comment") are
# documentation and never sent. A ruleset is matched to the one on GitHub by
# its "name"; --prune deletes repo rulesets named "ci: …" that no file defines
# (rulesets you created by hand under another name are never touched).
# Rulesets on a PRIVATE repo need GitHub Pro (or Team); on the free plan the
# step warns and skips.
#
# Remote mode. With --repo and no local checkout of that repo, its committed
# files (.github/actions.env, bootstrap.conf, repo-settings.json, rulesets/)
# are read from its default branch through the API. Its own secrets files are
# gitignored and so unknown: only the shared secrets are synced, and secrets
# are never pruned.
#
# Removing a key from a file does NOT delete it on GitHub — pass --prune, which
# deletes every variable/secret in a synced scope that no layer defines (after a
# confirmation listing them). Environments that no file names are left alone.
#
# Usage:
#   ebalzan-ci bootstrap [options]                 # repo in the current directory
#   ebalzan-ci bootstrap -C ../my-repo             # a local checkout
#   ebalzan-ci bootstrap -R owner/repo             # no checkout needed (remote mode)
#   ebalzan-ci bootstrap --all                     # every repo in config/repos.env
#   bin/gh-bootstrap.sh [options]                  # same, from a checkout of ebalzan/ci
#
# Options:
#   -C, --repo-dir DIR      Repo checkout to sync (default: current directory)
#   -R, --repo OWNER/REPO   Target repo. Alone: remote mode, unless the current
#                           directory is a checkout of it. With -C: push DIR's
#                           config to this slug.
#   -a, --all               Sync every repo config/repos.env selects (topic + list)
#       --skip LIST         Comma-separated sections to leave alone:
#                           vars, secrets, settings, rulesets
#       --prune             Also delete config on GitHub that no layer defines
#   -n, --dry-run           Show the merged plan; change nothing
#   -y, --yes               Skip the confirmation prompts
#   -h, --help              Show this help
#
# Requirements: gh (GitHub CLI), authenticated with admin on the target repo;
# node (settings and rulesets).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CI_ROOT="$(dirname "$SCRIPT_DIR")"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

SHARED_DIR="$CI_ROOT/config"
REPOS_FILE="$SHARED_DIR/repos.env"
JSON="$SCRIPT_DIR/_json.mjs"
PLACEHOLDER_RE='(xxxx|sk-ant-xxx|github_pat_xxx)'
# Rulesets whose name starts with this are managed here, and --prune may delete them.
MANAGED_RULESET_PREFIX='ci: '

if [[ -n "${CI_SECRETS_DIR:-}" ]]; then
  SHARED_SECRETS_DIR="$CI_SECRETS_DIR"
elif [[ -d "$CI_ROOT/.git" || -f "$CI_ROOT/.git" ]]; then
  SHARED_SECRETS_DIR="$SHARED_DIR"
else
  SHARED_SECRETS_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/ebalzan-ci"
fi

# ---- args --------------------------------------------------------------------
REPO_DIR="."
REPO_DIR_SET=false
REPO=""
ALL=false
PRUNE=false
DRY_RUN=false
ASSUME_YES=false
SKIP=""
PASSTHROUGH=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -C|--repo-dir) REPO_DIR="${2:-}"; REPO_DIR_SET=true; shift 2 ;;
    -R|--repo)     REPO="${2:-}"; shift 2 ;;
    -a|--all)      ALL=true; shift ;;
    --skip)        SKIP="${2:-}"; PASSTHROUGH+=("$1" "${2:-}"); shift 2 ;;
    --prune)       PRUNE=true; PASSTHROUGH+=("$1"); shift ;;
    -n|--dry-run)  DRY_RUN=true; PASSTHROUGH+=("$1"); shift ;;
    -y|--yes)      ASSUME_YES=true; PASSTHROUGH+=("$1"); shift ;;
    -h|--help)     print_help "${BASH_SOURCE[0]}"; exit 0 ;;
    *)             die "Unknown option: $1 (try --help)" ;;
  esac
done

for section in ${SKIP//,/ }; do
  case "$section" in
    vars|secrets|settings|rulesets) ;;
    *) die "--skip: unknown section '$section' (vars, secrets, settings, rulesets)." ;;
  esac
done
enabled() { [[ ",$SKIP," != *",$1,"* ]]; }

# ---- --all: re-run once per repo ---------------------------------------------
if $ALL; then
  [[ -z "$REPO" ]] || die "--repo cannot be combined with --all."
  ! $REPO_DIR_SET || die "--repo-dir cannot be combined with --all."
  require_gh
  require_auth
  slugs="$(managed_repos "$REPOS_FILE" "$CI_ROOT")"
  [[ -n "$slugs" ]] || die "No repos selected: tag repos with REPOS_TOPIC or list them in REPOS ($REPOS_FILE)."
  failed=()
  for slug in $slugs; do
    info ""
    info "${BOLD}━━ $slug ━━${RESET}"
    dir="$(local_checkout "$slug" "$CI_ROOT")"
    if [[ -n "$dir" ]]; then
      "${BASH_SOURCE[0]}" --repo-dir "$dir" --repo "$slug" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"} || failed+=("$slug")
    else
      "${BASH_SOURCE[0]}" --repo "$slug" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"} || failed+=("$slug")
    fi
  done
  info ""
  [[ ${#failed[@]} -eq 0 ]] || die "Not synced: ${failed[*]}"
  ok "${BOLD}All repos processed.${RESET}"
  exit 0
fi

# ---- preconditions & targets -------------------------------------------------
require_gh
$DRY_RUN || require_auth

# Remote mode: --repo alone, and the current directory is not that repo.
REMOTE=false
if [[ -n "$REPO" ]] && ! $REPO_DIR_SET; then
  here="$(detect_repo . 2>/dev/null || true)"
  if [[ "$(printf '%s' "$here" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]')" ]]; then
    REMOTE=true
  fi
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# fetch_remote_config SLUG DEST — copy the repo's committed .github config
# from its default branch into DEST/.github. Secrets files are gitignored and
# their .example files are deliberately skipped: an example must never stand in
# for real values.
fetch_remote_config() {
  local slug="$1" dest="$2/.github" name
  mkdir -p "$dest/rulesets"
  gh api "repos/$slug" >/dev/null 2>&1 || die "Cannot read $slug (does it exist, and can gh see it?)."
  for name in actions.env bootstrap.conf repo-settings.json; do
    gh api -H 'Accept: application/vnd.github.raw' "repos/$slug/contents/.github/$name" \
      > "$dest/$name" 2>/dev/null || rm -f "$dest/$name"
  done
  for name in $(gh api "repos/$slug/contents/.github/rulesets" -q '.[] | select(.type == "file") | .name' 2>/dev/null || true); do
    [[ "$name" == *.json ]] || continue
    gh api -H 'Accept: application/vnd.github.raw' "repos/$slug/contents/.github/rulesets/$name" \
      > "$dest/rulesets/$name"
  done
}

if $REMOTE; then
  fetch_remote_config "$REPO" "$WORK_DIR/remote"
  REPO_DIR="$WORK_DIR/remote"
  SOURCE_LABEL="$REPO@default-branch (remote: no local checkout)"
else
  [[ -d "$REPO_DIR/.git" || -f "$REPO_DIR/.git" ]] || die "$REPO_DIR is not a git checkout. Pass -R OWNER/REPO to work without one."
  REPO_DIR="$(cd "$REPO_DIR" && pwd)"
  [[ -n "$REPO" ]] || REPO="$(detect_repo "$REPO_DIR")"
  [[ -n "$REPO" ]] || die "Could not determine the repo for $REPO_DIR. Pass --repo OWNER/REPO."
  SOURCE_LABEL="$REPO_DIR"
fi
REPO_GITHUB_DIR="$REPO_DIR/.github"
OWNER="${REPO%%/*}"

# A private CI repo can only be called by repos of the same account.
CI_REPO="$(unquote "$(env_get "$REPOS_FILE" CI_REPO)")"
if ! $DRY_RUN && [[ -n "$CI_REPO" && "${CI_REPO%%/*}" != "$OWNER" ]]; then
  if [[ "$(gh repo view "$CI_REPO" --json visibility -q .visibility 2>/dev/null || true)" == "PRIVATE" ]]; then
    warn "$CI_REPO is private and $REPO is owned by someone else: its workflows cannot call $CI_REPO."
  fi
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
  for f in "$SHARED_SECRETS_DIR"/secrets.*.env "$SHARED_SECRETS_DIR"/secrets.*.env.example \
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
    if [[ "$f" == "$REPO_GITHUB_DIR"/* ]]; then layer=repo; else layer=shared; fi
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

# ---- settings & rulesets: desired state --------------------------------------
# merged_settings — the merged repo-settings JSON on stdout, or nothing.
merged_settings() {
  [[ -f "$SHARED_DIR/repo-settings.json" || -f "$REPO_GITHUB_DIR/repo-settings.json" ]] || return 0
  node "$JSON" merge "$SHARED_DIR/repo-settings.json" "$REPO_GITHUB_DIR/repo-settings.json"
}

# ruleset_files — the file names (x.json) defined by either layer.
ruleset_files() {
  local f
  for f in "$SHARED_DIR"/rulesets/*.json "$REPO_GITHUB_DIR"/rulesets/*.json; do
    [[ -f "$f" ]] && basename "$f"
  done | sort -u
}

# Write each merged ruleset to $WORK_DIR/rulesets/<file>; print "<file>\t<name>\t<enforcement>".
build_rulesets() {
  local file out name
  mkdir -p "$WORK_DIR/rulesets"
  for file in $(ruleset_files); do
    out="$WORK_DIR/rulesets/$file"
    node "$JSON" merge "$SHARED_DIR/rulesets/$file" "$REPO_GITHUB_DIR/rulesets/$file" > "$out"
    name="$(node "$JSON" get "$out" name)"
    [[ -n "$name" ]] || die "Ruleset $file has no \"name\"."
    printf '%s\t%s\t%s\n' "$file" "$name" "$(node "$JSON" get "$out" enforcement)"
  done
}

# ---- apply -------------------------------------------------------------------
set_vars() { # (merged vars listing on stdin)
  local tmp name file raw layer n=0
  tmp="$WORK_DIR/vars.env"
  : > "$tmp"
  while IFS=$'\t' read -r name file raw layer; do
    clean_env "$file" | grep -E "^$raw=" | head -1 >> "$tmp"; n=$((n + 1))
  done
  if [[ "$n" -gt 0 ]]; then
    step "Setting $n repo variable(s)"
    gh variable set --repo "$REPO" --env-file "$tmp" || die "gh variable set failed."
    ok "done"
  fi
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

# apply_settings FILE — PATCH the repo; on a dry run show what would change.
apply_settings() {
  local desired="$1" current="$WORK_DIR/current-settings.json" diff key now want
  if gh api "repos/$REPO" > "$current" 2>/dev/null; then
    diff="$(node "$JSON" diff "$desired" "$current")"
    if [[ -z "$diff" ]]; then ok "repository settings already match"; return 0; fi
    step "Repository settings to change"
    while IFS=$'\t' read -r key now want; do
      printf '    %-30s %s → %s\n' "$key" "$now" "$want"
    done <<< "$diff"
  else
    step "Repository settings (current values unknown)"
    sed 's/^/    /' "$desired"
  fi
  $DRY_RUN && return 0
  gh api -X PATCH "repos/$REPO" --input "$desired" >/dev/null || die "Updating repository settings failed."
  ok "repository settings updated"
}

# rulesets_unavailable OUTPUT — the API's answer when rulesets need a paid plan.
rulesets_unavailable() { grep -qiE 'upgrade to github pro|make this repository public' <<< "$1"; }

# apply_rulesets PLAN — create or update each merged ruleset by name.
apply_rulesets() {
  local plan="$1" existing out file name enforcement id
  if ! existing="$(gh api "repos/$REPO/rulesets?includes_parents=false" \
      -q '.[] | select(.source_type == "Repository") | [.id, .name] | @tsv' 2>&1)"; then
    if rulesets_unavailable "$existing"; then
      warn "Rulesets are not available for $REPO (a private repo needs GitHub Pro or Team) — skipped."
      return 0
    elif $DRY_RUN; then
      warn "Could not list rulesets on $REPO; showing every ruleset as new."
      existing=""
    else
      die "Could not list rulesets on $REPO: $existing"
    fi
  fi
  while IFS=$'\t' read -r file name enforcement; do
    [[ -n "$file" ]] || continue
    id="$(awk -F'\t' -v n="$name" '$2 == n { print $1; exit }' <<< "$existing")"
    if $DRY_RUN; then
      info "    $([[ -n "$id" ]] && echo update || echo create) $(printf '%-28s' "'$name'") ${DIM}$enforcement · $file${RESET}"
      continue
    fi
    if [[ -n "$id" ]]; then
      out="$(gh api -X PUT "repos/$REPO/rulesets/$id" --input "$WORK_DIR/rulesets/$file" 2>&1)" \
        || { rulesets_unavailable "$out" && { warn "Rulesets are not available for $REPO — skipped."; return 0; }; die "Updating ruleset '$name' failed: $out"; }
      ok "ruleset '$name' updated ($enforcement)"
    else
      out="$(gh api -X POST "repos/$REPO/rulesets" --input "$WORK_DIR/rulesets/$file" 2>&1)" \
        || { rulesets_unavailable "$out" && { warn "Rulesets are not available for $REPO (a private repo needs GitHub Pro or Team) — skipped."; return 0; }; die "Creating ruleset '$name' failed: $out"; }
      ok "ruleset '$name' created ($enforcement)"
    fi
  done <<< "$plan"

  $PRUNE || return 0
  local stale
  stale="$(awk -F'\t' -v p="$MANAGED_RULESET_PREFIX" 'index($2, p) == 1' <<< "$existing" \
    | while IFS=$'\t' read -r id name; do
        cut -f2 <<< "$plan" | grep -qxF "$name" || printf '%s\t%s\n' "$id" "$name"
      done)"
  [[ -n "$stale" ]] || return 0
  step "Stale rulesets on $REPO (named '${MANAGED_RULESET_PREFIX}…', no file defines them):"
  cut -f2 <<< "$stale" | sed 's/^/    - /'
  $DRY_RUN && return 0
  if ! $ASSUME_YES; then
    confirm "Delete these?" || { warn "Kept."; return 0; }
  fi
  while IFS=$'\t' read -r id name; do
    gh api -X DELETE "repos/$REPO/rulesets/$id" >/dev/null && ok "deleted ruleset '$name'"
  done <<< "$stale"
}

# ---- plan --------------------------------------------------------------------
if ! $DRY_RUN && enabled secrets; then
  seed_secret_file "$SHARED_SECRETS_DIR/secrets.env"
  $REMOTE || seed_secret_file "$REPO_GITHUB_DIR/secrets.env"
fi

# ALL_VARS is the merged view, for the plan and the board check; VARS is the
# repo's own keys — the only variables pushed (see "Variables vs secrets").
ALL_VARS="$(merge_layers 0 "$SHARED_DIR/actions.env" "$REPO_GITHUB_DIR/actions.env")"
VARS="$(printf '%s\n' "$ALL_VARS" | awk -F'\t' '$4 != "shared"')"
RUNTIME_VARS="$(printf '%s\n' "$ALL_VARS" | awk -F'\t' '$4 == "shared" { printf "%s ", $1 }')"
SECRETS="$(merge_layers 1 "$(secrets_src "$SHARED_SECRETS_DIR/secrets.env")" \
  "$(secrets_src "$REPO_GITHUB_DIR/secrets.env")" | without_local_only)"
ENVS="$(environments)"
SETTINGS_FILE=""
if enabled settings; then
  SETTINGS_FILE="$WORK_DIR/settings.json"
  merged_settings > "$SETTINGS_FILE"
  [[ -s "$SETTINGS_FILE" ]] || SETTINGS_FILE=""
fi
RULESETS=""
enabled rulesets && RULESETS="$(build_rulesets)"

info ""
info "${BOLD}Bootstrap${RESET}   ${DIM}$REPO  ←  $SOURCE_LABEL${RESET}"
info "${DIM}shared config: $SHARED_DIR · shared secrets: $SHARED_SECRETS_DIR${SKIP:+ · skipping: $SKIP}${RESET}"
info ""
if enabled vars; then
  printf '%s\n' "$VARS" | grep . | print_plan "repository variables" || true
  [[ -z "$RUNTIME_VARS" ]] || info "  ${DIM}shared variables, read at run time (not pushed): ${RUNTIME_VARS% }${RESET}"
fi
if enabled secrets; then
  printf '%s\n' "$SECRETS" | grep . | print_plan "repository secrets" || true
  for env in $ENVS; do
    merge_layers 1 "$(secrets_src "$SHARED_SECRETS_DIR/secrets.$env.env")" \
      "$(secrets_src "$REPO_GITHUB_DIR/secrets.$env.env")" | without_local_only \
      | print_plan "environment '$env' secrets"
  done
  [[ -z "$LOCAL_ONLY_KEYS" ]] || info "  ${DIM}local only, never pushed: $LOCAL_ONLY_KEYS${RESET}"
  ! $REMOTE || info "  ${DIM}remote mode: the repo's own secrets files are unknown; shared secrets only, never pruned${RESET}"
fi
if [[ -n "$SETTINGS_FILE" ]]; then
  info "  ${BOLD}repository settings${RESET}"
  info "    $(node -e 'const s=require(process.argv[1]);console.log(Object.entries(s).map(([k,v])=>`${k}=${v}`).join(" "))' "$SETTINGS_FILE")"
fi
if [[ -n "$RULESETS" ]]; then
  info "  ${BOLD}rulesets${RESET}"
  while IFS=$'\t' read -r file name enforcement; do
    printf '    %-34s %s%s · %s%s\n' "$name" "$DIM" "$enforcement" "$file" "$RESET"
  done <<< "$RULESETS"
fi
info ""

if $DRY_RUN; then
  if gh auth status >/dev/null 2>&1; then
    if $PRUNE && enabled vars; then prune variable "$(printf '%s\n' "$VARS" | names_of)"; fi
    if $PRUNE && enabled secrets && ! $REMOTE; then prune secret "$(printf '%s\n' "$SECRETS" | names_of)"; fi
    [[ -z "$SETTINGS_FILE" ]] || apply_settings "$SETTINGS_FILE"
    if [[ -n "$RULESETS" ]]; then step "Rulesets"; apply_rulesets "$RULESETS"; fi
  fi
  ok "Dry run complete — nothing was changed."
  exit 0
fi

if enabled secrets; then
  printf '%s\n' "$SECRETS" | grep . | check_values || true
  for env in $ENVS; do
    merge_layers 1 "$(secrets_src "$SHARED_SECRETS_DIR/secrets.$env.env")" \
      "$(secrets_src "$REPO_GITHUB_DIR/secrets.$env.env")" | without_local_only | check_values
  done
fi

if ! $ASSUME_YES; then
  confirm "Push this config → $REPO?" || die "Aborted."
fi

# ---- execute -----------------------------------------------------------------
if enabled vars; then
  printf '%s\n' "$VARS" | grep . | set_vars || true
  if $PRUNE; then prune variable "$(printf '%s\n' "$VARS" | names_of)"; fi
fi

if enabled secrets; then
  printf '%s\n' "$SECRETS" | grep . | set_secrets || true
  if $PRUNE; then
    if $REMOTE; then
      warn "Remote mode: secrets are not pruned (the repo's own secrets files are unknown)."
    else
      prune secret "$(printf '%s\n' "$SECRETS" | names_of)"
    fi
  fi

  for env in $ENVS; do
    env_secrets="$(merge_layers 1 "$(secrets_src "$SHARED_SECRETS_DIR/secrets.$env.env")" \
      "$(secrets_src "$REPO_GITHUB_DIR/secrets.$env.env")" | without_local_only)"
    # Environments are per-repo; a job only sees these secrets when it declares
    # `environment: <name>`. Created idempotently before syncing.
    gh api -X PUT "repos/$REPO/environments/$env" >/dev/null
    printf '%s\n' "$env_secrets" | grep . | set_secrets "$env" || true
    if $PRUNE && ! $REMOTE; then prune secret "$(printf '%s\n' "$env_secrets" | names_of)" "$env"; fi
  done
fi

[[ -z "$SETTINGS_FILE" ]] || apply_settings "$SETTINGS_FILE"
if [[ -n "$RULESETS" ]]; then step "Rulesets"; apply_rulesets "$RULESETS"; fi

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

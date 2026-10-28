# CLI reference

```text
npx @ebalzan/ci <command> [options]
```

Install it as a devDependency (`npm install --save-dev @ebalzan/ci`) and the
binary is `ebalzan-ci` in npm scripts and husky hooks. Without installing,
prefix with `npx @ebalzan/ci`. From a git checkout of this repo, `node
bin/cli.mjs <command>` and the scripts in `bin/` work the same way.

The commands that change GitHub (`onboard`, `bootstrap`, `reset`) are bash
scripts and need [`gh`](https://cli.github.com) logged in as an **admin** of
the target repo. Each one prints a plan and asks before changing anything, and
each has `--dry-run`.

| Command                         | Summary                                                   |
| ------------------------------- | --------------------------------------------------------- |
| [`onboard`](#onboard)           | Bring a repo under the shared rules in one step           |
| [`bootstrap`](#bootstrap)       | Sync variables, secrets, settings and rulesets onto repos |
| [`reset`](#reset)               | Delete Actions variables/secrets on a repo                |
| [`commit-msg`](#commit-msg)     | Validate a commit message (husky hook)                    |
| [`path`](#path)                 | Print the package directory                               |
| [`sync-managed`](#sync-managed) | Deprecated: refresh local copies of managed files         |
| `version`, `help`               | Print the version / the command list                      |

---

## onboard

Adds everything a repo needs, on a branch, and opens it for review.

```bash
ebalzan-ci onboard [-C DIR] [options]
```

| Option                  | Default                   | Effect                                                                                                                                                  |
| ----------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-C, --repo-dir DIR`    | `.`                       | Checkout of the repo to onboard                                                                                                                         |
| `-R, --repo OWNER/REPO` | from the git remote       | Its slug                                                                                                                                                |
| `--runs-on LABEL`       | `ubuntu-latest`           | Runner label written into every caller (e.g. `self-hosted`)                                                                                             |
| `--ref REF`             | `v<major of the package>` | Ref the callers pin. Keep the major tag (`v2`); an exact version only freezes the workflow files ([why](ARCHITECTURE.md#9-versions-what-a-pin-freezes)) |
| `--branch NAME`         | `ci/onboard-ebalzan-ci`   | Branch the files are committed on                                                                                                                       |
| `--force`               | off                       | Replace files that already exist (default: keep them)                                                                                                   |
| `--no-npm`              | off                       | Do not install packages, even with a `package.json` (files and `package.json` fields are still written)                                                 |
| `--no-config`           | off                       | Do not wire `@ebalzan/config` (Prettier, ESLint)                                                                                                        |
| `--no-push`             | off                       | Stop after the local commit: GitHub is not touched at all                                                                                               |
| `-n, --dry-run`         | off                       | Print the plan; change nothing                                                                                                                          |
| `-y, --yes`             | off                       | No confirmation prompts (also for the bootstrap it runs)                                                                                                |

What it does, in order:

1. Checks the tree is clean and the branch does not exist yet.
2. Branches from `origin/dev`, or from the default branch when `dev` does not
   exist yet.
3. Writes the [templates](../templates/) with `__CI_REPO__`, `__CI_REF__` and
   `__RUNS_ON__` filled in. Existing files are kept unless `--force`. The husky
   hook and `eslint.config.mjs` are only written for a repo with `package.json`
   (and `eslint.config.mjs` only when it has no ESLint config of its own);
   `renovate.json` is skipped when the repo has its own Renovate config.
4. Appends the `.github/secrets*.env` ignore lines to `.gitignore`, unless those
   files are already ignored.
5. Node repos, code style (unless `--no-config`): sets `package.json`
   `"prettier": "@ebalzan/config/prettier"` when the repo has no Prettier config
   of its own. A `tsconfig.json` that does not extend
   `@ebalzan/config/tsconfig/*` is reported, never edited.
6. Node repos, installs (unless `--no-npm`): `@ebalzan/ci@^<major>` and husky (if
   missing), `scripts.prepare = "husky"` when there is no prepare script, and
   `@ebalzan/config` with its peers `eslint` and `prettier` (if missing), at
   exact versions. A failure here only warns.
7. Commits as `ci: onboard ebalzan/ci shared workflows and rules`.
8. Unless `--no-push`, after one confirmation: creates `dev` on GitHub from the
   default branch if missing, adds the `REPOS_TOPIC` topic, runs
   [`bootstrap`](#bootstrap), pushes the branch. The `auto-pr.yml` just added
   runs on that push and opens the issue and the PR into `dev`.

Walkthrough: [ONBOARDING.md](ONBOARDING.md).

---

## bootstrap

Applies the merged shared + repo config to GitHub. Idempotent: run it as often
as you like.

```bash
ebalzan-ci bootstrap                      # the repo in the current directory
ebalzan-ci bootstrap -C ../my-repo        # a local checkout
ebalzan-ci bootstrap -R owner/my-repo     # no checkout: remote mode
ebalzan-ci bootstrap --all --dry-run      # every managed repo, plan only
```

| Option                  | Effect                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `-C, --repo-dir DIR`    | Checkout whose `.github/` holds the repo layer (default: `.`)                                                                |
| `-R, --repo OWNER/REPO` | Target repo. Alone: remote mode, unless the current directory is a checkout of it. With `-C`: push DIR's config to that slug |
| `-a, --all`             | Every repo `config/repos.env` selects (topic + list), each from its local checkout when there is one                         |
| `--skip LIST`           | Comma-separated sections to leave alone: `vars`, `secrets`, `settings`, `rulesets`                                           |
| `--prune`               | Also delete what no file defines: variables, secrets, and rulesets named `ci: …` (asks first)                                |
| `-n, --dry-run`         | Print the merged plan and, when gh is logged in, the settings diff and ruleset actions; change nothing                       |
| `-y, --yes`             | No confirmation prompts                                                                                                      |

Sections, in the order they are applied:

| Section    | From                                                                                                        | To GitHub                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `vars`     | the repo's `.github/actions.env` only (shared ones are read at run time)                                    | repository variables                                      |
| `secrets`  | shared `secrets.env` + the repo's `secrets.env`, and `secrets.<env>.env` (from the repo secrets dir, below) | repository secrets; environment `<env>` (created) secrets |
| `settings` | `config/repo-settings.json` deep-merged with `.github/repo-settings.json`                                   | `PATCH /repos/{repo}` (only changed keys are listed)      |
| `rulesets` | each `config/rulesets/X.json` deep-merged with `.github/rulesets/X.json`                                    | created, or updated by `name`                             |

**Where the shared secrets come from:** `$CI_SECRETS_DIR` if set; otherwise
`config/` when running from a git checkout of this repo; otherwise
`~/.config/ebalzan-ci/` (or `$XDG_CONFIG_HOME/ebalzan-ci/`). A missing file is
simply no shared secrets.

**Where a repo's own secrets come from:** `repos/<owner>/<repo>/` inside the
shared secrets dir when that folder exists (matched case-insensitively; the
checkout's `secrets*.env` are then ignored, with a warning); otherwise the
checkout's gitignored `.github/`. Keeping them in the shared secrets dir is
recommended: one folder for every repo, usable without checkouts
([ARCHITECTURE §7](ARCHITECTURE.md#7-where-you-run-commands)).

**Remote mode** (`-R` without a checkout) reads the repo's committed
`.github/actions.env`, `bootstrap.conf`, `repo-settings.json` and `rulesets/`
from its default branch, and its secrets from `repos/<owner>/<repo>/`. Without
that folder its secrets are unknown: only shared secrets are synced, and
secrets are never pruned.

**Guards:** empty and placeholder secret values (`xxxx`, `sk-ant-xxx`,
`github_pat_xxx`) are refused before anything is sent; a `_FILE` key sets the
secret from a file's contents; `LOCAL_ONLY_KEYS` in `.github/bootstrap.conf`
are never pushed. Details: [GITHUB_ACTIONS_SETUP.md §4](GITHUB_ACTIONS_SETUP.md#4-file-mechanics).

**Rulesets on a private repo** need GitHub Pro/Team. On the free plan GitHub
answers "Upgrade to GitHub Pro or make this repository public", and the step
warns and moves on.

---

## reset

Deletes Actions variables (default) and/or secrets on one repo, after showing
them and asking you to type the repo name. Prefer `bootstrap --prune` to remove
only what no file defines any more.

```bash
ebalzan-ci reset --dry-run                              # what would go
ebalzan-ci reset -R owner/repo --include-secrets
ebalzan-ci reset --match '^AUTO_'
ebalzan-ci reset --env production --secrets-only --dry-run
```

| Option                  | Effect                                              |
| ----------------------- | --------------------------------------------------- |
| `-C, --repo-dir DIR`    | Checkout whose remote picks the repo (default: `.`) |
| `-R, --repo OWNER/REPO` | Target repo                                         |
| `-e, --env NAME`        | Act on environment `NAME` instead of the repository |
| `--include-secrets`     | Also delete secrets                                 |
| `--secrets-only`        | Delete secrets only                                 |
| `-m, --match REGEX`     | Only names matching this extended regex             |
| `-n, --dry-run`         | List; delete nothing                                |
| `-y, --yes`             | Skip the typed confirmation (dangerous)             |

It never touches settings or rulesets.

---

## commit-msg

```bash
ebalzan-ci commit-msg <message-file | subject>
```

Exits 0 when the first non-comment line is a Conventional Commit subject with
one of the [allowed types](COMMIT_GUIDE.md#allowed-types), 1 (with an example)
otherwise. Subjects git writes itself (`Merge …`, `Revert "…"`, `fixup! …`,
`squash! …`, `amend! …`) pass. The rule is
`managed/scripts/release/validate-conventional-subject.sh` — the same file the
PR-title check runs in CI.

The hook `onboard` writes (`.husky/commit-msg`):

```sh
if [ -x node_modules/.bin/ebalzan-ci ]; then
  exec node_modules/.bin/ebalzan-ci commit-msg "$1"
fi
# …falls back to a checkout of ebalzan/ci at ${CI_DIR:-../ci}, else warns and
# lets the commit through (CI still checks the PR title).
```

---

## path

Prints the installed package directory, for scripts that want the shared shell
helpers or config:

```bash
source "$(npx --no-install ebalzan-ci path)/bin/_lib.sh"   # info/ok/warn/die, env_get, detect_repo, …
```

---

## sync-managed

**Deprecated.** Before 2.0, repos could keep a verbatim copy of the validator
at `scripts/release/validate-conventional-subject.sh`; the PR-title check fails
when such a copy drifts. This refreshes those copies (`--install` creates them,
`--check` only reports). Prefer deleting the copy and using the hook above.

---

## Environment variables

| Variable                    | Used by                                 | Meaning                                                                                                        |
| --------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `CI_SECRETS_DIR`            | `bootstrap`                             | Directory with the shared `secrets.env` / `secrets.<env>.env`, and `repos/<owner>/<repo>/` for each repo's own |
| `CI_REPOS_ROOT`             | `bootstrap --all`, `sync-managed --all` | Where local checkouts live: `<root>/<repo name>` (default: next to this package's checkout)                    |
| `CI_DIR`                    | the husky hook                          | A checkout of this repo, used when the package is not installed (default `../ci`)                              |
| `XDG_CONFIG_HOME`           | `bootstrap`                             | Base of the default shared secrets dir                                                                         |
| `NO_COLOR` / non-TTY output | all                                     | Plain output without colours                                                                                   |

The pre-2.0 name `TRACEBIM_REPOS_ROOT` is still honoured.

## Exit codes

`0` success (including a completed dry run) · `1` a check failed, invalid
input, or the user aborted · `127` bash/sh not found.

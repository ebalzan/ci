# ebalzan/ci

[![npm](https://img.shields.io/npm/v/@ebalzan/ci)](https://www.npmjs.com/package/@ebalzan/ci)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**One set of CI/CD rules for every GitHub repo you own.** Point a repo at this
one and it gets the same branch model, the same commit convention, the same
automatic semver releases, the same repository settings and the same branch
protection as every other repo — and when a rule changes here, it changes
everywhere.

It has three parts:

| Part                                         | What it is                                                                                                                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reusable workflows** (`.github/workflows`) | Called by two thin files in each repo: the auto PR (a PR per work branch, and the `dev → main` release PR) and the PR check.                                                                   |
| **CLI** (`npx @ebalzan/ci`)                  | `onboard` a repo in one command; `bootstrap` its Actions variables, secrets, settings and rulesets from shared + per-repo files (one repo or `--all`); validate commit messages in a git hook. |
| **Shared config** (`config/`)                | The house rules: shared Actions variables, repository settings, branch rulesets — each overridable per repo.                                                                                   |

```text
  feat/login ── push ──▶ work PR into dev             (auto-pr)
                          │  work PR checked           (pr-check)
                          ▼  squash-merge
                         dev ──▶ release PR into main (auto-pr)
                          │       "feat: release v1.4.0" + changelog
                          │  release PR checked        (pr-check)
                          ▼  squash-merge (by hand) = release approval
                         main
```

Tagging the release, the GitHub Release and deploys are not shared stages yet
([CI_FLOW](docs/CI_FLOW.md)).

---

## Contents

- [Quick start](#quick-start)
- [What every repo gets](#what-every-repo-gets)
- [Using the workflows by hand](#using-the-workflows-by-hand)
- [Commands](#commands)
- [Configuration in one minute](#configuration-in-one-minute)
- [Versions and updates](#versions-and-updates)
- [Requirements and limits](#requirements-and-limits)
- [Documentation](#documentation)
- [Contributing](#contributing) · [License](#license)

---

## Quick start

**Prerequisites:** [GitHub CLI](https://cli.github.com) logged in as an admin of
the repo (`gh auth login`, plus `gh auth refresh -s project` if you use project
boards), Node.js ≥ 20, git, and bash (Linux, macOS, WSL or Git Bash).

**1. Put the shared secrets in one place** (once per machine). Every repo gets
these as repository secrets:

```bash
mkdir -p ~/.config/ebalzan-ci
cat > ~/.config/ebalzan-ci/secrets.env <<'EOF'
# Writes the issue/PR descriptions. Optional: without it the body is a stub.
ANTHROPIC_API_KEY=sk-ant-...
# Classic PAT, scopes `repo` + `project`. Optional: lets the bots' PRs trigger
# PR Checks and write to Projects (v2) boards. Why classic: docs/GITHUB_ACTIONS_SETUP.md
GH_PROJECT_TOKEN=ghp_...
EOF
```

A repo's **own** secrets (deploy credentials, …) go in the same folder, under
`repos/<owner>/<repo>/` — e.g. `repos/me/my-api/secrets.production.env` for its
`production` environment. Then `bootstrap --all` works with no checkouts
([ARCHITECTURE §7](docs/ARCHITECTURE.md#7-where-you-run-commands)).

**2. Onboard a repo**, from its checkout:

```bash
cd my-repo
npx @ebalzan/ci onboard --dry-run   # see exactly what it will do
npx @ebalzan/ci onboard             # do it
```

That creates a `ci/onboard-ebalzan-ci` branch with the two workflow callers, a
starter `.github/actions.env`, `renovate.json`, the `.gitignore` lines for
secrets files and, for Node repos, the husky `commit-msg` hook and the
[`@ebalzan/config`](https://www.npmjs.com/package/@ebalzan/config) Prettier and
ESLint wiring; creates `dev` if missing; tags the repo `ebalzan-ci`; applies
the variables, secrets, settings and rulesets; and pushes. The new
`auto-pr.yml` opens the PR into `dev` on that very push.

**3. Merge it** (squash): the `dev → main` release PR appears, titled with the
repo's first version.

From then on, the flow is just:

```bash
git switch dev && git pull
git switch -c feat/search-filters
git commit -m "feat(search): add filters"      # the hook checks the format
git push -u origin feat/search-filters         # the PR into dev appears
```

Full walkthrough and the manual alternative: [docs/ONBOARDING.md](docs/ONBOARDING.md).

---

## What every repo gets

| Rule                 | What it means                                                                                                                                                                        | Details                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Branch model         | Work branches `<type>/<desc>` → `dev` (integration) → `main` (releases). Only the automated release PR merges into `main`.                                                           | [CI_FLOW](docs/CI_FLOW.md)                                                               |
| Commit convention    | Conventional Commits with the types `feat fix docs style refact perf test build ci chore revert`. Checked locally by the hook and on every PR title.                                 | [COMMIT_GUIDE](docs/COMMIT_GUIDE.md)                                                     |
| Branch ↔ title match | A `feat/` branch needs a `feat:` title (minor), any other type a patch-level title, unless it is marked breaking (`!`).                                                              | [CI_FLOW §3](docs/CI_FLOW.md#stage-2--pr-checks)                                         |
| Auto PRs             | Every pushed work branch gets a PR into `dev`, and every push to `dev` updates the release PR into `main`: labelled, assigned, optionally on a milestone and a board, AI-described.  | [CI_FLOW §3](docs/CI_FLOW.md#3-stage-by-stage)                                           |
| Release PR           | Its title is the next semver, from the commits since the last `vX.Y.Z` tag (`feat: release v1.4.0`); its description, the changelog. Merging it into `main` approves the release.    | [CI_FLOW §4](docs/CI_FLOW.md#4-version-bump-rules-commit-scan)                           |
| Repo settings        | Squash-merge only, squash commit titled from the PR title, branches deleted after merge.                                                                                             | [REPO_RULES](docs/REPO_RULES.md)                                                         |
| Branch rulesets      | `main` cannot be deleted or force-pushed; `dev` cannot be deleted; an opt-in rule requires PRs + the PR checks.                                                                      | [REPO_RULES](docs/REPO_RULES.md)                                                         |
| Code style (Node)    | Prettier, ESLint and TypeScript rules from [`@ebalzan/config`](https://www.npmjs.com/package/@ebalzan/config), extended — not copied — by each repo.                                 | [ARCHITECTURE §10](docs/ARCHITECTURE.md#10-the-two-packages-ebalzanci-and-ebalzanconfig) |
| Dev tooling versions | A Renovate preset keeps Prettier, ESLint, husky, lint-staged, TypeScript and both `@ebalzan` packages on the same versions everywhere — one grouped PR a week, nothing else touched. | [renovate/tooling.json](renovate/tooling.json)                                           |

Every rule can be overridden per repo, in that repo — see
[Configuration](#configuration-in-one-minute).

**What stays in each repo:** the two small caller files (`auto-pr.yml`
identical everywhere, `pr-checks.yml` with the repo's own jobs added), its
build/test jobs, its deploy, and its own variables and secrets. Which file is which, what runs
where, and how to structure a deploy: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Using the workflows by hand

`onboard` writes these for you ([templates/](templates/)), but nothing more is
needed than two small files. Each holds only what a reusable workflow cannot:
the trigger, the permissions and the secrets.

```yaml
# .github/workflows/auto-pr.yml — work PRs, and the release PR on pushes to dev
name: Auto PR
on:
  push:
    branches-ignore: [main]
    tags-ignore: ['**']
  workflow_dispatch: {}
permissions:
  contents: read
  pull-requests: write
jobs:
  auto-pr:
    uses: ebalzan/ci/.github/workflows/auto-pr.yml@v4
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      GH_PROJECT_TOKEN: ${{ secrets.GH_PROJECT_TOKEN }}
```

| Reusable workflow | Inputs (all optional)                                                         | Secrets                                 | Caller must grant                        |
| ----------------- | ----------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------- |
| `auto-pr.yml`     | `runs-on` (`ubuntu-latest`), `base-branch` (`dev`), `release-branch` (`main`) | `ANTHROPIC_API_KEY`, `GH_PROJECT_TOKEN` | `contents: read`, `pull-requests: write` |
| `pr-check.yml`    | `runs-on`, `base-branch` (`dev`), `release-branch` (`main`)                   | `GH_PROJECT_TOKEN`                      | `contents: read`, `pull-requests: write` |

Secrets are passed by name: `secrets: inherit` is only guaranteed within one
organization. Variables need no passing — inside a reusable workflow, `vars` are
the **caller's**. Call `pr-check.yml` from a job named `pr-check` so the checks
are reported as `pr-check / Work PR` and `pr-check / Release PR`, the names the
rulesets require.

---

## Commands

```text
npx @ebalzan/ci <command> [options]      # or `ebalzan-ci` once installed
```

| Command      | Does                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| `onboard`    | Adds the templates on a branch, creates `dev`, tags the repo, bootstraps it, pushes.                  |
| `bootstrap`  | Syncs variables, secrets, settings and rulesets onto one repo (`-C dir`, `-R owner/repo`) or `--all`. |
| `reset`      | Deletes Actions variables/secrets on a repo after a typed confirmation.                               |
| `commit-msg` | Validates a commit message; the husky hook calls it.                                                  |
| `path`       | Prints the package directory.                                                                         |

Every command has `--help`, and `bootstrap`, `reset` and `onboard` have
`--dry-run`. Full reference: [docs/CLI.md](docs/CLI.md).

---

## Configuration in one minute

Everything is a file, merged in two layers — **the repo's value always wins**:

```text
                     shared (this package)              repo
Actions variables    config/actions.env              +  .github/actions.env
repository secrets   ~/.config/ebalzan-ci/secrets.env +  ~/.config/ebalzan-ci/repos/<owner>/<repo>/secrets.env
environment secrets  …/secrets.<env>.env              +  …/repos/<owner>/<repo>/secrets.<env>.env
                                                         (or the repo's gitignored .github/secrets*.env)
repo settings        config/repo-settings.json        +  .github/repo-settings.json   (deep merge)
branch rulesets      config/rulesets/<name>.json      +  .github/rulesets/<name>.json (deep merge)
```

`ebalzan-ci bootstrap` shows the merged plan (`--dry-run`), labelling each key
`shared`, `repo`, `repo (overrides shared)` or `repo (same as shared:
redundant)`, and applies it. Shared **variables** are never copied onto repos:
the actions read `config/actions.env` at run time from the version the caller
pins, so changing one is a release, not a sync.

`--all` acts on every repo tagged with the `ebalzan-ci` topic (which `onboard`
adds) plus any listed in `config/repos.env`.

- Every key, its default and who reads it: [docs/CONFIGURATION.md](docs/CONFIGURATION.md)
- Variables vs secrets, repository vs environment scope: [docs/GITHUB_ACTIONS_SETUP.md](docs/GITHUB_ACTIONS_SETUP.md)
- Settings and rulesets: [docs/REPO_RULES.md](docs/REPO_RULES.md)

---

## Versions and updates

This repo releases itself with its own pipeline, and the version means the
same thing in both places:

- **Callers pin a major tag**: `uses: ebalzan/ci/…@v2`. Every release moves
  `v2` to it, so fixes and new features reach every repo with no change on
  their side. Pinning `@v2.3.1` or a SHA freezes only the workflow file — the
  actions inside it still follow `v2` ([why](docs/ARCHITECTURE.md#9-versions-what-a-pin-freezes)).
- **The npm package** `@ebalzan/ci` has the same version as the tag.
- **Breaking changes** (a removed input, a new required permission or secret, a
  renamed variable) only ever ship as a new major (`v3`). `v2` stays where it is,
  and each repo moves when you are ready.

What changed in each release: [GitHub Releases](https://github.com/ebalzan/ci/releases).
Upgrading from the private `tracebim-ci` v1: [docs/MIGRATION.md](docs/MIGRATION.md).

---

## Requirements and limits

- **GitHub.com** repos. The reusable workflows are public, so any repo — personal
  or organization — can call them.
- **The flow is fixed:** `main` + `dev` + typed work branches + squash merges.
  That is the point (the same rules everywhere), not an accident. `runs-on`,
  the board, labels, milestone, priorities, sizes and descriptions are
  configurable; the branch model and commit types are not.
- **Rulesets** need a public repo or a paid plan (GitHub Pro/Team) for private
  ones; on the free plan `bootstrap` warns and skips them. Everything else works
  on the free plan.
- **Projects (v2) boards owned by a personal account** need a _classic_ PAT
  (`GH_PROJECT_TOKEN`); fine-grained tokens cannot reach them.
- **The CLI needs bash** (Linux, macOS, WSL, Git Bash). The `commit-msg` command
  needs a POSIX `sh`.
- The PR descriptions are written by Claude (Anthropic API) when
  `ANTHROPIC_API_KEY` is set; without it a work PR keeps its commit list and the
  release PR its changelog.

---

## Documentation

| Doc                                                          | Covers                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| [ARCHITECTURE](docs/ARCHITECTURE.md)                         | What is shared vs repo-specific, what runs where, deploys, design decisions |
| [ONBOARDING](docs/ONBOARDING.md)                             | Adding a repo with `onboard`, or by hand; what each generated file is for   |
| [CI_FLOW](docs/CI_FLOW.md)                                   | Branch → `dev` → `main`, stage by stage; bump rules; troubleshooting        |
| [COMMIT_GUIDE](docs/COMMIT_GUIDE.md)                         | Commit types, PR titles, versioning, for people writing commits             |
| [AUTO_WORK_ITEMS_WORKFLOW](docs/AUTO_WORK_ITEMS_WORKFLOW.md) | The issue / PR / board automation in detail                                 |
| [CONFIGURATION](docs/CONFIGURATION.md)                       | Every variable, secret and config file, with defaults                       |
| [GITHUB_ACTIONS_SETUP](docs/GITHUB_ACTIONS_SETUP.md)         | Where a value belongs (variable/secret, repo/environment) and why           |
| [REPO_RULES](docs/REPO_RULES.md)                             | Repository settings and branch rulesets                                     |
| [CLI](docs/CLI.md)                                           | Every command and option                                                    |
| [MIGRATION](docs/MIGRATION.md)                               | From `ebalzan/tracebim-ci` v1 to `ebalzan/ci` v2                            |
| [CONTRIBUTING](CONTRIBUTING.md)                              | Working on this repo: layout, tests, releasing, publishing to npm           |

---

## Contributing

Issues and PRs are welcome. This repo uses its own rules, so a PR needs a
typed branch and a Conventional Commit title. Setup, tests and the release
process: [CONTRIBUTING.md](CONTRIBUTING.md). Security reports:
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © ebalzan

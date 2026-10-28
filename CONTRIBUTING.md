# Contributing

This repo is run by its own rules: a typed branch, a Conventional Commit PR
title, squash merges, and a release on every merge to `main`. Read
[docs/CI_FLOW.md](docs/CI_FLOW.md) first if the flow is new to you.

- [Setup](#setup)
- [Layout](#layout)
- [Checks and tests](#checks-and-tests)
- [Making a change](#making-a-change)
- [Releasing a change](#releasing-a-change)
- [Publishing to npm](#publishing-to-npm)
- [Forking for your own rules](#forking-for-your-own-rules)

---

## Setup

```bash
git clone git@github.com:ebalzan/ci.git && cd ci
npm ci            # TypeScript, for actions/auto-work-items
npm run check     # build + verify dist/ + syntax-check every script
npm test          # unit and CLI tests (no network, no GitHub account needed)
```

Node.js ≥ 24 for development (the published CLI needs ≥ 20), bash, git, and
[`gh`](https://cli.github.com) (the bootstrap tests run it, logged out).

## Layout

```text
.github/workflows/
  auto-work-items.yml       reusable  issue + PR + board card per work branch
  pr-title.yml              reusable  Conventional Commit title + branch release type
  promote-dev-to-main.yml   reusable  the evergreen dev → main PR
  release.yml               reusable  semver bump, tag, GitHub Release, sync dev; outputs tag/sha
  self-*.yml                this repo's own flow: callers of the four above, by local path
actions/                    composite actions the reusable workflows run
  auto-work-items/          TypeScript src/ + committed dist/ (run by actions/github-script)
  pr-title/  promote/  release/
scripts/release/            release-main, promote-dev-to-main, release-utils, verify-pr-release-type
managed/                    the commit-message validator (hook + PR-title check)
bin/
  cli.mjs                   the `ebalzan-ci` entry point
  gh-bootstrap.sh           variables, secrets, settings, rulesets → GitHub
  gh-reset.sh               delete Actions config on a repo
  onboard.sh                templates + bootstrap for a new repo
  sync-managed.sh           deprecated: refresh local validator copies
  _lib.sh  _json.mjs        shared helpers (not commands)
config/                     the shared layer: actions.env, repo-settings.json, rulesets/,
                            repos.env, secrets.env.example (secrets.env is gitignored)
templates/                  what `onboard` writes into a repo (__PLACEHOLDERS__)
renovate/tooling.json       shared Renovate preset
test/                       node:test suites
docs/                       user documentation
```

What is published to npm is the `files` list in `package.json`: `bin/`,
`managed/`, `templates/`, `renovate/`, `docs/` and the non-secret `config/`
files. The workflows and actions are consumed from GitHub (`uses:`), not npm.
Check with `npm pack --dry-run`.

## Checks and tests

PR Checks (`self-pr-checks.yml`) runs, in parallel:

| Job     | Runs                                                                                                                                                                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title` | The shared PR-title check, from the local workflow file.                                                                                                                     |
| `check` | `npm run check` (build, `dist/` committed, `bash -n`, `node --check`), `npm run format:check` (Prettier with the `@ebalzan/config` rules), `npm test`, `npm pack --dry-run`. |

The tests never touch GitHub: they use throwaway git repos and run `gh` with an
empty config directory, so it is logged out. What they cover:

| Suite                    | Covers                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release-utils.test.mjs` | Bump rules, breaking changes, branch types, semver.                                                                                                             |
| `rules.test.mjs`         | The commit types agree across validator / release-utils / TYPE_CONFIG; JSON merge; shipped rulesets and settings are well-formed and cannot break `sync-dev`.   |
| `cli.test.mjs`           | Command dispatch, `commit-msg` on subjects and message files, `--help` forwarding.                                                                              |
| `onboard.test.mjs`       | Dry run, template rendering, Node vs non-Node repos, keep vs `--force`, refusals, `.gitignore` lines, `@ebalzan/config` wiring.                                 |
| `bootstrap.test.mjs`     | Dry-run plans: layer labels, settings/ruleset merging, shared and per-repo secrets dirs, `--skip`.                                                              |
| `release.test.mjs`       | `release-main.mjs` end to end against a local bare origin and a fake GitHub API: tag-only and `package.json` releases, re-runs, no-conventional-commit failure. |

To try a command for real against a repo of yours, use `--dry-run` first; the
bootstrap dry run only reads from GitHub.

## Making a change

```bash
git switch dev && git pull
git switch -c fix/your-change
# edit; for actions/auto-work-items/src: npm run build and commit dist/ too
npm run check && npm test
git commit -m "fix(release): …" && git push -u origin fix/your-change
# The issue + PR into dev open. Squash-merge when green.
```

Rules worth knowing:

- **The commit types live in three places** (validator regex, `release-utils`,
  `TYPE_CONFIG`); `rules.test.mjs` fails if they disagree.
- **`dist/` is committed** — callers run it straight from the action download.
- **Keep action inputs backward compatible** within a major: this repo's own
  PRs run the workflow files at the PR commit but the actions at the last
  release (below).
- **Bash 3.2** (macOS `/bin/bash`): no associative arrays, no `mapfile`.
- **Formatting** comes from `@ebalzan/config` (`"prettier"` in `package.json`):
  run `npm run format` before committing. Code-style rules change there, not
  here ([ARCHITECTURE §10](docs/ARCHITECTURE.md#10-the-two-packages-ebalzanci-and-ebalzanconfig)).
- **Docs are part of the change.** A new variable goes in
  [docs/CONFIGURATION.md](docs/CONFIGURATION.md), a new option in
  [docs/CLI.md](docs/CLI.md) and the script's header (its `--help`).

## Releasing a change

Merging into `dev` opens or updates the `dev → main` PR (`self-promote.yml`).
Squash-merging that is the release: `self-release.yml` tags `vX.Y.Z`, creates
the GitHub Release, **moves the major tag** (`v2`) to it, and publishes to npm
when `NPM_PUBLISH` is on. Callers pin `@v2`, so that is the moment the change
reaches every repo — merge the promotion PR deliberately.

- **What runs which version.** The `self-*.yml` callers use the reusable
  workflows by local path (`./.github/workflows/…`), so the workflow file runs
  at the commit being built — but inside it the actions are still
  `ebalzan/ci/actions/<name>@v2`, the last release. A change to an action or a
  release script is checked by `npm run check`/`npm test` on its PR, and runs
  for real only after its own release. That is deliberate: a broken change
  cannot break the pipeline that ships its fix.
- **Internal references.** A reusable workflow cannot know the ref it was
  called at, and is not checked out, so the reusable workflows name this repo's
  actions with an explicit tag. To try an unreleased branch from another repo,
  push a branch whose internal refs point at that branch, and point one repo's
  caller at it (`onboard --ref my-branch` writes callers that way).
- **Breaking change** (a removed input, a new required secret or permission, a
  renamed variable, a changed default the callers rely on): mark it (`feat!:`
  or a `BREAKING CHANGE:` footer). The release is `v3.0.0` and creates `v3`;
  `v2` stays on the last 2.x, so no repo changes. The `major-tag` job then warns
  that the internal refs still say `@v2`: open a PR switching them to `@v3`
  (it could not pass its checks before `v3` existed), which releases `v3.0.1`
  with consistent refs. Move each repo to `@v3` when ready, and write the
  upgrade steps in `docs/MIGRATION.md`.
- **Rollback:** `git tag -f v2 v2.3.0 && git push -f origin v2`. Callers pick
  it up on their next run; npm versions are immutable, so publish a fix forward.

## Publishing to npm

The package is `@ebalzan/ci`. Its version is the release version
(`release-main.mjs` bumps `package.json`). Publishing uses npm **trusted
publishing** (OIDC from GitHub Actions, no token stored anywhere, provenance
attached automatically).

One-time setup:

1. **First publish by hand** — npm needs the package to exist before a trusted
   publisher can be attached. From a clean checkout of the latest release tag:

   ```bash
   git switch --detach v2.0.1     # whatever the latest release is
   npm login
   npm publish --access public
   ```

2. On npmjs.com → the package → **Settings → Trusted publishing**, add a
   GitHub Actions publisher: owner `ebalzan`, repository `ci`, workflow
   `self-release.yml`, no environment.
3. Optionally, in the same settings, **disallow tokens** for publishing, so only
   the workflow can publish.
4. Turn the job on: set `NPM_PUBLISH=true` in `.github/actions.env`, then
   `npm run gh:bootstrap`.

From then on every release publishes itself. If a publish fails (the release
and tags still happened), re-run the `npm` job from the Actions tab.

## Forking for your own rules

The rules here are opinionated on purpose. To run your own set:

1. Fork, and set `CI_REPO=<you>/<fork>` in `config/repos.env`.
2. Change the internal refs (`grep -rn 'ebalzan/ci/actions' .github/workflows`),
   the Renovate preset path, the package `name`/`repository` in
   `package.json`, and `REPOS_TOPIC` if you like.
3. Edit `config/` — that is where the house rules are.
4. Seed the major tag once: `git tag v1.0.0 && git tag v1 && git push origin v1.0.0 v1`.

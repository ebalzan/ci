# Architecture: what lives in ebalzan/ci, what lives in each repo

This is the map. It answers three questions: which parts are the same in every
repo, which parts each repo writes itself (tests, deploys), and where each
piece of code runs. Read it once before onboarding your second repo.

- [1. The model in one picture](#1-the-model-in-one-picture)
- [2. The two stages: shared or yours?](#2-the-two-stages-shared-or-yours)
- [3. What actually runs, stage by stage](#3-what-actually-runs-stage-by-stage)
- [4. Deploys are yours](#4-deploys-are-yours)
- [5. The files a repo needs](#5-the-files-a-repo-needs)
- [6. package.json](#6-packagejson)
- [7. Where you run commands](#7-where-you-run-commands)
- [8. Design decisions](#8-design-decisions)
- [9. Versions: what a pin freezes](#9-versions-what-a-pin-freezes)
- [10. The two packages: @ebalzan/ci and @ebalzan/config](#10-the-two-packages-ebalzanci-and-ebalzanconfig)

---

## 1. The model in one picture

Everything reaches a repo in one of three ways:

```text
                        ebalzan/ci                                   a repo (my-api)
  ┌──────────────────────────────────────────┐          ┌──────────────────────────────────────┐
  │ PULLED at run time — automatic           │  uses:   │ 2 caller files (identical shape)     │
  │   reusable workflows, actions, scripts,  │◀─────────│   auto-pr.yml   pr-checks.yml        │
  │   commit validator, config/actions.env,  │  @v4     │                                      │
  │   renovate preset                        │          │                                      │
  ├──────────────────────────────────────────┤          │ YOURS — the repo writes them         │
  │ PUSHED by a command — `bootstrap`        │─────────▶│   build/test jobs, deploy, its vars  │
  │   shared secrets, repo-settings.json,    │  gh api  │   and secrets, any extra workflow    │
  │   rulesets/  (+ the repo's own config)   │          │                                      │
  └──────────────────────────────────────────┘          └──────────────────────────────────────┘
```

- **Pulled.** A repo uses ebalzan/ci by naming it in `uses:` lines. Every run
  downloads the code from the `v2` tag, so a release of ebalzan/ci reaches every
  repo on its next run. Nothing has to know which repos exist.
- **Pushed.** Some things cannot be pulled: Actions variables and secrets,
  repository settings and rulesets live on GitHub, per repo. `ebalzan-ci
bootstrap` writes them, and that is the only reason ebalzan/ci keeps a list
  of repos (§7).
- **Yours.** What differs between repos: how to build and test it, how to ship
  it, and the values those jobs need. These live in the repo, next to the code
  they act on.

A consequence: **ebalzan/ci cannot make a repo use it.** GitHub only runs
workflow files that are in the repo, so each repo needs its two small caller
files. `onboard` writes them once. After that, they almost never change: a new
caller is only needed when ebalzan/ci releases a new major version.

---

## 2. The two stages: shared or yours?

Each stage has a **caller** in the repo (the trigger, the permissions, a
`uses:` line) and an **implementation** in ebalzan/ci. One of the two callers
is identical in every repo. The other is half shared, half yours.

| Stage     | Caller in the repo                | Implementation in ebalzan/ci                      | Identical in every repo?                                              |
| --------- | --------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| Auto PR   | `.github/workflows/auto-pr.yml`   | `.github/workflows/auto-pr.yml`                   | **Yes.** Only `runs-on` may differ.                                   |
| PR checks | `.github/workflows/pr-checks.yml` | `.github/workflows/pr-check.yml` (job `pr-check`) | **The `pr-check` job, yes.** Build, lint and test jobs are **yours**. |

The two files named `auto-pr.yml` are the same feature: the first is the repo's
trigger, the second is the shared logic it calls. Auto PR covers both kinds of
PR — a work branch's PR into `dev`, and the release PR `dev → main` — and the
PR check checks both. Tagging the release and deploying are not shared stages
yet: merging the release PR is where the shared flow ends.

Why PR checks and deploys stay in the repo: a Node API with a database needs
a generated client and placeholder env before its tests run; a frontend builds
with a framework CLI; a Go service runs `go test`; one repo ships a container
to a VM, another to Vercel, another to npm. Putting all of that behind one
shared workflow would turn it into a pile of `if:`s and inputs that every repo
pays for. The shared part is what is **really** the same: the title rule, the
versioning, the release PR and the release. [§8](#8-design-decisions) covers
when to move something into ebalzan/ci.

---

## 3. What actually runs, stage by stage

How a `uses:` line becomes code on the runner:

- `uses: ebalzan/ci/.github/workflows/X.yml@v2` (in a job) loads the reusable
  workflow file at `v2`. Its jobs run **in the caller repo's context**:
  `github.repository`, `vars` and the token are the caller's.
- Inside it, `uses: ebalzan/ci/actions/Y@v2` (in a step) makes the runner
  download **the whole ebalzan/ci repo at `v2`** into its actions cache. That
  is why the actions can run `scripts/`, `managed/` and read
  `config/actions.env` from `${{ github.action_path }}/../..`.
- The caller repo is only checked out where a stage needs its files.

### Auto PR: `auto-pr.yml` → `auto-pr.yml`

```text
push to feat/x, or to dev
└─ auto-pr.yml (repo)                       trigger, permissions, secrets
   └─ auto-pr.yml (ci)                      full-history checkout, Node 24; job env: AUTO_BASE_BRANCH,
      │                                     AUTO_RELEASE_BRANCH, REPO_VARS_JSON = toJSON(vars)
      └─ actions/auto-pr (ci)               composite, one script per step
         ├─ scripts/shared-vars.mjs         repo vars (AUTO_*) + config/actions.env → env; the PR kind
         ├─ work-pr.sh                      feat/x: find or open the draft PR into dev (gh)
         ├─ release-pr.sh                   dev: find or open the release PR into main; title from
         │                                  scripts/release-title.mjs, body from git-cliff (config/cliff.toml)
         ├─ sync-metadata.sh                label (type / release), assignee, milestone, board (best effort)
         ├─ describe.sh                     Claude Code (headless) reads the branch → description
         └─ gh pr ready                     a PR this run opened leaves draft
```

### PR checks: `pr-checks.yml` → `pr-check.yml` + your jobs

```text
PR into dev or main
└─ pr-checks.yml (repo)
   ├─ job pr-check → pr-check.yml (ci)      full-history checkout of the PR head, Node 24
   │  ├─ job Work PR    (head ≠ dev)  ─┐
   │  └─ job Release PR (head = dev)  ─┴─ actions/pr-check (ci), kind work | release
   │     ├─ commitlint                      title and every commit
   │     └─ Danger: dangerfile.mjs          PR data → work-pr/rules.mjs or release-pr/rules.mjs,
   │                                        both on rules.mjs (what every PR needs); the release
   │                                        PR's title is recomputed (scripts/release-title.mjs)
   └─ your jobs (repo) — checkout, install, lint, typecheck, test, build, image build…
```

---

## 4. Deploys are yours

> **Not wired in this version.** There is no shared release stage yet, so
> nothing produces the outputs below; this section is the contract it had, kept
> for when it returns.

The release stage ends with two outputs, and that is the whole contract:

| Output | Value                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------- |
| `tag`  | `vX.Y.Z` just released, or **empty** when nothing was released (e.g. the release commit's own run). |
| `sha`  | The commit the tag points at.                                                                       |

Everything after it — building artifacts, pushing images, rolling out, smoke
tests — is the repo's code.

### Recommended shape

```text
.github/workflows/
  release.yml     shared release job + `deploy: uses: ./.github/workflows/deploy.yml`
  deploy.yml      on: workflow_call — THE deploy logic, inputs: tag (+ sha, publish flag)
  redeploy.yml    on: workflow_dispatch — calls deploy.yml with an existing tag (rollback / retry)
scripts/
  deploy-*.sh     anything that runs on a host ships with the code it deploys
.github/
  secrets.production.env(.example)   deploy credentials, environment-scoped (bootstrap syncs them)
```

```yaml
# release.yml (repo)
permissions:
  contents: write # the shared release job
  pull-requests: read # the shared release job
  packages: write # your deploy: push an image
  id-token: write # your deploy: cloud OIDC login
jobs:
  release:
    uses: ebalzan/ci/.github/workflows/release.yml@v2
  deploy:
    needs: release
    if: ${{ needs.release.outputs.tag != '' }}
    uses: ./.github/workflows/deploy.yml
    with:
      tag: ${{ needs.release.outputs.tag }}
      sha: ${{ needs.release.outputs.sha }}
    secrets: inherit # fine here: same repo
```

```yaml
# deploy.yml (repo)
on:
  workflow_call:
    inputs:
      tag: { type: string, required: true }
      sha: { type: string, required: false }
concurrency:
  group: deploy-production
  cancel-in-progress: false # never stop a rollout halfway
jobs:
  deploy:
    environment: production # unlocks the environment's secrets, records the deployment
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.sha || inputs.tag }}
      - run: ./scripts/deploy.sh "${{ inputs.tag }}"
```

Why split `deploy.yml` out of `release.yml`: it lets `redeploy.yml` roll back
to any earlier tag, or retry a failed rollout, without cutting a new release.

Points to get right:

- **Permissions add up.** A reusable workflow can only narrow what its caller
  grants. The caller's `permissions:` must cover both the shared release job
  (`contents: write`, `pull-requests: read`) and your deploy.
- **Environment secrets** resolve only in a job that declares `environment:`.
  Put deploy credentials in `.github/secrets.production.env`; `bootstrap`
  creates the environment and fills it.
- **Typical deploys**: a container image to a registry, then a VM (SSM or SSH)
  or Kubernetes; a static site or Vercel/Netlify deploy of the tag; an npm
  publish (this repo's own `self-release.yml` has one); a mobile build
  submitted to a store.

Two other kinds of repo-specific job follow the same pattern: **PR previews**
(a Vercel preview, an image build without push) go in `pr-checks.yml`, and
**scheduled jobs** (nightly tests, backups) get their own workflow file.

---

## 5. The files a repo needs

| File                                                              | Needed when                                                  | Same in every repo?           | Written by                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------- | ----------------------------------------------------------- |
| `.github/workflows/auto-pr.yml`                                   | always                                                       | yes (`runs-on` aside)         | `onboard`                                                   |
| `.github/workflows/pr-checks.yml`                                 | always                                                       | `pr-check` job yes; others no | `onboard`, then you                                         |
| `.github/workflows/deploy.yml`, `redeploy.yml`                    | the repo deploys                                             | no                            | you                                                         |
| branches `main` and `dev`                                         | always                                                       | —                             | `onboard` creates `dev`                                     |
| `.github/actions.env`                                             | it has its own variables (board, milestone, deploy settings) | no                            | `onboard` (empty starter), you                              |
| repo secrets: `secrets.env`, `secrets.<env>.env`                  | it has its own secrets (deploy credentials, …)               | no                            | you — **never committed** ([§7](#7-where-you-run-commands)) |
| `.gitignore`: `/.github/secrets*.env`                             | always                                                       | yes                           | `onboard`                                                   |
| `.github/bootstrap.conf`                                          | some secrets only local scripts read                         | no                            | you                                                         |
| `.github/repo-settings.json`                                      | it deviates from the shared settings                         | no                            | you                                                         |
| `.github/rulesets/*.json`                                         | it deviates from / adds to the shared rulesets               | no                            | you                                                         |
| `.husky/commit-msg`                                               | Node repo                                                    | yes                           | `onboard`                                                   |
| `package.json` `"prettier": "@ebalzan/config/prettier"`           | Node repo                                                    | yes                           | `onboard`, unless the repo has its own Prettier config      |
| `eslint.config.mjs` spreading `@ebalzan/config/eslint/node`       | Node repo                                                    | the base yes; repo blocks no  | `onboard`, unless the repo has its own ESLint config        |
| `tsconfig.json` `"extends": "@ebalzan/config/tsconfig/node.json"` | TypeScript repo                                              | the base yes; paths no        | you (`onboard` only reports it)                             |
| `renovate.json`                                                   | you use Renovate                                             | yes                           | `onboard`                                                   |

A brand-new Node repo that only needs the flow has the two workflow files,
the hook, the Prettier/ESLint wiring, `renovate.json`, an empty `actions.env`
and the `.gitignore` lines, and nothing else. A non-Node repo has the four
workflow files, `renovate.json`, `actions.env` and `.gitignore`.

The secrets files are ignored before any exists: `onboard` appends this to
`.gitignore` unless the repo already ignores them:

```gitignore
/.github/secrets.env
/.github/secrets.*.env
!/.github/secrets*.env.example
```

---

## 6. package.json

The pipeline itself needs **nothing** from `package.json`. A repo without one
is released tag-only. With one:

| Field / script                                                           | Why                                                                                                                                                             |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"version": "X.Y.Z"`                                                     | The release bumps it and commits it (the tag is the source of truth; this mirrors it).                                                                          |
| devDependency `@ebalzan/ci`                                              | The `commit-msg` hook runs `ebalzan-ci commit-msg` from it: instant, offline.                                                                                   |
| devDependency `husky`, `"prepare": "husky"`                              | Installs the hook on `npm install`.                                                                                                                             |
| devDependencies `@ebalzan/config`, `eslint`, `prettier` (exact versions) | The shared code-style rules ([§10](#10-the-two-packages-ebalzanci-and-ebalzanconfig)); `eslint`, `prettier` and `typescript` are its peers, pinned by the repo. |
| `"prettier": "@ebalzan/config/prettier"`                                 | Prettier reads the shared options; no `.prettierrc` in the repo.                                                                                                |
| your quality scripts                                                     | Whatever your `pr-checks.yml` jobs call (below).                                                                                                                |

**Admin scripts are not needed.** `gh:bootstrap`/`gh:reset` scripts in each
repo were the v1 way to reach the tools. In v2 you run them from one place
([§7](#7-where-you-run-commands)), or with `npx @ebalzan/ci …` from anywhere.

**Quality scripts: a convention, not a requirement.** CI is easiest to keep
honest when one script runs every check, and both you and CI call it:

```json
"scripts": {
  "format": "prettier --write .",
  "format:check": "prettier --check .",
  "lint": "eslint --max-warnings 0 .",
  "typecheck": "tsc --noEmit",
  "test": "node --test",
  "build": "tsc -p tsconfig.build.json",
  "validate": "npm run format:check && npm run typecheck && npm run lint && npm test"
}
```

Then the repo's job in `pr-checks.yml` is `npm ci`, `npx --no-install
ebalzan-config verify` (the repo extends the shared rules rather than copying
them) and `npm run validate` — the commented `validate` job in the template.
"It passed locally" then means it passes in CI.

**Gotcha:** `preversion`, `version` and `postversion` scripts run during the
release, because the release calls `npm version`. Leave them out unless you
want them to run on the CI runner at every release.

---

## 7. Where you run commands

**Developers of a repo run nothing CI-related.** They branch, commit (the hook
checks the message) and push. Everything else happens in Actions.

**You, as the admin, run everything from one place**: a checkout of ebalzan/ci
(or `npx @ebalzan/ci` anywhere):

```bash
cd ~/Developer/ci
npm run gh:bootstrap -- --all --dry-run      # every repo: plan
npm run gh:bootstrap -- --all                # every repo: apply
npm run gh:bootstrap -- -R owner/my-api      # one repo, no checkout needed
bin/onboard.sh -C ../my-new-repo             # onboard a repo
```

What `--all` touches, and where each piece comes from:

| Piece                                  | Comes from                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| which repos                            | GitHub topic `ebalzan-ci` (added by `onboard`), plus slugs in `config/repos.env` → `REPOS`            |
| shared variables, settings, rulesets   | ebalzan/ci `config/`                                                                                  |
| shared secrets                         | `~/.config/ebalzan-ci/secrets.env` (or `config/secrets.env` in your checkout)                         |
| a repo's variables, settings, rulesets | its committed `.github/` — from a local checkout under `CI_REPOS_ROOT`, else via the API              |
| a repo's own secrets                   | `~/.config/ebalzan-ci/repos/<owner>/<repo>/secrets*.env` — else its checkout's `.github/secrets*.env` |

**Keep every repo's secrets in the one folder** (recommended):

```text
~/.config/ebalzan-ci/                  (or $CI_SECRETS_DIR)
  secrets.env                          shared: every repo gets these
  repos/
    owner/my-api/
      secrets.env                      my-api's repository secrets
      secrets.production.env           my-api's `production` environment secrets
    owner/my-web/
      secrets.preview.env
```

With it, `--all` syncs every repo's secrets with **no checkouts at all**,
there is one folder to back up (or keep in an encrypted store), and nothing
secret sits inside a git working tree. When a repo has a folder there, its
checkout's `secrets*.env` files are ignored (the bootstrap warns if both
exist). A repo without one falls back to its checkout's gitignored
`.github/secrets*.env`; with no checkout either, only the shared secrets are
synced and the bootstrap says so. `LOCAL_ONLY_KEYS` still come from the repo's
committed `.github/bootstrap.conf`.

---

## 8. Design decisions

### Why each repo's config lives in that repo, not in ebalzan/ci

It could be centralized (`ebalzan/ci/repos/<name>/actions.env`, with every
command run from here). It is not, because:

1. **ebalzan/ci is public and on npm.** Per-repo config names private repos,
   hosts, environments and board numbers. Variables are not secrets, but they
   do not belong in a public package either.
2. **Config belongs next to the code that reads it.** A deploy job and the
   variables it reads change in the same PR, are reviewed together, and are
   reverted together. Split across two repos, they drift.
3. **A repo explains itself.** Clone it and you see everything it needs to run.
   Delete it and nothing is left behind in a central registry.
4. **Other people can use the package.** A central registry would only ever
   describe your repos.

The cost, needing the checkouts for per-repo secrets, is the limit described
in §7.

### Why two packages, and who owns the commit rule

See [§10](#10-the-two-packages-ebalzanci-and-ebalzanconfig).

### Why a topic, not a committed list of repos

`REPOS=` in `config/repos.env` works, and is there for repos you cannot tag
(another organization's, say). The topic is the default because it is not
published: the list lives on GitHub, visible only to people who can see the
repos. It updates itself when `onboard` runs, without a PR or release of
ebalzan/ci, and it cannot drift from reality the way a file can.

The list only scopes **admin commands**. It does not decide which repos _use_
ebalzan/ci; the `uses:` lines do.

### When something moves into ebalzan/ci

Code moves here when **two or more repos need the same job with the same
steps**, not before. A shared workflow designed for one repo will fit the
second one badly. The test: can it be expressed with a few inputs and no
`if: repo == …`? Likely candidates as repos are added:

- a `docker-publish.yml` (build and push an image for `tag`), once two
  repos ship containers;
- a `node-validate.yml` (`npm ci` + cached `node_modules` + `npm run validate`),
  once several repos follow the script convention of §6 with no special setup;
- a deploy for one target (e.g. Vercel), once two repos deploy there.

The repo would still keep its caller job, its environment and its secrets.

---

## 9. Versions: what a pin freezes

Callers pin the **major tag** (`@v2`), and every release of ebalzan/ci moves it.
Pinning an exact version (`@v2.3.1`) or a commit SHA freezes only the
**reusable workflow file**. The steps inside it name their actions as
`ebalzan/ci/actions/<name>@v2`, because a reusable workflow cannot know the ref
it was called at. So the actions, the scripts and `config/actions.env` still
come from the latest `v2`.

| You pin            | Workflow file | Actions, scripts, shared variables         |
| ------------------ | ------------- | ------------------------------------------ |
| `@v2`              | latest v2     | latest v2                                  |
| `@v2.3.1` / a SHA  | frozen        | latest v2                                  |
| a fork, at any ref | your fork     | your fork (once its internal refs name it) |

A new major (`v3`) never moves `v2`, so breaking changes never reach a repo
until you change its `uses:` lines. To freeze everything, fork ebalzan/ci
([CONTRIBUTING → Forking](../CONTRIBUTING.md#forking-for-your-own-rules)).

---

## 10. The two packages: @ebalzan/ci and @ebalzan/config

| Package           | Owns                                                                                                                     | Reaches a repo through                                          | An update arrives                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------ |
| `@ebalzan/ci`     | **how code is shipped**: commit/PR-title rule, the two stages, the release PR, repo settings and rulesets, the admin CLI | `uses: ebalzan/ci/…@v2` at run time; devDependency for the hook | instantly, when `v2` moves                 |
| `@ebalzan/config` | **how code is written**: Prettier options, ESLint presets, tsconfig bases                                                | devDependency, read by the editor, ESLint, Prettier and tsc     | as a Renovate PR, checked by the repo's CI |

They stay separate because their updates must behave differently. A pipeline
fix needs no change in any repo, so it ships instantly through the major tag.
A new lint rule can fail existing code, so it has to arrive as a PR that each
repo's CI checks before it merges. In one package, every pipeline fix would
open a Renovate PR in every repo, and every breaking lint rule would force a
new pipeline major (`v3`, editing every `uses:` line). `@ebalzan/ci` also
serves non-JS repos, which should not install the ESLint stack to run the
admin CLI.

**The commit rule belongs to `@ebalzan/ci`.** It is a pipeline rule: the PR
title becomes the squash commit that decides the version bump, and the same
types drive the branch check, the bump and the labels — all here, kept in
agreement by `test/rules.test.mjs`. `@ebalzan/config` has no commit rule; the
hook runs `ebalzan-ci commit-msg`.

In a Node repo the two meet in three places, all written by `onboard`:
`package.json` (both devDependencies, `"prettier"`), `eslint.config.mjs`, and
the `validate` job in `pr-checks.yml`, which runs `ebalzan-config verify`.
Renovate keeps both packages current, in the same weekly `dev tooling` PR.

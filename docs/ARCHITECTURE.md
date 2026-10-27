# Architecture: what lives in ebalzan/ci, what lives in each repo

This is the map. It answers three questions: which parts are the same in every
repo, which parts each repo writes itself (tests, deploys), and where each
piece of code runs. Read it once before onboarding your second repo.

- [1. The model in one picture](#1-the-model-in-one-picture)
- [2. The four stages: shared or yours?](#2-the-four-stages-shared-or-yours)
- [3. What actually runs, stage by stage](#3-what-actually-runs-stage-by-stage)
- [4. Deploys are yours](#4-deploys-are-yours)
- [5. The files a repo needs](#5-the-files-a-repo-needs)
- [6. package.json](#6-packagejson)
- [7. Where you run commands](#7-where-you-run-commands)
- [8. Design decisions](#8-design-decisions)
- [9. Versions: what a pin freezes](#9-versions-what-a-pin-freezes)

---

## 1. The model in one picture

Everything reaches a repo in one of three ways:

```text
                        ebalzan/ci                                   a repo (my-api)
  ┌──────────────────────────────────────────┐          ┌──────────────────────────────────────┐
  │ PULLED at run time — automatic           │  uses:   │ 4 caller files (identical shape)     │
  │   reusable workflows, actions, scripts,  │◀─────────│   auto-pr.yml   promote-dev-to-main  │
  │   commit validator, config/actions.env,  │  @v2     │   pr-checks.yml release.yml          │
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
workflow files that are in the repo, so each repo needs its four small caller
files. `onboard` writes them once. After that, they almost never change: a new
caller is only needed when ebalzan/ci releases a new major version.

---

## 2. The four stages: shared or yours?

Each stage has a **caller** in the repo (the trigger, the permissions, a
`uses:` line) and an **implementation** in ebalzan/ci. Two of the four callers
are identical in every repo. The other two are half shared, half yours.

| Stage      | Caller in the repo                          | Implementation in ebalzan/ci                    | Identical in every repo?                                           |
| ---------- | ------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| Work items | `.github/workflows/auto-pr.yml`             | `.github/workflows/auto-work-items.yml`         | **Yes.** Only `runs-on` may differ.                                |
| PR checks  | `.github/workflows/pr-checks.yml`           | `.github/workflows/pr-title.yml` (job `title`)  | **The `title` job, yes.** Build, lint and test jobs are **yours**. |
| Promotion  | `.github/workflows/promote-dev-to-main.yml` | `.github/workflows/promote-dev-to-main.yml`     | **Yes.** Only `runs-on` may differ.                                |
| Release    | `.github/workflows/release.yml`             | `.github/workflows/release.yml` (job `release`) | **The `release` job, yes.** Deploy jobs are **yours**.             |

`auto-pr.yml` and `auto-work-items.yml` are the same feature: the first is the
repo's trigger, the second is the shared logic it calls. The same is true of
the two files named `promote-dev-to-main.yml` and the two named `release.yml`.

Why PR checks and deploys stay in the repo: a Node API with a database needs
a generated client and placeholder env before its tests run; a frontend builds
with a framework CLI; a Go service runs `go test`; one repo ships a container
to a VM, another to Vercel, another to npm. Putting all of that behind one
shared workflow would turn it into a pile of `if:`s and inputs that every repo
pays for. The shared part is what is **really** the same: the title rule, the
versioning, the promotion and the release. [§8](#8-design-decisions) covers
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

### Work items: `auto-pr.yml` → `auto-work-items.yml`

```text
push to feat/x
└─ auto-pr.yml (repo)                       trigger, permissions, secrets
   └─ auto-work-items.yml (ci)              job env: AUTO_BASE_BRANCH, REPO_VARS_JSON = toJSON(vars)
      └─ actions/auto-work-items (ci)       composite: actions/github-script runs dist/index.js
         └─ src/index.ts                    orchestrates, all through the GitHub API (no checkout)
            ├─ sharedVars.ts                repo vars (AUTO_*) + config/actions.env → env
            ├─ config.ts                    branch type → title, labels, priority, size, estimate
            ├─ labels.ts  milestone.ts      create/sync labels; resolve milestone
            ├─ describe.ts                  branch commits + diff → Claude → issue/PR body
            ├─ issue.ts  pr.ts  assignee.ts upsert issue, PR into dev, assignee
            └─ project.ts                   board card + fields (skipped without AUTO_PROJECT_NUMBER)
```

### PR checks: `pr-checks.yml` → `pr-title.yml` + your jobs

```text
PR into dev or main
└─ pr-checks.yml (repo)
   ├─ job title → pr-title.yml (ci)
   │  ├─ sparse checkout of the repo (only to compare old validator copies)
   │  └─ actions/pr-title (ci)
   │     ├─ managed/scripts/release/validate-conventional-subject.sh   title is a Conventional Commit
   │     ├─ scripts/release/verify-pr-release-type.mjs                 title type matches branch type
   │     └─ drift check of local copies of managed/ files (deprecated copies only)
   └─ your jobs (repo) — checkout, install, lint, typecheck, test, build, image build…
```

### Promotion: `promote-dev-to-main.yml` → `promote-dev-to-main.yml`

```text
push to dev
└─ promote-dev-to-main.yml (repo)
   └─ promote-dev-to-main.yml (ci)          checkout of the repo (for package.json), Node 24
      └─ actions/promote (ci)
         └─ scripts/release/promote-dev-to-main.mjs
            ├─ compare main...dev, compute the bump (release-utils.mjs)
            ├─ open/update the single dev → main PR, title "feat: promote dev to main (vX.Y.Z)"
            └─ labels, assignee, milestone, board (best effort)
```

### Release: `release.yml` → `release.yml` + your deploy

```text
push to main
└─ release.yml (repo)
   ├─ job release → release.yml (ci)
   │  ├─ job release: full-history checkout, Node 24, git identity
   │  │  └─ actions/release (ci) → scripts/release/release-main.mjs
   │  │     ├─ next version from the commits since the last vX.Y.Z tag
   │  │     ├─ package.json? bump + "chore(release): X.Y.Z" commit : tag only
   │  │     ├─ tag vX.Y.Z, push, GitHub Release
   │  │     └─ outputs: tag, sha
   │  └─ job sync-dev: force-point dev at the release commit (inline shell)
   └─ your deploy jobs (repo), on needs.release.outputs.tag
```

---

## 4. Deploys are yours

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

| File                                           | Needed when                                                  | Same in every repo?            | Written by                     |
| ---------------------------------------------- | ------------------------------------------------------------ | ------------------------------ | ------------------------------ |
| `.github/workflows/auto-pr.yml`                | always                                                       | yes (`runs-on` aside)          | `onboard`                      |
| `.github/workflows/promote-dev-to-main.yml`    | always                                                       | yes (`runs-on` aside)          | `onboard`                      |
| `.github/workflows/pr-checks.yml`              | always                                                       | `title` job yes; other jobs no | `onboard`, then you            |
| `.github/workflows/release.yml`                | always                                                       | `release` job yes; deploy no   | `onboard`, then you            |
| `.github/workflows/deploy.yml`, `redeploy.yml` | the repo deploys                                             | no                             | you                            |
| branches `main` and `dev`                      | always                                                       | —                              | `onboard` creates `dev`        |
| `.github/actions.env`                          | it has its own variables (board, milestone, deploy settings) | no                             | `onboard` (empty starter), you |
| `.github/secrets.env` + `.example`             | it has its own repository secrets                            | no                             | you — **never committed**      |
| `.github/secrets.<env>.env` + `.example`       | it deploys with secrets                                      | no                             | you — **never committed**      |
| `.gitignore`: `/.github/secrets*.env`          | any secrets file exists                                      | yes                            | you (see below)                |
| `.github/bootstrap.conf`                       | some secrets only local scripts read                         | no                             | you                            |
| `.github/repo-settings.json`                   | it deviates from the shared settings                         | no                             | you                            |
| `.github/rulesets/*.json`                      | it deviates from / adds to the shared rulesets               | no                             | you                            |
| `.husky/commit-msg`                            | Node repo                                                    | yes                            | `onboard`                      |
| `renovate.json`                                | you use Renovate                                             | yes                            | `onboard`                      |

A brand-new repo that only needs the flow has the four workflow files, the
hook, `renovate.json` and an empty `actions.env`, and nothing else.

The secrets files must be ignored before they exist. `onboard` does not edit
`.gitignore`, so add this to it yourself:

```gitignore
/.github/secrets.env
/.github/secrets.*.env
!/.github/secrets*.env.example
```

---

## 6. package.json

The pipeline itself needs **nothing** from `package.json`. A repo without one
is released tag-only. With one:

| Field / script                              | Why                                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `"version": "X.Y.Z"`                        | The release bumps it and commits it (the tag is the source of truth; this mirrors it). |
| devDependency `@ebalzan/ci`                 | The `commit-msg` hook runs `ebalzan-ci commit-msg` from it: instant, offline.          |
| devDependency `husky`, `"prepare": "husky"` | Installs the hook on `npm install`.                                                    |
| your quality scripts                        | Whatever your `pr-checks.yml` jobs call (below).                                       |

**Admin scripts are not needed.** `gh:bootstrap`/`gh:reset` scripts in each
repo were the v1 way to reach the tools. In v2 you run them from one place
([§7](#7-where-you-run-commands)), or with `npx @ebalzan/ci …` from anywhere.

**Quality scripts: a convention, not a requirement.** CI is easiest to keep
honest when one script runs every check, and both you and CI call it:

```json
"scripts": {
  "lint": "eslint --max-warnings 0 .",
  "typecheck": "tsc --noEmit",
  "test": "node --test",
  "build": "tsc -p tsconfig.build.json",
  "validate": "npm run typecheck && npm run lint && npm test"
}
```

Then the repo's job in `pr-checks.yml` is `npm ci && npm run validate` (or one
step per script, to see each one's time), and "it passed locally" means it
passes in CI.

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

| Piece                                  | Comes from                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| which repos                            | GitHub topic `ebalzan-ci` (added by `onboard`), plus slugs in `config/repos.env` → `REPOS`  |
| shared variables, settings, rulesets   | ebalzan/ci `config/`                                                                        |
| shared secrets                         | `~/.config/ebalzan-ci/secrets.env` (or `config/secrets.env` in your checkout)               |
| a repo's variables, settings, rulesets | its committed `.github/` — from a local checkout under `CI_REPOS_ROOT`, else via the API    |
| a repo's own secrets                   | its local checkout's `.github/secrets*.env` — so they need a checkout under `CI_REPOS_ROOT` |

The last row is the one limit: a repo's own secrets only exist on your disk, in
its checkout. A repo with no checkout under `CI_REPOS_ROOT` is synced without
them (the bootstrap says so).

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

# CI/CD Flow (shared stages)

The branch → `dev` → `main` → release flow every repo using ebalzan/ci runs.
This file covers the stages this repo owns; what happens **after** a release
(a container rollout, a Vercel deploy, an app store build) and each repo's own
build/test checks belong to that repo, chained on the stages below. This repo
runs the same flow on itself (`.github/workflows/self-*.yml`), where the release
also moves the major tag the other repos pin
([CONTRIBUTING → Releasing](../CONTRIBUTING.md#releasing-a-change)).

> **Model:** feature branch → `dev` → `main`.
> `dev` is the integration branch. `main` is the release branch.
> Every push to `main` produces a versioned release, which the repo then ships.

---

## 1. Branching model

| Branch                          | Role                    | Receives merges from | Protected |
| ------------------------------- | ----------------------- | -------------------- | --------- |
| `main`                          | Releases                | `dev` only           | Yes ¹     |
| `dev`                           | Integration of features | feature branches     | Yes ¹     |
| `feat/*`, `fix/*`, `chore/*`, … | Short-lived work        | (you push to them)   | No        |

Supported work-branch prefixes (each maps to a release type for the
feature → `dev` PR check): `feat`, `fix`, `docs`, `style`, `refact`, `perf`,
`test`, `build`, `ci`, `chore`, `revert`. Any other prefix fails both the PR
check and the auto work-items run. A `refact/` branch takes a `refact:` title;
there is no `refactor` type, and no `feature/` or `hotfix/` alias.

¹ By the rulesets `bootstrap` applies: neither can be deleted, `main` cannot be
force-pushed, and an opt-in ruleset requires PRs ([REPO_RULES.md](REPO_RULES.md)).

---

## 2. The flow at a glance

```text
  feature branch ── git push
        │
        ▼
  (1) Auto Create Work Items     auto-work-items.yml
        │  Issue + PR (base = dev) + project card
        ▼
  PR: feat → dev ── (2) PR Checks: pr-title.yml + the repo's own jobs
        │  ✅ squash-merge into dev
        ▼
  (3) Promote dev to main        promote-dev-to-main.yml
        │  ONE PR: dev → main (auto title + commit list)
        ▼
  PR: dev → main ── (2) PR Checks again (base = main)
        │  ✅ squash-merge into main   ← this is the release approval
        ▼
  (4) Release                    release.yml
        │  bump from commits → tag vX.Y.Z → GitHub Release → dev synced
        ▼
  (5) Ship — the repo's own job, chained on release.yml's `tag` / `sha` outputs
```

Each stage is a reusable workflow here, called from a thin file in the repo
that holds only the trigger, the permissions and the `uses:` line.

---

## 3. Stage by stage

### Stage 1 — Auto Create Work Items

- **Reusable workflow:** `.github/workflows/auto-work-items.yml`
- **Repo caller:** `.github/workflows/auto-pr.yml`, triggered on `push` to any
  branch except `main` and `dev` (never on tags).
- **What it does:** creates or updates (idempotent per branch) a GitHub
  **Issue**, a **PR** into `dev`, and the **project card** with labels,
  milestone, priority, size, estimate and dates. Details:
  [AUTO_WORK_ITEMS_WORKFLOW.md](./AUTO_WORK_ITEMS_WORKFLOW.md).
- **Token:** `GH_PROJECT_TOKEN` if present, else `github.token`. A classic PAT
  with the `project` scope is required to write to a user-owned board, and so
  that the created PR triggers Stage 2.

### Stage 2 — PR Checks

- **Repo file:** `.github/workflows/pr-checks.yml`, on `pull_request` into
  `main` or `dev` (`opened`, `synchronize`, `reopened`, `ready_for_review`).
- **Shared job** (`pr-title.yml` → `actions/pr-title`):
  1. `validate-conventional-subject.sh` — the title must be a Conventional
     Commits subject (e.g. `feat(search): add filters`).
  2. `verify-pr-release-type.mjs` — checks the title's release type against the
     **branch**:
     - **Feature branch** (`feat/...` → `dev`): the title's type must match the
       branch type, unless the title marks a breaking change with `!`.
     - **Promotion** (`dev` → `main`): only requires a valid conventional title;
       the bump is computed later from the promoted commits.
  3. Managed-file drift: if the repo still keeps a (deprecated) local copy of a
     `managed/` file, it must equal this version's ([CLI → sync-managed](CLI.md#sync-managed)).
- **Repo jobs** (validate, build, image build, delivery preview, …) run in
  parallel beside it. A bad title still fails the run.
- The check is reported as **`<caller job id> / Validate PR Title`**. Name the
  caller job `title` (the template does): `title / Validate PR Title` is the
  context the `ci: require pull request` ruleset requires.

### Stage 3 — Promote dev to main

- **Reusable workflow:** `.github/workflows/promote-dev-to-main.yml`
  (`scripts/release/promote-dev-to-main.mjs`)
- **Repo caller:** `push` to `dev`, plus `workflow_dispatch`.
- **What it does:**
  1. Compares `main...dev`. If `dev` is not ahead, it stops.
  2. Computes the bump from the promoted commits and creates or updates a
     single `dev → main` PR titled with the most significant type among them
     (`feat` > `fix` > `refact` > `perf` > `revert` > `build` > `ci` > `docs` >
     `test` > `style` > `chore`, `!` for breaking) plus the projected version,
     e.g. `refact: promote dev to main (v0.6.3)`. The body lists every commit.
  3. Best-effort metadata (a failure warns, never fails the run): assignee = who
     pushed to `dev`; labels `release` + each promoted commit type (only ever
     added); the `AUTO_MILESTONE_TITLE` milestone and the project board, when
     configured.
- **Token:** `GH_PROJECT_TOKEN` if present, else `GITHUB_TOKEN`.
  ⚠️ A PR opened with the default `GITHUB_TOKEN` does not trigger other
  workflows — without the PAT, PR Checks will not run on the promotion PR until
  you push to it or reopen it.

### Stage 4 — Release

- **Reusable workflow:** `.github/workflows/release.yml`
  (`scripts/release/release-main.mjs`)
- **Repo caller:** `push` to `main`.
- **Skip guard:** skipped when the head commit starts with `chore(release):`,
  so the release commit cannot release again.
- **What it does:**
  1. Reads the latest `vX.Y.Z` tag (none yet: the `package.json` version, or `0.0.0`).
  2. Computes the bump from every Conventional Commit since it (§4).
  3. With a `package.json`: bumps it (and the lockfile, if any), commits
     `chore(release): X.Y.Z`, tags `vX.Y.Z`. Without one: tags the merged
     commit as is (tag-only release). Pushes the branch and the tag.
  4. Publishes a GitHub Release (associated PR + included commits).
  5. `sync-dev`: force-points `dev` at the release commit (§4, "Squash
     everything").
- **Outputs:** `tag` (`vX.Y.Z`, empty when nothing was released) and `sha`
  (the release commit). The repo's own ship jobs chain on them.

---

## 4. Version bump rules (commit-scan)

The bump is derived from **the Conventional Commits landed on `main` since the
previous tag**, not from any branch name. Highest wins:

| Found in any commit since last tag                                                 | Bump              |
| ---------------------------------------------------------------------------------- | ----------------- |
| `!` after type, or `BREAKING CHANGE:` footer                                       | `major`           |
| `feat:`                                                                            | `minor`           |
| `fix`, `perf`, `docs`, `style`, `refact`, `test`, `build`, `ci`, `chore`, `revert` | `patch`           |
| no Conventional Commit found                                                       | release **fails** |

Implementation: `highestRelease()` in `scripts/release/release-utils.mjs`, used
by both `release-main.mjs` (the bump) and `promote-dev-to-main.mjs` (the title
preview).

### Why this works for either merge method on `dev → main`

- **Squash merge:** `main` gets one commit using the PR title; because the
  promotion title is generated to carry the highest bump, the scan still yields
  the right version. **This is the method every repo uses** — the shared
  repo settings allow nothing else.
- **Merge commit:** the feature commits flow into `main`; the scan (which skips
  merge commits) sees each one.

> **Squash everything.** A squash (or rebase) rewrites the promoted commits, so
> `dev` and `main` end up with identical content under unrelated histories, and
> the _next_ promotion would re-merge everything from the last common ancestor
> and conflict against itself. `sync-dev` prevents that by force-pointing `dev`
> at the release commit after each release. Consequence: if you have local
> commits on `dev` that were not released, `git reset --hard origin/dev` after a
> release and branch off it.

---

## 5. Developer flow (cheat sheet)

```bash
git checkout dev && git pull origin dev
git checkout -b feat/your-change
git commit -m "feat(search): add result filters"   # husky checks it
git push -u origin feat/your-change   # Stage 1 opens Issue + PR into dev
# merge into dev (squash) once PR Checks pass
# Stage 3 opens/updates dev → main; merge it (squash) to release
# Stage 4 versions, tags, releases; the repo ships the tag
```

You never edit versions, tags or release notes by hand.

---

## 6. Troubleshooting

| Symptom                                                  | Likely cause / fix                                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Workflow fails to start: "workflow was not found"        | Wrong `uses:` path or ref, or the repo's Actions policy does not allow actions from other repos (Settings → Actions → General). |
| "The nested job is requesting 'X', but is only allowed…" | The caller's `permissions:` lacks what the reusable job declares. Grant it in the caller.                                       |
| No Issue/PR after pushing a feature branch               | Branch was `dev`/`main` (ignored), unsupported prefix, or `GH_PROJECT_TOKEN` missing/insufficient.                              |
| `dev → main` PR exists but no checks ran                 | Opened with the default `GITHUB_TOKEN`. Set `GH_PROJECT_TOKEN`, or push to it.                                                  |
| PR Checks: "differs from ebalzan/ci's managed copy"      | Delete the local copy and use the hook from the package ([CLI](CLI.md#commit-msg)).                                             |
| Release failed: "Could not determine a release type"     | No Conventional Commit since the last tag.                                                                                      |
| Behaviour did not change after editing ebalzan/ci        | Callers pin `@v2`: the change ships only once it is released and `v2` moves.                                                    |
| Work items: "unsupported type"                           | The branch prefix is not one of the types above. Rename the branch.                                                             |

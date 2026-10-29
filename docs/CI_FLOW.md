# CI/CD Flow (shared stages)

The branch → `dev` → `main` → release flow every repo using ebalzan/ci runs.
This file covers the stages this repo owns; what happens **after** a release
(a container rollout, a Vercel deploy, an app store build) and each repo's own
build/test checks belong to that repo, chained on the stages below.

> **Model:** feature branch → `dev` → `main`.
> `dev` is the integration branch. `main` is the release branch: it only
> receives the release PR.
>
> **Where the shared flow ends, for now:** at merging the release PR. Tagging
> `vX.Y.Z`, the GitHub Release and shipping are not shared stages yet.

---

## 1. Branching model

| Branch                          | Role                    | Receives merges from     | Protected |
| ------------------------------- | ----------------------- | ------------------------ | --------- |
| `main`                          | Releases                | `dev` only (release PR)  | Yes ¹     |
| `dev`                           | Integration of features | work branches (work PRs) | Yes ¹     |
| `feat/*`, `fix/*`, `chore/*`, … | Short-lived work        | (you push to them)       | No        |

Supported work-branch prefixes (each is also the PR's title type and label):
`feat`, `fix`, `docs`, `style`, `refact`, `perf`, `test`, `build`, `ci`,
`chore`, `revert` ([config/types.json](../config/types.json)). Any other prefix
fails both Auto PR and the PR check. A `refact/` branch takes a `refact:` title;
there is no `refactor` type, and no `feature/` or `hotfix/` alias.

¹ By the rulesets `bootstrap` applies: neither can be deleted, `main` cannot be
force-pushed, and an opt-in ruleset requires PRs ([REPO_RULES.md](REPO_RULES.md)).

---

## 2. The flow at a glance

```text
  feat/x ── git push
        │
        ▼
  (1) Auto PR                    auto-pr.yml (work branch)
        │  work PR: feat/x → dev (type label, assignee, milestone, board, AI description)
        ▼
  (2) PR Check: Work PR          pr-check.yml + the repo's own jobs
        │  ✅ squash-merge into dev
        ▼
  (3) Auto PR                    auto-pr.yml (push to dev)
        │  THE release PR: dev → main, "feat: release v1.4.0", git-cliff changelog
        ▼
  (2) PR Check: Release PR       pr-check.yml + the repo's own jobs
        │  ✅ squash-merge into main   ← by hand: the release approval
        ▼
       main
```

Each stage is a reusable workflow here, called from a thin file in the repo
that holds only the trigger, the permissions and the `uses:` line. Work PRs and
the release PR are the same machinery with different rules: one workflow opens
both (`auto-pr.yml` → `actions/auto-pr`), one checks both (`pr-check.yml` →
`actions/pr-check`).

---

## 3. Stage by stage

### Stage 1 — Auto PR (work branch)

- **Reusable workflow:** `.github/workflows/auto-pr.yml` → `actions/auto-pr`
- **Repo caller:** `.github/workflows/auto-pr.yml`, on `push` to any branch
  except `main` (never on tags), plus `workflow_dispatch`.
- **What it does** on a work branch: opens (or finds) its PR into `dev` as a
  draft — title from the first commit of the branch's type, body = the commit
  list — then puts on the type label, the pusher as assignee, the
  `AUTO_MILESTONE_TITLE` milestone and the `AUTO_PROJECT_NUMBER` board, has
  Claude Code write the description, and marks it ready for review. Every later
  push re-syncs the metadata and the description. No issue is created.
- **Token:** `GH_PROJECT_TOKEN` if present, else `github.token`. A classic PAT
  with the `project` scope is required to write to a user-owned board, and so
  that the opened PR triggers Stage 2.

### Stage 2 — PR Checks

- **Repo file:** `.github/workflows/pr-checks.yml`, on `pull_request` into
  `main` or `dev` (`opened`, `synchronize`, `reopened`, `ready_for_review`,
  and every metadata change: `edited`, `labeled`, `milestoned`, `assigned`, …).
- **Shared jobs** (`pr-check.yml` → `actions/pr-check`), one per PR kind; the
  other is skipped, as are drafts:
  - **Work PR** (head ≠ `dev`): commitlint on the title and every commit, then
    Danger: base is `dev`, branch is `<type>/<description>`, title type = branch
    type, exactly that type label, an assignee, an owner/member/collaborator
    author, the milestone and board when configured, a description. Warnings:
    over `AUTO_MAX_CHANGED_LINES`, a major release, behind `dev`.
  - **Release PR** (head = `dev`): the same commitlint steps, then Danger: base
    is `main`; the title is **exactly** the one Stage 3 computes for the PR's
    head (recomputed here, so a hand edit fails); the `release` label; an
    assignee, the milestone and board when configured, a description; `dev` not
    behind `main` (§4). Warning: a major
    release.
- **Repo jobs** (validate, build, image build, delivery preview, …) run in
  parallel beside them.
- The checks are reported as **`pr-check / Work PR`** and
  **`pr-check / Release PR`** — name the caller job `pr-check` (the template
  does). Those are the contexts the `ci: require pull request` ruleset
  requires; a skipped job counts as passed.

### Stage 3 — Auto PR (push to dev): the release PR

- **Same workflow and caller as Stage 1** — a push to `dev` (every squash-merge
  of a work PR) runs it in release mode (`actions/auto-pr/release-pr.sh`).
- **What it does:**
  1. If `dev` has no commits that are not on `main`, it stops.
  2. Computes the release with [git-cliff](https://git-cliff.org)
     (`config/cliff.toml`) from the commits since the last `vX.Y.Z` tag: the
     next version (§4) and a changelog grouped by type.
  3. Opens (or finds) the single `dev → main` PR and keeps its title on the
     release merging it cuts — `<type>[!]: release vX.Y.Z`, the type being the
     first among the released commits in `config/types.json` order (`feat`
     first), `!` when one is breaking (`scripts/release-title.mjs`). E.g.
     `fix: release v3.0.3`, `feat: release v3.1.0`, `feat!: release v4.0.0`.
  4. Same metadata as a work PR, with the `release` label instead of a type
     label; the description is Claude's summary above the git-cliff changelog
     (the changelog alone without `ANTHROPIC_API_KEY`).
- **Why that title:** the squash commit on `main` is titled from the PR, so its
  type carries the bump of everything it merges (§4), and the version is in
  plain sight. `chore(release): …` would not work: `chore` is a patch bump, and
  `chore(release):` is the conventional subject of a version-bump commit.
- **Token:** as Stage 1. ⚠️ With the default `GITHUB_TOKEN`, the opened release
  PR does not trigger Stage 2 until someone pushes to it.

---

## 4. Version bump rules (commit-scan)

The release PR's version is derived from **the Conventional Commits on `dev`
since the previous `vX.Y.Z` tag**, never from a branch name. Highest wins:

| Found in any commit since last tag                                                 | Bump          |
| ---------------------------------------------------------------------------------- | ------------- |
| `!` after type, or `BREAKING CHANGE:` footer                                       | `major`       |
| `feat:`                                                                            | `minor`       |
| `fix`, `perf`, `docs`, `style`, `refact`, `test`, `build`, `ci`, `chore`, `revert` | `patch`       |
| no Conventional Commit found                                                       | no release PR |

A breaking change in `0.x` still goes to `1.0.0`; a repo with no tag yet starts
at `v0.1.0`. git-cliff applies these rules (`config/cliff.toml`); only `vX.Y.Z`
tags count, so moving major tags (`v4`) are ignored.

> **Squash merges and `dev`.** Squash-merging the release PR gives `main` one
> new commit with `dev`'s content, so `dev` and `main` end up with identical
> content under unrelated histories. Until `dev` is pointed back at `main`, the
> next release PR re-merges everything from their last common ancestor, and the
> release PR check fails ("`main` has N commits that `dev` does not"). Tagging
> the merge on `main` and pointing `dev` at it is not automated yet; by hand:
> `git push --force-with-lease origin origin/main:dev` after tagging.

---

## 5. Developer flow (cheat sheet)

```bash
git checkout dev && git pull origin dev
git checkout -b feat/your-change
git commit -m "feat(search): add result filters"   # husky checks it
git push -u origin feat/your-change   # Stage 1 opens the PR into dev
# merge into dev (squash) once PR Checks pass
# Stage 3 opens/updates the release PR dev → main; merge it (squash) to release
```

You never edit the release PR's title, version or changelog by hand.

---

## 6. Troubleshooting

| Symptom                                                  | Likely cause / fix                                                                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow fails to start: "workflow was not found"        | Wrong `uses:` path or ref, or the repo's Actions policy does not allow actions from other repos (Settings → Actions → General).              |
| "The nested job is requesting 'X', but is only allowed…" | The caller's `permissions:` lacks what the reusable job declares. Grant it in the caller.                                                    |
| No PR after pushing a work branch                        | Branch was `main` (ignored), unsupported prefix, nothing ahead of `dev` yet, or `GH_PROJECT_TOKEN` missing/insufficient.                     |
| No release PR after merging into `dev`                   | The repo still has the old `promote-dev-to-main.yml` caller and an `auto-pr.yml` that ignores `dev`: re-run `ebalzan-ci onboard --force`.    |
| Release PR exists but no checks ran                      | Opened with the default `GITHUB_TOKEN`. Set `GH_PROJECT_TOKEN`, or push to it.                                                               |
| Release PR: "The title must be `…`"                      | The title was edited by hand, or the PR's head moved since Auto PR last ran. Push to `dev` or re-run Auto PR (`workflow_dispatch` on `dev`). |
| Release PR: "`main` has N commits that `dev` does not"   | `dev` was not pointed at `main` after the last release PR was merged (§4). Point it there.                                                   |
| Behaviour did not change after editing ebalzan/ci        | Callers pin a major tag (`@v4`): the change ships only once it is released and the tag moves.                                                |

# tracebim-ci

Shared GitHub Actions for the TraceBIM-CE repos (`tracebim-api`,
`tracebim-frontend`, `tracebim-frontend-mobile`): the workflows, scripts and
Actions config that are **the same in every repo**. Anything that differs per
repo — its build checks, its deploy, its board number, its deploy secrets —
stays in that repo, and every repo can override or add any variable or secret.

| Doc                                                                  | Covers                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------- |
| [docs/CI_FLOW.md](docs/CI_FLOW.md)                                   | branch → `dev` → `main` → release, stage by stage, bump rules |
| [docs/GITHUB_ACTIONS_SETUP.md](docs/GITHUB_ACTIONS_SETUP.md)         | where each value lives, shared vs repo layers, the bootstrap  |
| [docs/AUTO_WORK_ITEMS_WORKFLOW.md](docs/AUTO_WORK_ITEMS_WORKFLOW.md) | the issue/PR/project-board automation                         |
| [docs/COMMIT_GUIDE.md](docs/COMMIT_GUIDE.md)                         | commit conventions, PR titles, versioning                     |

## Layout

```text
.github/workflows/
  auto-work-items.yml       reusable  issue + PR + board card per feature branch
  pr-title.yml              reusable  Conventional Commit title + branch release type
  promote-dev-to-main.yml   reusable  the evergreen dev → main PR
  release.yml               reusable  semver bump, tag, GitHub Release, sync dev; outputs tag/sha
  self-*.yml                this repo's own flow: thin callers of the four above (README → Releasing)
actions/                    composite actions the reusable workflows run
  auto-work-items/          TypeScript src/ + committed dist/
  pr-title/  promote/  release/
scripts/release/            release-main, promote-dev-to-main, release-utils, verify-pr-release-type
managed/                    files repos' local tooling runs (the commit-msg validator)
renovate/tooling.json       shared Renovate preset: dev tooling on the same versions everywhere
config/
  actions.env               shared variables, read at run time (committed)
  secrets.env               shared repository secrets   (gitignored; .example committed)
  repos.env                 the repos --all acts on, and this repo's slug
bin/
  gh-bootstrap.sh           merge shared + repo config → push to GitHub
  gh-reset.sh               delete Actions config on a repo
  sync-managed.sh           refresh repos' optional local copies of managed/
```

## How a repo uses it

Each repo keeps **thin callers**: the trigger, the permissions, and `uses:`.
Triggers cannot live in a reusable workflow, and a reusable workflow can only
narrow the permissions its caller grants — so those two stay in the repo.

```yaml
# <repo>/.github/workflows/auto-pr.yml
name: Auto Create Work Items
on:
  push:
    branches-ignore: [main, dev]
    tags-ignore: ['**']
permissions:
  contents: read
  issues: write
  pull-requests: write
  repository-projects: write
jobs:
  work-items:
    uses: ebalzan/tracebim-ci/.github/workflows/auto-work-items.yml@v1
    with:
      runs-on: self-hosted
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      GH_PROJECT_TOKEN: ${{ secrets.GH_PROJECT_TOKEN }}
```

Secrets are passed by name, not with `secrets: inherit` (only guaranteed
within one organization or enterprise). Variables need no passing: inside a
reusable workflow, `vars` are the **caller repo's** variables.

Repo-specific work chains onto the shared jobs — e.g. a deploy after a release:

```yaml
jobs:
  release:
    uses: ebalzan/tracebim-ci/.github/workflows/release.yml@v1
  deploy:
    needs: release
    if: ${{ needs.release.outputs.tag != '' }}
    uses: ./.github/workflows/deploy.yml
    with:
      image_tag: ${{ needs.release.outputs.tag }}
```

Every input (`runs-on`, `base-branch`, `sync-dev`) and required permission is
documented in each workflow's header.

## Config: shared vs repo

```text
tracebim-ci/config/actions.env    +  <repo>/.github/actions.env       → variables (shared: read at run time)
tracebim-ci/config/secrets.env    +  <repo>/.github/secrets.env       → repository secrets
tracebim-ci/config/secrets.X.env  +  <repo>/.github/secrets.X.env     → environment X secrets
         shared (lower)                    repo (wins)
```

```bash
bin/gh-bootstrap.sh --all --dry-run   # shows each key as shared / repo / overrides / redundant
bin/gh-bootstrap.sh --all --prune     # push, and delete what no file defines any more
```

Shared **variables** are never copied onto repos: the actions read
`config/actions.env` from the tracebim-ci they run from (`@v1`) and fill what
the repo leaves unset, so a shared variable changes when v1 moves. Shared
**secrets** cannot be committed, so the bootstrap still merges them into every
repo — re-run it after changing one. Full rules:
[docs/GITHUB_ACTIONS_SETUP.md](docs/GITHUB_ACTIONS_SETUP.md).

## Managed files

Each repo's husky `commit-msg` hook runs
`managed/scripts/release/validate-conventional-subject.sh`. Preferred: the hook
runs it straight from the sibling checkout
(`${TRACEBIM_CI_DIR:-../tracebim-ci}`) and warns, without blocking, when that
checkout is absent — the shared PR-title check still enforces the rule on every
PR, and squash merges keep only the PR title. tracebim-api works this way and
keeps no copy.

A repo that wants the hook to work without the sibling checkout can keep a
verbatim copy at the same path (`bin/sync-managed.sh -C <repo> --install`);
this repo is private, so it cannot be npm-installed instead.
`bin/sync-managed.sh --all` refreshes existing copies, and the PR-title check
fails while one differs. Edit the file here, never in a repo.

## Dev tooling versions (Renovate)

`renovate/tooling.json` keeps Prettier, ESLint (with `@eslint/js`,
`typescript-eslint` and the Prettier plugin/config), lint-staged, husky and
TypeScript on the same versions in every repo. Each repo's `renovate.json`
extends it:

```json
{ "extends": ["github>ebalzan/tracebim-ci//renovate/tooling#v1"] }
```

- **What it opens:** every Monday, one `chore(deps): update dev tooling` PR
  into `dev` per repo (majors get a separate PR), from a `chore/renovate-*`
  branch so `pr-title` accepts it. Merge it like any other PR. Every other
  dependency is left alone.
- **Exceptions** go in the repo's own `renovate.json` as `allowedVersions`
  rules (e.g. `eslint` `<10` while `eslint-plugin-react` lacks ESLint 10
  support). A cap every repo needs (the `typescript` cap from
  `typescript-eslint`) lives in the preset.
- **Work items skip Renovate branches** (`auto-work-items.yml`), since Renovate
  owns those PRs' titles and bodies.
- **Setup:** install the Renovate GitHub App on this repo (it reads the preset
  from here) and every repo that extends it. Renovate reads each repo's
  `renovate.json` from its default branch, so it starts working once the file
  is promoted to `main`; a preset change reaches the repos when `v1` moves.

## One-time setup

1. Create the **private** repo `ebalzan/tracebim-ci` and push this checkout.
2. **Settings → Actions → General → Access** → _Accessible from repositories
   owned by the user 'ebalzan'_. Without it, every caller fails with "workflow
   was not found". Only repos **owned by `ebalzan`** can call a private repo's
   workflows — a repo in an organization cannot.
3. Seed `v1` once: `git tag v1.0.0 <sha> && git tag v1 <sha> && git push origin v1.0.0 v1`,
   where `<sha>` is any pushed commit that has `actions/`. This repo's own
   workflows run the actions at `@v1` (README → Releasing), so nothing runs
   until it exists; from then on every release moves it.
4. `cp config/secrets.env.example config/secrets.env`, fill it in.
5. `bin/gh-bootstrap.sh --all --dry-run`, then `--all --prune`; and
   `npm run gh:bootstrap` here, for this repo's own variables and secrets.
6. Branch protection: a required check named `Validate PR Title` is now
   reported as `title / Validate PR Title` — update the rule.

## Releasing a change

tracebim-ci runs the same feature → `dev` → `main` → release flow as the other
repos ([docs/CI_FLOW.md](docs/CI_FLOW.md)), through the `self-*.yml` callers.
They call the reusable workflows by local path (`./.github/workflows/…`)
instead of `ebalzan/tracebim-ci/…@v1`; everything else is the same.

```bash
git switch dev && git pull && git switch -c fix/your-change
git commit -m "fix(release): …" && git push -u origin fix/your-change
# Issue + PR into dev open; PR Checks = title + npm run check. Squash-merge.
# The dev → main PR opens. Squash-merge it: that is the release.
```

Merging into `main` releases `vX.Y.Z` and then **moves `v1`** to it
(`self-release.yml` → `major-tag`). Callers pin `@v1`, so that is the moment
the change reaches every repo; merge the promotion PR deliberately.

- **What runs which version.** A local `uses: ./…` runs the workflow file at
  the commit being built, but inside it the actions are still
  `ebalzan/tracebim-ci/actions/<name>@v1` — the last release. So a change to an
  action or a release script is checked by `npm run check` on its PR, and runs
  for real only after its own release. That is deliberate: a broken change
  cannot break the pipeline that ships its fix.
- **Breaking change** (a removed input, a new required secret, a new permission
  the callers must grant): mark it (`feat!:` / `BREAKING CHANGE:`). The release
  is `v2.0.0` and creates `v2`; `v1` stays on the last 1.x, so no repo changes.
  `major-tag` then warns that the internal refs still say `@v1`: open a PR
  switching them to `@v2` (it could not pass its checks before `v2` existed),
  which releases `v2.0.1` with consistent refs. Move each repo to `@v2` when
  ready.
- **Rollback:** `git tag -f v1 v1.3.0 && git push -f origin v1`.
- **Internal references.** The reusable workflows call this repo's actions as
  `ebalzan/tracebim-ci/actions/<name>@v1`. A reusable workflow cannot know the
  ref it was called at, and a private repo cannot be checked out with the
  caller's token, so the tag is written out. To try an unreleased branch in
  another repo, push a branch whose internal refs point at itself, and point
  one repo's caller at that branch.

## Adding a repo

1. Add its directory name to `REPOS` in `config/repos.env`.
2. Copy the thin callers from an existing repo; set `runs-on`.
3. Copy tracebim-api's `.husky/commit-msg`, which runs the validator from
   `../tracebim-ci` (see Managed files).
4. Give it `.github/actions.env` with only its own keys (at least
   `AUTO_PROJECT_NUMBER`) and `npm` scripts for the tools:
   ```json
   "gh:bootstrap": "bash ${TRACEBIM_CI_DIR:-../tracebim-ci}/bin/gh-bootstrap.sh --repo-dir .",
   "gh:reset": "bash ${TRACEBIM_CI_DIR:-../tracebim-ci}/bin/gh-reset.sh --repo-dir ."
   ```
5. `bin/gh-bootstrap.sh -C ../<repo> --dry-run`, then for real.

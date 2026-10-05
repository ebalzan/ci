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

## Layout

```text
.github/workflows/
  auto-work-items.yml       reusable  issue + PR + board card per feature branch
  pr-title.yml              reusable  Conventional Commit title + branch release type
  promote-dev-to-main.yml   reusable  the evergreen dev → main PR
  release.yml               reusable  semver bump, tag, GitHub Release, sync dev; outputs tag/sha
  ci.yml                    this repo's own checks
actions/                    composite actions the reusable workflows run
  auto-work-items/          TypeScript src/ + committed dist/
  pr-title/  promote/  release/
scripts/release/            release-main, promote-dev-to-main, release-utils, verify-pr-release-type
managed/                    files copied verbatim into every repo (bin/sync-managed.sh)
config/
  actions.env               shared variables            (committed)
  secrets.env               shared repository secrets   (gitignored; .example committed)
  repos.env                 the repos --all acts on, and this repo's slug
bin/
  gh-bootstrap.sh           merge shared + repo config → push to GitHub
  gh-reset.sh               delete Actions config on a repo
  sync-managed.sh           copy managed/ into the repos
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
tracebim-ci/config/actions.env    +  <repo>/.github/actions.env       → repository variables
tracebim-ci/config/secrets.env    +  <repo>/.github/secrets.env       → repository secrets
tracebim-ci/config/secrets.X.env  +  <repo>/.github/secrets.X.env     → environment X secrets
         shared (lower)                    repo (wins)
```

```bash
bin/gh-bootstrap.sh --all --dry-run   # shows each key as shared / repo / overrides / redundant
bin/gh-bootstrap.sh --all --prune     # push, and delete what no file defines any more
```

Personal accounts have no org-level Actions config, so "shared" means "merged
into every repo at sync time". Re-run after changing a shared value. Full
rules: [docs/GITHUB_ACTIONS_SETUP.md](docs/GITHUB_ACTIONS_SETUP.md).

## Managed files

The husky `commit-msg` hook in each repo runs
`scripts/release/validate-conventional-subject.sh` locally, offline. This repo
is private, so the repos cannot npm-install it in CI — instead
`bin/sync-managed.sh --all` copies everything under `managed/` into each repo,
and the shared PR-title check fails while a repo's copy differs. Edit the file
here, never in a repo.

## One-time setup

1. Create the **private** repo `ebalzan/tracebim-ci` and push this checkout.
2. **Settings → Actions → General → Access** → _Accessible from repositories
   owned by the user 'ebalzan'_. Without it, every caller fails with "workflow
   was not found". Only repos **owned by `ebalzan`** can call a private repo's
   workflows — a repo in an organization cannot.
3. Tag the first release: `git tag v1.0.0 && git tag v1 && git push origin v1.0.0 v1`.
4. `cp config/secrets.env.example config/secrets.env`, fill it in.
5. `bin/gh-bootstrap.sh --all --dry-run`, then `--all --prune`.
6. Branch protection: a required check named `Validate PR Title` is now
   reported as `title / Validate PR Title` — update the rule.

## Releasing a change

Callers pin `@v1`, a **moving** tag. A change reaches the repos only when `v1`
moves, so `main` can hold unreleased work safely.

```bash
npm run check                              # build + dist committed + syntax
git tag v1.4.0 && git push origin v1.4.0   # immutable, for rollback
git tag -f v1 && git push -f origin v1     # ship it to every repo
```

- **Breaking change** (a removed input, a new required secret, a new permission
  the callers must grant): tag `v2.0.0` + `v2`, update the internal `@v1`
  references (below) to `@v2`, and move each repo to `@v2` when ready.
- **Rollback:** `git tag -f v1 v1.3.0 && git push -f origin v1`.
- **Internal references.** The reusable workflows call this repo's actions as
  `ebalzan/tracebim-ci/actions/<name>@v1`. A reusable workflow cannot know the
  ref it was called at, and a private repo cannot be checked out with the
  caller's token, so the tag is written out. To try an unreleased branch, push
  a branch whose internal refs point at itself, and point one repo's caller at
  that branch.

## Adding a repo

1. Add its directory name to `REPOS` in `config/repos.env`.
2. Copy the thin callers from an existing repo; set `runs-on`.
3. `bin/sync-managed.sh -C ../<repo>` and point its husky `commit-msg` hook at
   `scripts/release/validate-conventional-subject.sh`.
4. Give it `.github/actions.env` with only its own keys (at least
   `AUTO_PROJECT_NUMBER`) and `npm` scripts for the tools:
   ```json
   "gh:bootstrap": "bash ${TRACEBIM_CI_DIR:-../tracebim-ci}/bin/gh-bootstrap.sh --repo-dir .",
   "gh:reset": "bash ${TRACEBIM_CI_DIR:-../tracebim-ci}/bin/gh-reset.sh --repo-dir ."
   ```
5. `bin/gh-bootstrap.sh -C ../<repo> --dry-run`, then for real.

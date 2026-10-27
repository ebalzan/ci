# Commit Guide

## Purpose

This guide defines the commit conventions every repo using ebalzan/ci follows and how
commits fit into the branch workflow. The full pipeline, stage by stage, is in
[CI_FLOW.md](CI_FLOW.md).

## Workflow Context

- The model is work branch → `dev` → `main`. Both `dev` and `main` are long-lived.
- Work happens on short-lived branches (`feat/*`, `fix/*`, `docs/*`, …) cut from `dev`.
- Work PRs target `dev` and are squash-merged.
- `main` only receives the automated `dev` → `main` promotion PR.
- Every push to `main` creates a release (and the repo ships it), then
  force-points `dev` at the release commit.

## Commit Message Format

Use Conventional Commits:

```text
<type>(<scope>): <description>
```

Examples:

```bash
feat(auth): add oauth login
fix(uploads): reject invalid status changes
docs(readme): update setup section
ci(actions): add pr checks workflow
```

The rule is `managed/scripts/release/validate-conventional-subject.sh` in
ebalzan/ci. Each Node repo's husky `commit-msg` hook runs it through the npm
package (`ebalzan-ci commit-msg`), and the shared PR-title check runs it on
every PR in CI — so repos without the hook are checked too, at PR time.

## Allowed Types

- `feat`: new feature
- `fix`: bug fix
- `docs`: documentation changes
- `style`: formatting/style-only changes
- `refact`: code restructuring without behavior change (there is no `refactor`)
- `perf`: performance improvement
- `test`: tests added/updated
- `build`: build/tooling changes
- `ci`: CI/CD changes
- `chore`: maintenance tasks
- `revert`: revert previous commit

Branch prefixes are the same types (`refact/…`); there is no `feature/` or
`hotfix/`.

## Practical Rules

1. Keep `type` and `scope` lowercase.
2. Use imperative description (`add`, `fix`, `update`).
3. Do not end description with a period.
4. Prefer specific scope names: the module or area touched (`auth`,
   `uploads`, `api`, `db`, `actions`, `deps`).
5. Keep the header at 72 characters or fewer.

## Typical Developer Flow

```bash
# 1) Branch from dev
git switch dev
git pull origin dev
git switch -c feat/your-change

# 2) Commit with conventional format
git add .
git commit -m "feat(search): add result filters"

# 3) Push: the work-items workflow opens a PR into dev with a tracking issue
git push -u origin feat/your-change
```

## Release Notes and Versioning

Release notes and semantic versioning are automatic.

- A push to `main` runs the repo's `release.yml`, which calls this repo's
  reusable `release.yml`.
- The bump is computed by scanning every Conventional Commit since the previous
  tag. Branch names don't affect it, and if no commit is conventional the release
  fails.
- With a `package.json`, it updates it (and the lockfile) to the release
  version and commits `chore(release): <version>`. The workflow skips commits
  with that prefix, so the release commit doesn't trigger another release.
  Without one, the release is the tag alone.
- It creates tag `vX.Y.Z` and a GitHub Release; the repo then ships that tag.
- It force-points `dev` at the release commit. If a later `git pull` on `dev`
  conflicts, run `git reset --hard origin/dev` and branch from there.
- `PR Checks` validates PR titles so squash merges always produce a conventional commit.

Never bump the version, create a tag, or write a `chore(release):` commit by hand.

Version impact by commit convention:

- `feat` -> `minor`
- `fix`, `perf`, `docs`, `style`, `refact`, `test`, `build`, `ci`, `chore`, `revert` -> `patch`
- `BREAKING CHANGE` (or `!`) -> `major`

## PR Titles and Squash Merges

GitHub squash merge uses the PR title as the commit title.

- keep PR titles in Conventional Commit format
- make the PR title match the release impact implied by the branch type (`feat` -> `minor`; every other supported type -> `patch`)
- if the change is breaking, mark the PR title with `!` to force a `major` release, for example `feat(api)!: remove legacy endpoint`
- the `dev` → `main` promotion PR is titled automatically from the promoted commits; it only needs to stay a valid Conventional Commit

## Troubleshooting

### Invalid commit message

Use the required format:

```text
type(scope): description
```

### Committed to wrong branch

Prefer safe history-preserving fixes:

- `git cherry-pick` to move commit
- `git revert` to undo shared commits
- Avoid `git reset --hard` on shared branches

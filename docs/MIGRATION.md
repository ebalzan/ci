# Migrating from `tracebim-ci` v1 to `ebalzan/ci` v2

v2 is the same pipeline under a new name, made generic and public:

| v1 (`ebalzan/tracebim-ci`, private)                                | v2 (`ebalzan/ci`, public, `@ebalzan/ci` on npm)                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `uses: ebalzan/tracebim-ci/.github/workflows/X.yml@v1`             | `uses: ebalzan/ci/.github/workflows/X.yml@v2`                                   |
| Only repos owned by `ebalzan` could call it                        | Any repo can call it                                                            |
| Hook ran `../tracebim-ci/managed/…` (or a synced copy)             | Hook runs `ebalzan-ci commit-msg` from the npm devDependency                    |
| `bash ../tracebim-ci/bin/gh-bootstrap.sh --repo-dir .`             | `npx ebalzan-ci bootstrap`                                                      |
| `REPOS=` checkout names next to the CI checkout                    | Repos tagged `ebalzan-ci`, plus optional `OWNER/REPO` slugs                     |
| Shared `AUTO_MILESTONE_TITLE=oct-26`, `AUTO_PROJECT_OWNER=ebalzan` | Removed: a milestone is per project; the board owner defaults to the repo owner |
| No board configured → the work-items run failed (strict mode)      | No board configured → the board step is skipped                                 |
| Release needed `package.json` + `package-lock.json`                | Tag-only release without `package.json`; any lockfile                           |
| Settings and branch protection by hand                             | `bootstrap` applies `repo-settings.json` and `rulesets/`                        |
| `TRACEBIM_CI_DIR`, `TRACEBIM_REPOS_ROOT`                           | `CI_DIR`, `CI_REPOS_ROOT` (the old `TRACEBIM_REPOS_ROOT` still works)           |

Repos stay on v1 until they change their `uses:` lines: `v1` is never moved
again, so nothing breaks on its own.

---

## Part 1 — cutting v2 (this repo, once)

The code is ready on the `feat/generic-ci` branch. The GitHub side, in this
order:

1. **Rename** the repo, then point your checkout at the new name:

   ```bash
   gh repo rename ci -R ebalzan/tracebim-ci
   git remote set-url origin git@github.com:ebalzan/ci.git
   ```

   Tags move with the repo, so `ebalzan/ci/actions/<name>@v1` resolves right
   away — this repo's own workflows rely on that until step 5. GitHub redirects
   the old name for git and the web; do not rely on the redirect for `uses:` in
   the caller repos — migrate them (Part 2).

2. **Make it public.** The history was scanned for credentials before this
   change: the only key-shaped string is the `sk-ant-xxxx…` placeholder in
   `config/secrets.env.example`; `config/secrets.env` was never committed. To
   re-check: `gitleaks git .` (or `git log --all -p | grep -E 'sk-ant-[A-Za-z0-9]{20}|ghp_[A-Za-z0-9]{30}'`).

   ```bash
   gh repo edit ebalzan/ci --visibility public --accept-visibility-change-consequences
   gh api -X PUT repos/ebalzan/ci/private-vulnerability-reporting   # SECURITY.md points here
   ```

3. **Push the branch.** `self-auto-pr.yml` opens the PR into `dev`:

   ```bash
   git push -u origin feat/generic-ci
   ```

   **Retitle the PR** `feat!: make the CI repo generic and public (ebalzan/ci)`
   — the `!` is what makes the release `v2.0.0` instead of `v1.3.0`. The title
   check accepts `!` on a `feat/` branch.

4. **Squash-merge** it into `dev`, then squash-merge the `dev → main` PR that
   appears (titled `feat!: promote dev to main (v2.0.0)`). The release creates
   `v2.0.0` and the `v2` tag, and warns that the internal refs still say `@v1`.
   That is expected.

5. **Point the internal refs at v2** (a PR naming `@v2` could not pass its
   checks before `v2` existed):

   ```bash
   git switch dev && git pull
   git switch -c ci/internal-refs-v2
   sed -i 's#\(ebalzan/ci/actions/[a-z-]*\)@v1#\1@v2#' .github/workflows/*.yml
   sed -i 's#renovate/tooling\#v1#renovate/tooling\#v2#' renovate.json
   git commit -am "ci: point internal refs at v2" && git push -u origin ci/internal-refs-v2
   ```

   Merge it and its promotion PR: `v2.0.1`, with consistent refs.

6. **Apply the rules to this repo** (now public, so the rulesets apply too):

   ```bash
   npm run gh:bootstrap -- --dry-run
   npm run gh:bootstrap -- --prune
   gh repo edit ebalzan/ci --add-topic ebalzan-ci     # optional: include it in --all
   ```

7. **Publish to npm** — see [CONTRIBUTING.md → Publishing to
   npm](../CONTRIBUTING.md#publishing-to-npm): one manual `npm publish`, then
   trusted publishing and `NPM_PUBLISH=true` for every later release.

8. **Optional:** rename the local checkout to match (`mv tracebim-ci ci`).
   Hooks in repos not migrated yet look for `../tracebim-ci`; until they are,
   they warn instead of checking (CI still checks), or set
   `TRACEBIM_CI_DIR=../ci`.

9. **Release `@ebalzan/config` 0.2.0**, which drops its copy of the commit rule
   (the hook and the PR-title check use `@ebalzan/ci`'s). In its checkout, merge
   the `refact/move-commit-rules-to-ci` branch into `main`, then
   `npm version minor && git push --follow-tags` (its `publish.yml` publishes
   the tag).

---

## Part 2 — moving a repo to v2

For each repo (e.g. `tracebim-api`), on a `ci/…` branch:

1. **Workflow refs:**

   ```bash
   sed -i 's#ebalzan/tracebim-ci/#ebalzan/ci/#; s#\(ebalzan/ci/[^@]*\)@v1#\1@v2#' .github/workflows/*.yml
   sed -i 's#github>ebalzan/tracebim-ci//renovate/tooling\#v1#github>ebalzan/ci//renovate/tooling\#v2#' renovate.json
   grep -rn 'uses: .*tracebim-ci\|tracebim-ci//' .github/workflows renovate.json   # must print nothing
   grep -rn 'tracebim-ci' .github/workflows   # only comments left: reword them
   ```

2. **Variables the shared file no longer sets.** If the repo used the shared
   milestone, add it to the repo's `.github/actions.env`:

   ```dotenv
   AUTO_MILESTONE_TITLE=oct-26
   ```

   `AUTO_PROJECT_OWNER` now defaults to the repo owner, which was the old shared
   value for repos owned by `ebalzan` — nothing to do there.

3. **Hook and scripts** (Node repos):

   ```bash
   npm install --save-dev @ebalzan/ci
   npx ebalzan-ci path   # check it is installed
   ```

   Replace `.husky/commit-msg` with [templates/.husky/commit-msg](../templates/.husky/commit-msg)
   (placeholders: `ebalzan/ci`, `ci`, `@ebalzan/ci`), and delete any local copy
   of `scripts/release/validate-conventional-subject.sh`.

   **Remove the `gh:bootstrap` and `gh:reset` npm scripts.** In v2 the admin
   commands run from your ebalzan/ci checkout (`npm run gh:bootstrap -- -R
owner/repo` or `--all`) or with `npx @ebalzan/ci bootstrap`, so the repo
   needs none ([ARCHITECTURE.md §6–7](ARCHITECTURE.md#6-packagejson)).

   Repo scripts that sourced `${TRACEBIM_CI_DIR:-../tracebim-ci}/bin/_lib.sh`
   become `source "$(npx --no-install ebalzan-ci path)/bin/_lib.sh"`.

   **Code style:** adopt [`@ebalzan/config`](https://www.npmjs.com/package/@ebalzan/config)
   (≥ 0.2.0, which no longer has a commit rule of its own). For a repo whose
   `.prettierrc.json` already holds the shared options, that is
   `npm install --save-dev --save-exact @ebalzan/config`, deleting
   `.prettierrc.json`, setting `"prettier": "@ebalzan/config/prettier"`, and
   replacing the shared part of `eslint.config.*` with
   `...node` from `@ebalzan/config/eslint/node` (keep the repo's own ignores
   and blocks). `npx ebalzan-config verify` confirms it.

   **Secrets (optional, recommended):** move the repo's `.github/secrets*.env`
   into `~/.config/ebalzan-ci/repos/<owner>/<repo>/`. Local scripts that read
   those files (via `LOCAL_ONLY_KEYS`) must then read them from there too, so
   move a repo with such scripts last, or leave its secrets in the checkout.

4. **Topic**, so `--all` finds the repo: `gh repo edit owner/repo --add-topic ebalzan-ci`.

5. **Bootstrap** and read the plan — v2 adds repository settings (squash only,
   PR-title commit subjects, delete merged branches) and rulesets:

   ```bash
   npx ebalzan-ci bootstrap --dry-run
   npx ebalzan-ci bootstrap
   ```

   A private repo on the free plan skips the rulesets with a warning.

6. Commit as `ci: move to ebalzan/ci v2`, push, merge. Done when the PR's
   `title / Validate PR Title` check runs from `ebalzan/ci@v2`.

`--all` finds a repo by its topic from step 4 on; v2 ships with an empty
`REPOS` list in `config/repos.env`.

# Repository settings and branch rulesets

The workflows enforce the flow inside CI. These two files enforce it on GitHub
itself, the same way on every repo: `ebalzan-ci bootstrap` applies them
alongside the variables and secrets.

```text
config/repo-settings.json          +  <repo>/.github/repo-settings.json       → PATCH /repos/{repo}
config/rulesets/<file>.json        +  <repo>/.github/rulesets/<file>.json     → repo rulesets, matched by "name"
        shared                               repo (deep-merged over it, wins)
```

Both are plain GitHub REST payloads, so anything the API accepts can go in
them. Keys starting with `$` (like `"$comment"`) are documentation and are
never sent.

---

## Repository settings

`config/repo-settings.json`:

| Setting                       | Value             | Why                                                                                                                                                                 |
| ----------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow_squash_merge`          | `true`            | The only merge method. One PR = one commit = one Conventional Commit on the target branch.                                                                          |
| `allow_merge_commit`          | `false`           | A merge commit is not a Conventional Commit, and it would carry unrelated history into `main`.                                                                      |
| `allow_rebase_merge`          | `false`           | Replays every branch commit; each would need to be conventional, and the PR title would not be the subject.                                                         |
| `squash_merge_commit_title`   | `PR_TITLE`        | **Important.** GitHub's default (`COMMIT_OR_PR_TITLE`) uses the _commit_ subject for a single-commit PR, bypassing the PR-title check that guards the release bump. |
| `squash_merge_commit_message` | `COMMIT_MESSAGES` | The branch's commit messages go in the body, so a `BREAKING CHANGE:` footer still reaches the release scan.                                                         |
| `delete_branch_on_merge`      | `true`            | Work branches are short-lived; the tracking issue keeps the history.                                                                                                |
| `allow_update_branch`         | `true`            | Offers "Update branch" on PRs that fall behind `dev`.                                                                                                               |

`bootstrap --dry-run` lists only the keys whose current value differs:

```text
==> Repository settings to change
    allow_rebase_merge             true → false
    squash_merge_commit_title      "COMMIT_OR_PR_TITLE" → "PR_TITLE"
```

To change one for a single repo, put just that key in its
`.github/repo-settings.json`:

```json
{ "delete_branch_on_merge": false }
```

---

## Branch rulesets

| File                        | Ruleset name               | Default      | Rules                                                                                      |
| --------------------------- | -------------------------- | ------------ | ------------------------------------------------------------------------------------------ |
| `protect-main.json`         | `ci: protect main`         | **active**   | `main` cannot be deleted or force-pushed.                                                  |
| `protect-dev.json`          | `ci: protect dev`          | **active**   | `dev` cannot be deleted.                                                                   |
| `require-pull-request.json` | `ci: require pull request` | **disabled** | Changes to `main`/`dev` only by squash-merged PR with `title / Validate PR Title` passing. |

### Why `dev` can still be force-pushed

`release.yml`'s `sync-dev` job force-points `dev` at every release commit (the
squash merge into `main` leaves `dev` with the same content under unrelated
history; see [CI_FLOW.md §4](CI_FLOW.md#4-version-bump-rules-commit-scan)). A
`non_fast_forward` rule on `dev` would break every release. The test suite
fails if an active ruleset adds one.

### Why "require pull request" ships disabled

The release job pushes the `chore(release): X.Y.Z` commit straight to `main`
and force-points `dev`, both as `github-actions[bot]` (`GITHUB_TOKEN`). With
PRs required, those pushes need a bypass. The ruleset lists two bypass actors:

| Actor                        | Id      | Why                              |
| ---------------------------- | ------- | -------------------------------- |
| `RepositoryRole` admin       | `5`     | You, for emergencies.            |
| `Integration` GitHub Actions | `15368` | The release and sync-dev pushes. |

Whether GitHub honours the GitHub Actions app as a bypass actor depends on the
account type and plan, so it is off until you have seen it work. To turn it on
for one repo:

```bash
mkdir -p .github/rulesets
echo '{ "enforcement": "active" }' > .github/rulesets/require-pull-request.json
ebalzan-ci bootstrap --skip vars,secrets
```

Then merge a promotion PR and check that the release run pushed its commit and
synced `dev`. If it was rejected, set the file back to `"disabled"` and
re-run the bootstrap. Once it works on your setup, flip `enforcement` in
`config/rulesets/require-pull-request.json` itself to roll it out everywhere.

### Plans

Rulesets are free on **public** repos. On **private** repos they need GitHub
Pro (personal accounts) or Team (organizations); otherwise GitHub answers
"Upgrade to GitHub Pro or make this repository public" and `bootstrap` warns
and skips the step, leaving the rest of the sync intact.

### Adding, overriding, removing

- **Override** a shared ruleset in one repo: a file with the **same file name**
  in `.github/rulesets/`, containing only the keys to change. Arrays (such as
  `rules` or `conditions.ref_name.include`) are replaced whole.
- **Add** a ruleset to one repo: any new file name in `.github/rulesets/`. Give
  it a `"name"` starting with `ci: ` if you want `--prune` to manage it.
- **Add** one for every repo: a new file in `config/rulesets/`, then a release.
- **Remove** a shared one from one repo: override it with
  `{ "enforcement": "disabled" }`.
- **Delete** one everywhere: remove its file, then `ebalzan-ci bootstrap --all
--prune`. Pruning only ever deletes repo rulesets whose name starts with
  `ci: `; rulesets you made by hand under other names are never touched.

Rulesets are matched to GitHub by `name`: renaming one in a file creates a new
ruleset and leaves the old one until `--prune`.

Reference for the payload: [GitHub REST — repository rulesets](https://docs.github.com/en/rest/repos/rules).

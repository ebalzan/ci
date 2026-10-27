# Onboarding a repo

Two ways: one command, or by hand. Both end in the same state.

- [Before the first repo](#before-the-first-repo)
- [With `onboard`](#with-onboard)
- [By hand](#by-hand)
- [What each generated file is for](#what-each-generated-file-is-for)
- [After onboarding](#after-onboarding)
- [Troubleshooting](#troubleshooting)

---

## Before the first repo

Once per machine:

1. **GitHub CLI**, logged in as an account with **admin** on the repos:
   `gh auth login`. If you will use Projects (v2) boards, also
   `gh auth refresh -s project`.
2. **Node.js ≥ 20**, git and bash.
3. **Shared secrets** in `~/.config/ebalzan-ci/secrets.env` (or any directory,
   with `CI_SECRETS_DIR` pointing at it):

   ```dotenv
   ANTHROPIC_API_KEY=sk-ant-...   # optional: AI-written issue/PR descriptions
   GH_PROJECT_TOKEN=ghp_...       # recommended: classic PAT, scopes repo + project
   ```

   [config/secrets.env.example](../config/secrets.env.example) explains each one,
   and [CONFIGURATION.md](CONFIGURATION.md#secrets) explains why the token must be
   classic.

---

## With `onboard`

From a clean checkout of the repo:

```bash
npx @ebalzan/ci onboard --dry-run
```

```text
Onboard   owner/my-repo  ←  ebalzan/ci@v2 (runs-on: ubuntu-latest)

  files (branch ci/onboard-ebalzan-ci from origin/main)
    create     .github/actions.env
    create     .github/workflows/auto-pr.yml
    create     .github/workflows/pr-checks.yml
    create     .github/workflows/promote-dev-to-main.yml
    create     .github/workflows/release.yml
    create     .husky/commit-msg
    create     renovate.json
  npm
    install --save-dev @ebalzan/ci@^2.0.0 (and husky, if missing)
  GitHub (owner/my-repo)
    create branch dev from origin/main
    add topic 'ebalzan-ci'
    bootstrap: variables, secrets, settings, rulesets
    push ci/onboard-ebalzan-ci → auto-pr.yml opens the PR into dev
```

If the plan looks right, run it without `--dry-run`. It asks once before
touching GitHub, and the bootstrap asks once more before pushing config.

Useful options: `--runs-on self-hosted` for self-hosted runners, `--no-push`
to only make the local commit (inspect it with `git show --stat`, push it
yourself later), `--force` to replace files the repo already has. All options:
[CLI.md](CLI.md#onboard).

**Existing files are kept.** If the repo already has, say, a `release.yml`,
`onboard` leaves it and says so; compare it with
[templates/](../templates/.github/workflows/) and merge by hand, or re-run with
`--force` on a fresh branch.

---

## By hand

1. **Branches.** Create `dev` from the default branch, and make `main` the
   default branch if it is not.
2. **Workflows.** Copy the four files in
   [templates/.github/workflows/](../templates/.github/workflows/) into the
   repo's `.github/workflows/`, replacing `__CI_REPO__` with `ebalzan/ci`,
   `__CI_REF__` with `v2` and `__RUNS_ON__` with your runner label.
3. **Variables.** Copy [templates/.github/actions.env](../templates/.github/actions.env)
   to `.github/actions.env` and set what the repo needs (often nothing, or just
   `AUTO_PROJECT_NUMBER`). Gitignore `.github/secrets*.env`.
4. **Hook** (Node repos): `npm install --save-dev @ebalzan/ci husky`, add
   `"prepare": "husky"` to `scripts`, and copy
   [templates/.husky/commit-msg](../templates/.husky/commit-msg) to
   `.husky/commit-msg` (fill `__CI_REPO__`, `__CI_REPO_NAME__`, `__CI_PACKAGE__`).
5. **Renovate** (optional): install the [Renovate app](https://github.com/apps/renovate)
   on the repo and commit `renovate.json` extending
   `github>ebalzan/ci//renovate/tooling#v2`.
6. **Topic:** `gh repo edit owner/my-repo --add-topic ebalzan-ci`, so `--all`
   finds it.
7. **Config:** `npx @ebalzan/ci bootstrap --dry-run`, then without `--dry-run`.
8. Push on a `ci/…` branch and merge the PR.

---

## What each generated file is for

| File                                        | Runs on                   | Does                                                                                                      |
| ------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `.github/workflows/auto-pr.yml`             | push to any work branch   | Tracking issue + PR into `dev` + board card. [Details](AUTO_WORK_ITEMS_WORKFLOW.md)                       |
| `.github/workflows/pr-checks.yml`           | PRs into `dev` and `main` | The shared title check, plus **your** build/test jobs — add them here.                                    |
| `.github/workflows/promote-dev-to-main.yml` | push to `dev`             | Opens/updates the single `dev → main` PR.                                                                 |
| `.github/workflows/release.yml`             | push to `main`            | Bump, tag, GitHub Release, sync `dev` — plus **your** deploy job, chained on `needs.release.outputs.tag`. |
| `.github/actions.env`                       | `bootstrap`               | The repo's own variables.                                                                                 |
| `.husky/commit-msg`                         | every local commit        | Rejects non-conventional messages early. Never blocks when the package is missing.                        |
| `renovate.json`                             | Renovate, weekly          | One `chore(deps): update dev tooling` PR into `dev`.                                                      |

---

## After onboarding

- **Add the repo's own checks** to `pr-checks.yml` — the template has a
  commented `check` job. They run in parallel with `title`.
- **Add the deploy** to `release.yml` — the template has a commented `deploy`
  job. Gate it with `if: needs.release.outputs.tag != ''`.
- **A board?** Set `AUTO_PROJECT_NUMBER` in `.github/actions.env` and re-run
  `ebalzan-ci bootstrap`. The board needs the fields listed in
  [CONFIGURATION.md](CONFIGURATION.md#project-board).
- **Repo-specific values** (deploy hosts, keys) go in the repo's
  `.github/secrets.<environment>.env` — see
  [GITHUB_ACTIONS_SETUP.md](GITHUB_ACTIONS_SETUP.md).
- **Not a Node repo?** Releases work tag-only (no version commit). There is no
  husky hook; the PR-title check still enforces the convention on every merge.

---

## Troubleshooting

| Symptom                                                  | Cause / fix                                                                                                                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `… has uncommitted changes`                              | Commit or stash first; onboarding always works on a fresh branch.                                                                                                                                                                     |
| `Branch ci/onboard-ebalzan-ci already exists`            | A previous run left it. `git branch -D ci/onboard-ebalzan-ci` or pass `--branch`.                                                                                                                                                     |
| `Could not install @ebalzan/ci`                          | No network, or a version that is not published. The hook skips the local check until it is installed; CI still checks.                                                                                                                |
| No PR appeared after the push                            | Open the Actions tab: `Auto Create Work Items` failed or did not run. Check the repo allows actions from other repositories (Settings → Actions → General → "Allow all actions"). Open the PR from the compare URL `onboard` printed. |
| `workflow was not found` / `… is not allowed to be used` | The repo's Actions policy blocks `ebalzan/ci`. Allow all actions, or add `ebalzan/ci/*` to the allowed list.                                                                                                                          |
| `Rulesets are not available … skipped`                   | Private repo on the free plan. Everything else was applied. [REPO_RULES.md](REPO_RULES.md#plans)                                                                                                                                      |
| PR checks did not run on the bot's PR                    | Opened with `GITHUB_TOKEN` because `GH_PROJECT_TOKEN` is not set. Set it, or push to the PR.                                                                                                                                          |

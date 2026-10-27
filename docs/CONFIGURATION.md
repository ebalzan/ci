# Configuration reference

Every knob, its default, and who reads it. For _where_ a value should live
(variable or secret, repository or environment) read
[GITHUB_ACTIONS_SETUP.md](GITHUB_ACTIONS_SETUP.md); for settings and rulesets,
[REPO_RULES.md](REPO_RULES.md).

- [The layers](#the-layers)
- [Actions variables](#actions-variables)
- [Secrets](#secrets)
- [Workflow inputs](#workflow-inputs)
- [Config files](#config-files)

---

## The layers

```text
                     SHARED (lower precedence)                  REPO (wins)
Actions variables    config/actions.env                    +    .github/actions.env
repository secrets   <shared secrets dir>/secrets.env      +    .github/secrets.env
environment secrets  <shared secrets dir>/secrets.<env>.env +   .github/secrets.<env>.env
repository settings  config/repo-settings.json             +    .github/repo-settings.json
branch rulesets      config/rulesets/<file>.json           +    .github/rulesets/<file>.json
```

- **Variables** — the shared file is part of this package and is read **at run
  time** by the actions, from the version the caller pins (`@v2`). Only the
  repo's own keys are pushed to GitHub, by `ebalzan-ci bootstrap`.
- **Secrets** — merged at sync time by `bootstrap`. The shared secrets dir is
  `$CI_SECRETS_DIR`, else `config/` in a git checkout of this repo, else
  `~/.config/ebalzan-ci/`.
- **Settings and rulesets** — JSON, deep-merged by `bootstrap`: objects merge
  key by key, arrays are replaced whole. Top-level keys starting with `$` are
  comments.

A repo **inherits** a shared key by not mentioning it, **overrides** it by
setting the same key, and **adds** any key of its own. An empty repo variable
counts as unset, so it cannot blank out a shared value — override it with a
real one.

---

## Actions variables

All optional. Set them in a repo's `.github/actions.env` (then `ebalzan-ci
bootstrap`), or for every repo in `config/actions.env` (then a release of this
repo). The workflows pass the caller's variables whole
(`REPO_VARS_JSON: ${{ toJSON(vars) }}`), so a new key needs no workflow edit;
only `AUTO_*` keys are read.

### Project board

| Variable                       | Default          | Read by             | Meaning                                                                                                                               |
| ------------------------------ | ---------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTO_PROJECT_NUMBER`          | unset → no board | work items, promote | Projects (v2) board number (the `N` in `/users/me/projects/N`). One board per repo is typical.                                        |
| `AUTO_PROJECT_OWNER`           | the repo owner   | work items, promote | Account or organization owning the board.                                                                                             |
| `AUTO_STRICT_METADATA`         | `true`           | work items          | With a board configured: fail the run when the board, a field or an option is missing. `false` only warns. No effect without a board. |
| `AUTO_START_DATE_OFFSET_DAYS`  | `0`              | work items          | `Start date` = today + N days.                                                                                                        |
| `AUTO_TARGET_DATE_OFFSET_DAYS` | `7`              | work items          | `Target date` = today + N days.                                                                                                       |

The board needs the fields `Start date`, `Target date`, `Priority`
(single-select with options `P0`…`P4`), `Estimate` and `Size` (looked up by
name, case-insensitive). See [AUTO_WORK_ITEMS_WORKFLOW.md](AUTO_WORK_ITEMS_WORKFLOW.md#project-v2-behavior).

### Priority, size, estimate

| Variable                 | Default (shared file)                                                                               | Meaning                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `AUTO_PRIORITY_MAP_JSON` | unset → per type: `fix perf revert` P1, `feat refact` P2, `docs test build ci` P3, `style chore` P4 | `{"<type>": "P<n>"}` override per branch type.                          |
| `AUTO_DEFAULT_PRIORITY`  | unset                                                                                               | Priority for types the map does not list (before the per-type default). |
| `AUTO_SIZE_MAP_JSON`     | `feat refact perf` M, the rest S                                                                    | `{"<type>": "<size option>"}`.                                          |
| `AUTO_DEFAULT_SIZE`      | `M`                                                                                                 | Size for types the map does not list.                                   |
| `AUTO_ESTIMATE_MAP_JSON` | `feat` 3, `fix refact perf` 2, the rest 1                                                           | `{"<type>": "<number>"}`.                                               |
| `AUTO_DEFAULT_ESTIMATE`  | `1`                                                                                                 | Estimate for types the map does not list.                               |

### Labels and milestone

| Variable                | Default | Meaning                                                                                                |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `AUTO_ISSUE_LABELS`     | unset   | Extra labels for every tracking issue (comma-separated). Type labels are reserved and filtered out.    |
| `AUTO_PR_LABELS`        | unset   | Extra labels for every work PR.                                                                        |
| `AUTO_MILESTONE_TITLE`  | unset   | Milestone (exact title, case-insensitive) put on work issues/PRs and the promotion PR.                 |
| `AUTO_MILESTONE_NUMBER` | unset   | Milestone by number; takes precedence over the title for work items (the promotion PR uses the title). |

### Descriptions

| Variable               | Default             | Meaning                                                                            |
| ---------------------- | ------------------- | ---------------------------------------------------------------------------------- |
| `AUTO_DESCRIBE_MODEL`  | `claude-sonnet-5-5` | Claude model that writes issue/PR descriptions from the branch's commits and diff. |
| `AUTO_DESCRIBE_EFFORT` | `low`               | `low` · `medium` · `high` · `xhigh` · `max`. Ignored for Haiku models.             |

Needs the `ANTHROPIC_API_KEY` secret; without it the body is a fixed template.

### This repo only

| Variable      | Default | Meaning                                                                                                              |
| ------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `NPM_PUBLISH` | `false` | `true` makes `self-release.yml` publish every release to npm ([CONTRIBUTING](../CONTRIBUTING.md#publishing-to-npm)). |

---

## Secrets

| Secret              | Needed by           | Required?   | What                                                                                                                                                                                                                                       |
| ------------------- | ------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GH_PROJECT_TOKEN`  | work items, promote | recommended | **Classic** PAT, scopes `repo` + `project`. Lets the bots write to Projects (v2) boards and makes the PRs they open trigger PR Checks. Falls back to `GITHUB_TOKEN` (no board writes; bot PRs do not start checks until you push to them). |
| `ANTHROPIC_API_KEY` | work items          | optional    | Writes the issue/PR descriptions. <https://console.anthropic.com/settings/keys>                                                                                                                                                            |

`GITHUB_TOKEN` is provided by Actions; never set it. Secrets are passed by name
in the caller (`secrets: inherit` is only guaranteed within one organization).

Why a classic PAT: a fine-grained token only has a Projects permission under
_organization_ permissions, so it cannot reach a board owned by a personal
account. The cost is that `repo` cannot be narrowed to selected repos — keep
the expiry short. Details: [GITHUB_ACTIONS_SETUP.md](GITHUB_ACTIONS_SETUP.md#fill-in-the-secrets).

---

## Workflow inputs

Set in the caller's `with:`. Everything else is a variable, so callers stay
four lines long.

| Workflow              | Input         | Default         | Meaning                                                                                |
| --------------------- | ------------- | --------------- | -------------------------------------------------------------------------------------- |
| all four              | `runs-on`     | `ubuntu-latest` | Runner label (e.g. `self-hosted`).                                                     |
| `auto-work-items.yml` | `base-branch` | `dev`           | Branch the work PRs target.                                                            |
| `release.yml`         | `sync-dev`    | `true`          | Point `dev` at the release commit afterwards. Keep it on unless the repo has no `dev`. |

`release.yml` outputs `tag` (`vX.Y.Z`, empty when nothing was released) and
`sha` (the release commit).

---

## Config files

### In each repo (`.github/`)

| File                   | Committed?            | Contents                                                                         |
| ---------------------- | --------------------- | -------------------------------------------------------------------------------- |
| `actions.env`          | yes                   | The repo's own variables (dotenv).                                               |
| `secrets.env`          | **no** (gitignore it) | The repo's own repository secrets. `secrets.env.example` beside it is committed. |
| `secrets.<env>.env`    | **no**                | Secrets for GitHub environment `<env>`, created by bootstrap.                    |
| `bootstrap.conf`       | yes                   | `LOCAL_ONLY_KEYS=A B C` — secret keys only local tools read; never pushed.       |
| `repo-settings.json`   | yes                   | Overrides of `config/repo-settings.json`.                                        |
| `rulesets/<file>.json` | yes                   | Overrides of the shared ruleset with the same file name, or extra rulesets.      |

### In this repo (`config/`)

| File                           | Published to npm?                      | Contents                                                                                    |
| ------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------- |
| `actions.env`                  | yes                                    | Shared variables (above).                                                                   |
| `repo-settings.json`           | yes                                    | Shared repository settings.                                                                 |
| `rulesets/*.json`              | yes                                    | Shared branch rulesets.                                                                     |
| `repos.env`                    | yes                                    | `REPOS_TOPIC`, `REPOS_OWNER`, `REPOS` — what `--all` selects; `CI_REPO` — this repo's slug. |
| `secrets.env.example`          | yes                                    | Template for the shared secrets.                                                            |
| `secrets.env`, `secrets.*.env` | **never** (gitignored, not in `files`) | Shared secrets, when you run the tools from a checkout.                                     |

`repos.env` keys:

| Key           | Default      | Meaning                                                                                 |
| ------------- | ------------ | --------------------------------------------------------------------------------------- |
| `REPOS_TOPIC` | `ebalzan-ci` | `--all` includes every repo of `REPOS_OWNER` with this topic. Empty disables discovery. |
| `REPOS_OWNER` | the gh user  | Account searched for the topic.                                                         |
| `REPOS`       | empty        | Extra `OWNER/REPO` slugs (space-separated), e.g. repos of an organization.              |
| `CI_REPO`     | `ebalzan/ci` | The slug the callers `uses:`. Change it only in a fork.                                 |

### dotenv format

`KEY=VALUE` per line; `#` comments and blank lines are ignored; one pair of
surrounding quotes is stripped. No interpolation, no `export`. A secret whose
key ends in `_FILE` is set from that file's contents under the stripped name
(for multi-line values such as SSH keys); a relative path is relative to the
env file.

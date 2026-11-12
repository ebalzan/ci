# config/

The shared layer of every managed repo. For each file a repo can add or override keys in its own `.github/` copy, and the repo's value wins (`ebalzan-ci sync --help` has the table). JSON files deep-merge; top-level keys starting with `$` are comments and are never sent to GitHub.

| File                                        | What it is                                                 | Read by                                       |
| ------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------- |
| [`types.json`](#typesjson)                  | the work types                                             | commitlint, release title, PR checks, auto-pr |
| [`cliff.toml`](cliff.toml)                  | git-cliff: the next version and the release PR's changelog | release title, auto-pr, PR checks, release    |
| [`actions.env`](actions.env)                | shared Actions variables, read at run time (never pushed)  | the actions (`scripts/shared-vars.mjs`)       |
| [`secrets.env.example`](#secretsenvexample) | the shared secrets every repo gets                         | `ebalzan-ci sync`                             |
| [`repo-settings.json`](#repo-settingsjson)  | repository settings                                        | `ebalzan-ci sync`                             |
| [`rulesets/`](#rulesets)                    | branch rulesets                                            | `ebalzan-ci sync`                             |

`sync` refuses unknown keys in `repo-settings.json` and in rulesets (GitHub would silently ignore them); the allowlists are in `lib/config.mjs` — extend them when GitHub adds a field.

## types.json

**The** list of work types — the only place a type is defined. A type is at once a branch prefix (`<type>/<description>`), a Conventional Commit and PR-title type, and a PR label.

- `release`: the bump a commit of that type triggers (`minor` | `patch`); `!` or a `BREAKING CHANGE` footer makes any type major. This is the only place the bump is set: `scripts/changelog.mjs` hands the minor types to git-cliff, and `cliff.toml` names none. `feat` must stay `minor` — git-cliff bumps it minor regardless.
- `color`: its label's color (label description: "Changes for '<type>' branches").
- **Key order is precedence**: the release PR's title takes the first type among the released commits (`scripts/release-title.mjs`), so keep the minor types first.

Read by `commitlint.config.mjs` (hook + PR check), `scripts/release-title.mjs`, `actions/pr-checks` and `actions/auto-pr`. This repo uses `refact`, never `refactor`.

## secrets.env.example

Copy it to `secrets.env` (gitignored) in a checkout of this repo, or to `$CI_SECRETS_DIR` / `~/.config/ebalzan-ci/`, and fill it in. The comments in the example describe each secret, so the real file can hold just the keys. When a key is added to the example, `sync` warns in its plan until some layer sets it.

## repo-settings.json

Sent as `PATCH /repos/{owner}/{repo}`. History is linear, with no merge commits:

- work PRs are squash-merged into `dev`, and the PR title becomes the commit;
- the `dev → main` release PR is never merged with a button — its `ship` label makes the Release workflow fast-forward `main` to `dev`;
- merge commits and rebase merges are off: a rebase merge rewrites dev's commits, so `main` and `dev` would diverge.

## rulesets/

One file per ruleset, matched to the one on GitHub by its `name`. `--prune` only ever deletes rulesets named `ci: …`.

| File                        | Branch | Default  | What it does                                                                               |
| --------------------------- | ------ | -------- | ------------------------------------------------------------------------------------------ |
| `protect-dev.json`          | dev    | active   | no deletion, no force push, linear history                                                 |
| `protect-main.json`         | main   | active   | no deletion, no force push, linear history                                                 |
| `require-pull-request.json` | dev    | disabled | changes only through a squash-merged work PR whose `pr-check / Work PR` check passed       |
| `require-release-pr.json`   | main   | disabled | updates only by the bypass list (GitHub Actions), so nobody can merge into or push to main |

**protect-dev / protect-main.** `dev` is the integration branch, `main` the release branch. The Release workflow only fast-forwards them (`main` to `dev` plus the `chore(release): X.Y.Z` commit, `dev` to that commit), so nothing in the pipeline needs a bypass.

**require-pull-request.** The work PR's title becomes the one commit on `dev`.

**require-release-pr.** `main` moves only through the Release workflow, after `pr-check / Release PR` passed (the workflow checks it). The release PR's merge buttons stay blocked: squash and rebase would rewrite dev's commits. In an emergency, an admin disables the ruleset.

### Why the two `require-*` rulesets are disabled

The Release workflow pushes `dev` and `main` with `GITHUB_TOKEN`, so the GitHub Actions app must be able to bypass both rulesets. Enable one per repo with `.github/rulesets/<file>.json` containing `{ "enforcement": "active" }`, run one release, and confirm it went through.

### The bypass actor IDs

| `actor_id` | `actor_type`     | Who                                                             |
| ---------- | ---------------- | --------------------------------------------------------------- |
| `15368`    | `Integration`    | the **GitHub Actions** app — the identity behind `GITHUB_TOKEN` |
| `5`        | `RepositoryRole` | the built-in **Admin** repository role                          |

Both are GitHub.com-wide IDs, not per-repo or per-account values — don't "fix" them. Only `require-pull-request.json` lists Admin, so an admin can still push to `dev` directly; `main` has no human bypass.

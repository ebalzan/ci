# GitHub Actions — secrets & variables

Where every Actions secret and variable lives, **why it lives there**, how
shared values reach every repo, and how one command syncs it all. Read
[§1](#1-the-rule) before adding any new value, and [§2](#2-shared-vs-repo-the-layers)
before deciding whether it goes in tracebim-ci or in a repo.

The tools: `bin/gh-bootstrap.sh` sets values, `bin/gh-reset.sh` deletes them.
Each repo's `docs/GITHUB_ACTIONS_SETUP.md` holds its own map — which keys it
adds or overrides, and which workflow reads them.

---

## 1. The rule

> **Environments** hold config that describes **a specific running system you
> deploy to**.
> **Repository** ("Settings → Secrets and variables → Actions") holds config
> that describes **the repository's own automation**.

That is the whole decision. It is _not_ "production goes in Environments" and
_not_ "the sensitive ones go in Environments". The only question is:

**Does this value point at, or grant access to, one particular deployed
system?**

- **Yes** → environment secret/variable, in the environment named after that
  system (`production`, `staging`). Examples: a host address, an SSH key, a
  database URL, a registry pull token used _by that host_, live-vs-test API keys
  of a third party.
- **No — it configures the repo's own bots and CI** → repository
  secret/variable. Examples: an LLM key used to write PR descriptions, a PAT for
  the project board, lint/label tuning.

```mermaid
flowchart TD
  A["New value to configure"] --> B{"Would you mind seeing it<br/>printed in a workflow log?"}
  B -- No --> V["VARIABLE"]
  B -- Yes --> S["SECRET"]
  V --> C{"Does the value depend on WHICH<br/>deployed system the job touches?"}
  S --> C
  C -- "Yes (host, DB, live keys)" --> E["Environment scope<br/>production / staging"]
  C -- "No (same for all runs)" --> R["Repository scope"]
```

### Why the rule is the rule

Environments are not a folder. They change _who can read the value_:

1. **Reachability gating.** An environment secret is invisible to any job that
   does not declare `environment: <name>`. `AWS_DEPLOY_ROLE_ARN` cannot be read by
   `pr-checks.yml` — not by convention, by mechanism. A repository secret is
   readable by **every job in every workflow** in the repo.
2. **Deployment history.** The Environments page records which release went to
   `production` and when.
3. **Protection rules** (required reviewers, wait timer, branch policy) — **a
   paid feature**, see [§3](#3-free-plan-reality). You do not have these.

Point 1 is the reason to use environments at all. Everything else follows from
it: put a value in an environment when you want it _unreachable_ from jobs that
have no business with that system.

### Precedence — most specific wins

Both secrets and variables exist at two scopes here, and they are **not
merged**; the nearest one wins:

```text
environment  >  repository
```

(GitHub has a third, wider scope — organization — but these repos are owned
by a personal account, which has no org-level Actions config. That is why
tracebim-ci's "shared" layer is read at run time for variables and merged in
at sync time for secrets: see §2.)

So defining e.g. `EC2_INSTANCE_ID` at the repo _and_ on the `production`
environment means `environment: production` jobs get the environment value
and everyone else gets the repo value. That is a legitimate **override**, but
only do it on purpose — an accidental duplicate is the hardest Actions bug to see,
because both values are masked in logs.

### Secret or variable?

Same two scopes, different visibility. **Variables are plain text** — printed
in logs, readable by anyone who can view repo settings. Secrets are masked and
write-only after creation. If you would not paste it into a public issue, it is
a secret. Non-secret-but-environment-specific config (a region, a health-check
URL, a log level) is a legitimate **environment variable** — the two axes are
independent.

---

## 2. Shared vs repo: the layers

> **A value goes in tracebim-ci only when it is the same for every repo.**
> Anything that differs — a board number, a deploy host, a Vercel project — is
> that repo's, and lives in that repo.

```text
                  tracebim-ci/config/            <repo>/.github/
                  (shared, lower precedence)     (repo, wins)
variables         actions.env               +    actions.env              → shared read at run time; repo's → repository variables
repo secrets      secrets.env               +    secrets.env              → repository secrets
env secrets       secrets.<env>.env         +    secrets.<env>.env        → environment <env> secrets
```

The two columns combine key by key — **the repo's value wins**. For secrets,
`bin/gh-bootstrap.sh` merges them and writes the result onto the repository.
For variables it pushes only the repo's column; the shared one is read at run
time (below). So a repo can:

- **inherit** a shared key by not mentioning it;
- **override** it by setting the same key in its own file;
- **add** any key of its own, in any scope (including a new environment: the
  file `secrets.staging.env` creates and fills environment `staging`).

The dry run labels every key `shared`, `repo`, `repo (overrides shared)` or
`repo (same as shared: redundant)` — delete the redundant ones from the repo's
file so the repo keeps only what is really its own.

**Shared variables are read at run time.** In a reusable workflow `vars` are
the caller repo's, and a personal account has no org-level config to fall back
on — but `config/actions.env` is committed, and the runner downloads the whole
of tracebim-ci for `uses: ebalzan/tracebim-ci/actions/…@v1`. So the actions
(`actions/auto-work-items/src/sharedVars.ts`, also used by
`scripts/release/promote-dev-to-main.mjs`) load that file and fill every key
the repo leaves unset. Consequences:

- A shared variable changes when it is released and **v1 moves** — no
  bootstrap run, and nothing stale is left on any repo.
- A repo's Settings page shows only its own variables; the run log line
  `Shared variables from config/actions.env: …` lists what was filled.
- Only the shared actions see shared variables. A workflow that lives in a repo
  and reads `vars.X` itself must have `X` in that repo's `actions.env`.
- An empty repo variable counts as unset, so a repo cannot blank out a shared
  value — override it with a real one.

**Shared secrets are merged at sync time** — they are not committed, so there
is nothing to read at run time. After changing one, re-run
`bin/gh-bootstrap.sh --all`.

**Removing a key** from a file does not delete it on GitHub. `--prune` deletes
every variable/secret in a synced scope that no layer defines (after listing
them and asking). Environments that no file names are never touched.

---

## 3. Free-plan reality

The repos are **private, owned by a personal account on the free plan**:

- ✅ **Environments and environment-scoped secrets work** (verified — the
  production deploy depends on them).
- ❌ **Protection rules** (required reviewers, wait timers, deployment branch
  policies) are paid → **there is no click-to-approve gate before a deploy**.
  The production approval is **merging the dev → main promotion PR**. Review it
  as the deploy approval it is.
- ❌ **Organization-level** secrets/variables do not exist for a personal
  account at all → every non-environment value is a repository value
  (see [§2](#2-shared-vs-repo-the-layers)).

---

## 4. File mechanics

| File                                        | Contains                             | Committed?        |
| ------------------------------------------- | ------------------------------------ | ----------------- |
| `config/actions.env`, `.github/actions.env` | variables                            | ✅ Yes            |
| `config/secrets.env`, `.github/secrets.env` | repository secrets                   | ❌ **Gitignored** |
| `…/secrets.<env>.env`                       | secrets for GitHub environment `env` | ❌ **Gitignored** |
| `…/secrets*.env.example`                    | placeholders / templates             | ✅ Yes            |
| `.github/bootstrap.conf`                    | per-repo tool settings (below)       | ✅ Yes            |

> **The filename is the destination.** `actions.env` / `secrets.env` land on
> the repository; a `.<name>` infix always targets the GitHub environment it is
> named after.

- **`_FILE` suffix.** A secret key ending in `_FILE` is a path: the secret is
  created under the stripped name from that file's **contents** (dotenv cannot
  hold a multiline value). `~` expands; a relative path is relative to the env
  file. `FOO_FILE` in one layer and `FOO` in the other are the same key.
- **Local-only keys.** `LOCAL_ONLY_KEYS=A B C` in a repo's
  `.github/bootstrap.conf` are never pushed — for values that only a local tool
  reads (tracebim-api's `scripts/provision-host.sh`).
- **Guards.** Empty values and placeholders (`xxxx`, `sk-ant-xxx`,
  `github_pat_xxx`) are refused: a secret cannot be read back to notice a bad
  write. A missing secrets file is seeded from its `.example` on first run.
- **Ownership check.** tracebim-ci is private; its workflows can only be called
  by repos owned by the same account (`CI_REPO` in `config/repos.env`). The
  bootstrap warns about any other.

Real secrets never enter git. These are **Actions** secrets, unrelated to any
app's runtime `.env`.

---

## 5. Setup

### Prerequisites

1. **GitHub CLI** — <https://cli.github.com> (`gh --version`), authenticated
   with the `project` scope: `gh auth login && gh auth refresh -s project`.
2. **Admin** on every target repo.
3. The repos checked out **next to** tracebim-ci (`../tracebim-api`, …), as
   listed in `config/repos.env` — or set `TRACEBIM_REPOS_ROOT`.

### Fill in the secrets

```bash
cp config/secrets.env.example config/secrets.env           # shared
$EDITOR config/secrets.env
# plus each repo's own: <repo>/.github/secrets*.env (see that repo's doc)
```

> **Why a separate `GH_PROJECT_TOKEN`?** The built-in `GITHUB_TOKEN` cannot write
> to Projects (v2) boards, which are owned by the account, not the repo.
>
> **Why classic and not fine-grained?** Fine-grained PATs expose a `Projects`
> permission only under **Organization** permissions. There is no account-level
> equivalent, so a fine-grained token cannot reach a board owned by a personal
> account — which is what this board is. A classic PAT with the `project` scope
> is the only option. It also needs `repo`, because the automation creates
> issues and pull requests (`issues.create`, `issues.update`, `issues.setLabels`,
> `pulls.create`, `pulls.update`), not just reads them.
>
> The trade-off: `repo` on a classic PAT covers **every** repository the account
> can reach and cannot be narrowed to selected repos. Keep the expiry short, and
> reissue rather than extend. One token serves every repo that writes to the
> board, but a personal account has no org-level secrets, so the bootstrap writes it as a
> repository secret in each of them — from one line in `config/secrets.env`.

### Run the bootstrap

```bash
bin/gh-bootstrap.sh --all --dry-run          # preview every repo — run this first
bin/gh-bootstrap.sh --all                    # sync every repo
bin/gh-bootstrap.sh -C ../tracebim-api       # one repo
npm run gh:bootstrap                         # from inside a repo (same script)
```

It is idempotent — re-run it to update any value; nothing needs clicking
together in the GitHub UI.

| Flag                      | Effect                                                      |
| ------------------------- | ----------------------------------------------------------- |
| `-C`, `--repo-dir DIR`    | Repo checkout to sync (default: current directory).         |
| `-a`, `--all`             | Every repo in `config/repos.env`.                           |
| `-R`, `--repo OWNER/REPO` | Target slug (default: from the checkout's git remote).      |
| `--prune`                 | Delete config on GitHub that no layer defines (asks first). |
| `-n`, `--dry-run`         | Show the merged plan — changes nothing.                     |
| `-y`, `--yes`             | Skip the confirmation prompts.                              |

---

## 6. Verify

```bash
gh variable list --repo ebalzan/tracebim-api
gh secret   list --repo ebalzan/tracebim-api
gh secret   list --repo ebalzan/tracebim-api --env production
```

Repository values are under **Settings → Secrets and variables → Actions**;
environment values under **Settings → Environments → _name_**. Then the real
check: push a branch (work items appear) and open a PR (title check green).

---

## 7. Resetting / deleting

Prefer `gh-bootstrap.sh --prune` to remove keys no file defines any more.
`bin/gh-reset.sh` is the blunt tool: it lists what exists, then requires a
typed confirmation. Always `--dry-run` first.

```bash
bin/gh-reset.sh -C ../tracebim-api --dry-run           # repo variables that would go
bin/gh-reset.sh -C ../tracebim-api --include-secrets   # variables + repo secrets
bin/gh-reset.sh -C ../tracebim-api --match '^AUTO_'    # only matching names
bin/gh-reset.sh -C ../tracebim-api --env production --secrets-only --dry-run
```

---

## 8. Troubleshooting

| Symptom                                             | Cause / fix                                                                                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Secret is set but the job sees an **empty string**  | The job does not declare `environment:`. Environment secrets resolve **only** inside a job that names the environment — no error, just empty. |
| Shared change has no effect in a repo               | Not re-synced (`--all`), or the repo overrides that key — the dry run says which.                                                             |
| Key removed from a file still on GitHub             | Removal never deletes. Re-run with `--prune`.                                                                                                 |
| Two scopes, wrong value wins                        | Precedence is environment > repository. Delete the duplicate you did not mean to create.                                                      |
| `gh is not authenticated`                           | `gh auth login`, then `gh auth refresh -s project`.                                                                                           |
| `… is still a placeholder` / `… has an empty value` | Fill the value in, or comment the line out.                                                                                                   |
| Multiline secret arrives mangled                    | Use the `_FILE` suffix.                                                                                                                       |
| `Could not verify …/projects/N`                     | `gh auth refresh -s project`, or fix `AUTO_PROJECT_NUMBER` in the repo's `actions.env`.                                                       |

Naming constraints: names are case-insensitive, cannot start with `GITHUB_` or a
digit, and secrets are capped at 48 KB (100 per repo, 100 per environment).

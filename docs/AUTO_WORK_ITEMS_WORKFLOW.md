# Auto Work Items Workflow Guide

This document explains the automated branch workflow every repo using ebalzan/ci runs.

## What It Does

When you push to any branch other than `main` or `dev`, the workflow automatically:

1. Creates or reuses a tracking **Issue** for the branch.
2. Creates or reuses a ready-for-review **PR** from the branch to `dev` (the `base-branch` input).
3. Links the PR to the issue (`Closes #<issue-number>`).
4. Applies the exact label set to both issue and PR (removes stale extras).
5. Applies milestone (if configured).
6. Adds both issue and PR to GitHub Project (v2) (if `AUTO_PROJECT_NUMBER` is set).
7. Assigns issue and PR to the latest commit author (if resolvable to a GitHub user).
8. Updates project fields: `Start date`, `Target date`, `Priority`, `Estimate`, and `Size`.

The process is idempotent and safe to run on every push.

## Workflow Files

- Reusable workflow: `.github/workflows/auto-work-items.yml` (this repo)
- Composite action it runs: `actions/auto-work-items/action.yml`
- Caller in each repo: `.github/workflows/auto-pr.yml` — only the trigger
  (`push`, `branches-ignore: [main, dev]`), the permissions, and the `uses:` line.

## Script Architecture

The workflow is orchestrated by `actions/github-script`, but all logic is implemented in TypeScript modules.

Source of truth:

- `actions/auto-work-items/src/index.ts` (orchestrator)
- `actions/auto-work-items/src/issue.ts`
- `actions/auto-work-items/src/pr.ts`
- `actions/auto-work-items/src/project.ts`
- `actions/auto-work-items/src/config.ts`
- `actions/auto-work-items/src/labels.ts`
- `actions/auto-work-items/src/milestone.ts`
- `actions/auto-work-items/src/utils.ts`
- `actions/auto-work-items/src/types.ts`

Runtime files used by GitHub Actions:

- `actions/auto-work-items/dist/*.js`

Why both exist:

- `actions/github-script` executes JavaScript, not `.ts` directly.
- We keep typed source in `src/` and compile to `dist/` for runtime.

## Trigger Rules

The caller (`auto-pr.yml`) runs it on:

- `push` to any branch except `main` and `dev`
- tags are ignored

```yaml
on:
  push:
    branches-ignore:
      - main
      - dev
    tags-ignore:
      - '**'
```

The reusable workflow also skips `chore/renovate-*` branches, whose PR
Renovate owns.

## Concurrency and Idempotency

Concurrency is enabled per branch:

- group: `auto-work-items-${{ github.ref }}`
- in-progress run for the same branch is canceled

Idempotency is handled by a marker in issue/PR bodies:

- `Marker: auto-work-item:<branch-name>`

If an issue/PR already exists for that branch, it is reused and updated.

## End-to-End Flow

1. Parse branch name and derive `branchType` (`feat`, `fix`, `chore`, etc.; any other prefix fails the run).
2. Build titles, body content, marker, labels, and priority decision.
3. Ensure labels exist and sync color/description to expected values.
4. Resolve milestone by number (preferred) or exact title.
5. Upsert tracking issue.
6. Upsert PR (opened ready for review, not draft) to `AUTO_BASE_BRANCH` (`dev`).
7. Ensure PR includes `Closes #<issue-number>`.
8. Add issue and PR to configured Project v2.
9. Resolve project fields by name (`Start date`, `Target date`, `Priority`, `Estimate`, `Size`).
10. Set date fields and metadata fields on both items.
11. Emit workflow notice with final issue/PR numbers.

## Branch Type Mapping

Current branch-type defaults:

| Branch Type | PR Prefix | Type Label | Default Priority | Label Color |
| ----------- | --------- | ---------- | ---------------- | ----------- |
| `feat`      | `feat`    | `feat`     | `P2`             | `1D76DB`    |
| `fix`       | `fix`     | `fix`      | `P1`             | `D73A4A`    |
| `docs`      | `docs`    | `docs`     | `P3`             | `5319E7`    |
| `style`     | `style`   | `style`    | `P4`             | `C2E0C6`    |
| `refact`    | `refact`  | `refact`   | `P2`             | `FBCA04`    |
| `perf`      | `perf`    | `perf`     | `P1`             | `F9D0C4`    |
| `test`      | `test`    | `test`     | `P3`             | `0E8A16`    |
| `build`     | `build`   | `build`    | `P3`             | `0052CC`    |
| `ci`        | `ci`      | `ci`       | `P3`             | `0052CC`    |
| `chore`     | `chore`   | `chore`    | `P4`             | `BFD4F2`    |
| `revert`    | `revert`  | `revert`   | `P1`             | `E99695`    |

These are the only accepted branch types. Any other prefix (`feature/`, `hotfix/`,
`refactor/`, …) fails the run with no issue or PR created — rename the branch.

## Labels Applied

Always applied labels:

- type label from branch type (for example `feat`, `refact`, `chore`)

Optional extra labels from variables:

- `AUTO_ISSUE_LABELS` (CSV)
- `AUTO_PR_LABELS` (CSV)

Note:

- Reserved type labels (for example `feat`, `fix`, `chore`, `ci`) are controlled by branch type and filtered out from `AUTO_ISSUE_LABELS` and `AUTO_PR_LABELS`.

Label color behavior:

- Known labels (type labels) use configured fixed colors.
- Custom/extra labels use a deterministic non-gray palette.
- `priority:P0` through `priority:P4` map to priority-specific colors.
- Existing labels are updated when current color/description drift from expected values.

## Milestone Behavior

Milestone resolution order:

1. `AUTO_MILESTONE_NUMBER` (numeric)
2. `AUTO_MILESTONE_TITLE` (exact case-insensitive title match)
3. none only when both variables are unset

When resolved, milestone is set on both issue and PR.
A milestone that cannot be found (or is closed) produces a warning, not a
failure.

Setup guidance:

- If you want stable pinning, set `AUTO_MILESTONE_NUMBER`.
- If you want name-based matching, set `AUTO_MILESTONE_TITLE` and leave `AUTO_MILESTONE_NUMBER` unset.
- Do not keep a stale `AUTO_MILESTONE_NUMBER`; it takes precedence over title.

## Project v2 Behavior

Project selection:

- owner: `AUTO_PROJECT_OWNER` (defaults to repo owner)
- project number: `AUTO_PROJECT_NUMBER` — unset means no board: the issue and
  PR are still created, and the board step is skipped

Field lookup is by name (case-insensitive):

- `Start date`
- `Target date`
- `Priority` (single-select)
- `Estimate`
- `Size`

There are no custom field-name variables in the current implementation.

Date values:

- Start = `today + AUTO_START_DATE_OFFSET_DAYS` (default `0`)
- Target = `today + AUTO_TARGET_DATE_OFFSET_DAYS` (default `7`)

Priority value:

1. `AUTO_PRIORITY_MAP_JSON[branchType]`
2. `AUTO_DEFAULT_PRIORITY`
3. branch default from mapping table

If the requested priority is unavailable in the project field options, the workflow falls back to the nearest available `P<number>` option.

Size value:

1. `AUTO_SIZE_MAP_JSON[branchType]`
2. `AUTO_DEFAULT_SIZE`
3. fallback: `M`

Estimate value:

1. `AUTO_ESTIMATE_MAP_JSON[branchType]`
2. `AUTO_DEFAULT_ESTIMATE`
3. fallback: `1`

## Strict vs Non-Strict Metadata Mode

`AUTO_STRICT_METADATA` controls failure behavior for project metadata sync.

- `true` (default): with a board configured, a missing project, field or
  option fails the workflow.
- `false`: the same problems only emit warnings.
- Without `AUTO_PROJECT_NUMBER` neither applies: the board is skipped.

This is useful when metadata is mandatory for your process.

## Variables and Secret Reference

`auto-work-items.yml` passes the caller repo's variables whole
(`REPO_VARS_JSON: ${{ toJSON(vars) }}`) — the repo's `.github/actions.env`,
pushed by `ebalzan-ci bootstrap` — and the action takes their `AUTO_*` keys. A
knob the repo leaves unset is filled from `config/actions.env` at the action's
ref (`src/sharedVars.ts`), else the code default applies. So a knob is set in
the repo's file (then the bootstrap) or in `config/actions.env` (then a release
that moves the major tag) — never in the workflow. Defaults and meanings:
[CONFIGURATION.md](CONFIGURATION.md#actions-variables).

- `AUTO_BASE_BRANCH` (from the `base-branch` input, default `dev`)
- `AUTO_ISSUE_LABELS`
- `AUTO_PR_LABELS`
- `AUTO_MILESTONE_NUMBER`
- `AUTO_MILESTONE_TITLE`
- `AUTO_PROJECT_OWNER`
- `AUTO_PROJECT_NUMBER` (repo variable — one board per repo)
- `AUTO_DEFAULT_PRIORITY`
- `AUTO_PRIORITY_MAP_JSON`
- `AUTO_DEFAULT_SIZE`
- `AUTO_SIZE_MAP_JSON`
- `AUTO_DEFAULT_ESTIMATE`
- `AUTO_ESTIMATE_MAP_JSON`
- `AUTO_START_DATE_OFFSET_DAYS`
- `AUTO_TARGET_DATE_OFFSET_DAYS`
- `AUTO_STRICT_METADATA` (defaults to `true` if unset)
- `AUTO_DESCRIBE_MODEL`, `AUTO_DESCRIBE_EFFORT` (describe.ts)
- secret `ANTHROPIC_API_KEY` (describe.ts; without it the body is a stub)

Notes:

- Without `AUTO_PROJECT_NUMBER` the board is skipped, whatever `AUTO_STRICT_METADATA` says.
- `GH_PROJECT_TOKEN` is recommended when `github.token` cannot write Project v2 metadata.

## Permissions Used

Workflow permissions (the caller must grant them; a reusable workflow cannot
raise its caller's):

- `contents: read`
- `issues: write`
- `pull-requests: write`
- `repository-projects: write`

Token source used by workflow:

- `secrets.GH_PROJECT_TOKEN` if present
- otherwise falls back to `github.token`

## Build and Maintenance

Compile TypeScript workflow scripts:

```bash
npm run build   # in a checkout of ebalzan/ci
```

Important:

- Commit both `src/` and `dist/` changes. CI (`npm run check`) fails when
  `dist/` does not match `src/`.
- Callers run `dist/` straight from the action download — nothing builds it on
  the runner. A change reaches the repos only once the major tag moves
  ([CONTRIBUTING → Releasing](../CONTRIBUTING.md#releasing-a-change)).

## Troubleshooting

### "Context access might be invalid"

This warning usually comes from static editor validation, not Actions runtime.
It is common with `vars.*` and `secrets.*` in workflow `env` blocks — which is
why the workflows pass `toJSON(vars)` instead of naming each variable.

### Common runtime failures

- Unsupported branch prefix (`feature/`, `hotfix/`, `refactor/`, …): rename the branch
- Project not found (`AUTO_PROJECT_OWNER` / `AUTO_PROJECT_NUMBER` mismatch)
- Missing required fields in Project v2 (`Start date`, `Target date`, `Priority`, `Estimate`, `Size`)
- Priority option text does not exist in the project field
- Token missing permission for project updates
- Milestone title not found
- Stale `AUTO_MILESTONE_NUMBER` overriding `AUTO_MILESTONE_TITLE`

### Quick verification checklist

1. Push a test branch like `chore/workflow-test`.
2. Confirm issue + PR are created.
3. Confirm PR body includes `Closes #...`.
4. Confirm issue and PR are added to the right project.
5. Confirm issue and PR assignees are set to the latest commit author.
6. Confirm `Start date`/`Target date`/`Priority`/`Estimate`/`Size` fields are set correctly.

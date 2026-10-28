# Security

## Reporting a vulnerability

Please report it privately through GitHub: **Security → Report a
vulnerability** on <https://github.com/ebalzan/ci>. Do not open a public issue.

## What to be aware of when using this

- **Callers run this repo's code with their tokens.** A workflow pinned to
  `@v2` runs whatever `v2` points at. Pinning `@v2.3.1` or a commit SHA does
  **not** freeze that code: it freezes the workflow file, but the actions
  inside it are referenced as `@v2`
  ([docs/ARCHITECTURE.md §9](docs/ARCHITECTURE.md#9-versions-what-a-pin-freezes)).
  To control exactly what runs, fork the repo and call your fork.
- **`GH_PROJECT_TOKEN` is a classic PAT** with `repo` scope, which reaches every
  repository the account can access. Give it a short expiry, and reissue rather
  than extend. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md#secrets).
- **Secrets never enter git.** `secrets*.env` files are gitignored here and
  should be in every repo; they are excluded from the npm package by the
  `files` allow-list. The bootstrap refuses empty and placeholder values and
  never prints secret values.
- **Pull requests from forks** do not receive secrets. The only shared check
  that runs on them, the PR-title check, needs none; the work-items automation
  runs on pushes to the repo itself, never on fork PRs.

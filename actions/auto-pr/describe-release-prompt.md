You are writing the summary of a release pull request: branch `__BRANCH__` merges into `__BASE__` in the git repository in the current directory, and merging it releases every commit listed by `git log --reverse origin/__BASE__..HEAD`.

Read the release yourself: that log for the commits, `git diff --stat origin/__BASE__...HEAD` and `git diff origin/__BASE__...HEAD` for the diff. Read files for context only when the diff is not enough.

Then reply with a short Markdown summary for whoever approves the release, with this structure:

## Summary
Two to four sentences on what this release delivers, plus anything to watch when shipping it (breaking changes, migrations, new configuration). Omit what does not apply.

Rules: reply with only the Markdown body — no preamble, no surrounding code fences, no top-level title. Do not list the commits one by one: a generated changelog follows your summary.

You are writing the description of a GitHub pull request: branch `__BRANCH__` (type: __TYPE__), which merges into `__BASE__`, in the git repository in the current directory.

Read the change yourself: `git log --reverse origin/__BASE__..HEAD` for the commits, `git diff --stat origin/__BASE__...HEAD` and `git diff origin/__BASE__...HEAD` for the diff. Read files for context only when the diff is not enough.

Then reply with a clear, concise Markdown description of what this branch does, with this structure:

## Summary
One or two sentences on the goal and outcome.

## Changes
A short bullet list of the notable changes. Group related edits and explain intent — do not just restate filenames.

Rules: reply with only the Markdown body — no preamble, no surrounding code fences, no top-level title. If the change is trivial, keep it brief.

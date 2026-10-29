// The one Conventional Commits rule (commitlint), used by the husky commit-msg
// hook (`ebalzan-ci commit-msg`) and by the work-PR check on the PR title and
// every commit of the PR (actions/work-pr). The types come from
// config/types.json.
//
// Deliberately no @commitlint/config-conventional: only the header shape is
// enforced — `<type>(<scope>)!: <subject>`, scope and `!` optional — as the
// release scan (scripts/release/release-utils.mjs) reads it. Git's own subjects
// (Merge …, Revert "…", fixup! …) are ignored by commitlint's defaults.

import { readFileSync } from 'node:fs'

const commitTypes = JSON.parse(
  readFileSync(new URL('./config/types.json', import.meta.url), 'utf8'),
)
export const types = Object.keys(commitTypes).filter(key => !key.startsWith('$'))

export default {
  parserPreset: {
    parserOpts: {
      headerPattern: /^(\w*)(?:\(([^)]+)\))?!?: (.+)$/,
      headerCorrespondence: ['type', 'scope', 'subject'],
    },
  },
  rules: {
    'type-empty': [2, 'never'],
    'type-enum': [2, 'always', types],
    'subject-empty': [2, 'never'],
  },
  helpUrl: 'https://github.com/ebalzan/ci/blob/main/docs/COMMIT_GUIDE.md',
}

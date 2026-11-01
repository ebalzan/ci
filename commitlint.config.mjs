// The one Conventional Commits rule (commitlint), used by the husky commit-msg
// hook (`ebalzan-ci commit-msg`) and by the PR check on the PR title and
// every commit of the PR (actions/pr-checks). The types come from
// config/types.json.
//
// Deliberately no @commitlint/config-conventional: only the header shape is
// enforced — `<type>(<scope>)!: <subject>`, scope and `!` optional — as the
// release PR's version and title read it (config/cliff.toml, scripts/release-title.mjs). Git's own subjects
// (Merge …, Revert "…", fixup! …) are ignored by commitlint's defaults.

import { readFileSync } from 'node:fs'

import { stripDocKeys } from './lib/config.mjs'

// { <type>: { release, color } }, in config/types.json's order (precedence).
export const TYPES = stripDocKeys(
  JSON.parse(readFileSync(new URL('./config/types.json', import.meta.url), 'utf8')),
)
export const types = Object.keys(TYPES)

// THE Conventional Commit header: commitlint parses with it, and the PR rules
// (actions/pr-checks) and the release title (scripts/release-title.mjs) read the
// type and the `!` with it. Not anchored at the end: it also runs on whole
// multi-line commit messages.
export const HEADER_PATTERN = /^(?<type>\w*)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?: (?<subject>.+)/

export default {
  parserPreset: {
    parserOpts: {
      headerPattern: HEADER_PATTERN,
      headerCorrespondence: ['type', 'scope', 'breaking', 'subject'],
    },
  },
  rules: {
    'type-empty': [2, 'never'],
    'type-enum': [2, 'always', types],
    'subject-empty': [2, 'never'],
  },
}

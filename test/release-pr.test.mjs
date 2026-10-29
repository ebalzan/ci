// The release-PR rules (actions/pr-check/release-pr/rules.mjs) on plain
// objects: what Danger fails or warns about for the dev → main PR. What every
// PR needs (assignee, milestone, board, description) is pr-check.test.mjs's.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkReleasePr } from '../actions/pr-check/release-pr/rules.mjs'
import { prConfig } from '../actions/pr-check/rules.mjs'

const config = { ...prConfig({}), projectOwner: 'me' }

// The release PR as actions/auto-pr opens it; each test changes one thing.
function check({ pr = {}, ...rest } = {}) {
  return checkReleasePr({
    pr: {
      title: 'feat: release v1.4.0',
      body: '## Summary\nFilters.\n\n## Changes\n### feat\n- add filters (abc1234)',
      head: 'dev',
      base: 'main',
      authorAssociation: 'NONE',
      assignees: ['me'],
      labels: ['release'],
      milestone: null,
      changedLines: 5000,
      ...pr,
    },
    releaseTitle: 'feat: release v1.4.0',
    config,
    ...rest,
  })
}

function failsWith(result, pattern) {
  assert.ok(
    result.fails.some(message => pattern.test(message)),
    `expected a fail matching ${pattern}, got: ${JSON.stringify(result.fails)}`,
  )
}

test('a complete one passes, whoever opened it and however big', () => {
  assert.deepEqual(check(), { fails: [], warnings: [] })
})

test('base must be main', () => {
  failsWith(check({ pr: { base: 'dev' } }), /merges `dev` into `main`, not `dev`/)
})

test('the title must be exactly the computed one', () => {
  for (const title of ['fix: release v1.4.0', 'feat: release v1.3.1', 'feat: promote dev']) {
    failsWith(check({ pr: { title } }), /title must be `feat: release v1\.4\.0`/)
  }
  failsWith(check({ releaseTitle: '' }), /no Conventional Commit on `dev`/)
})

test('needs the release label; other labels are fine', () => {
  failsWith(check({ pr: { labels: ['feat'] } }), /Add the `release` label/)
  assert.deepEqual(check({ pr: { labels: ['Release', 'feat'] } }).fails, [])
})

test('what every PR needs applies too', () => {
  failsWith(check({ pr: { assignees: [] } }), /Assign the PR/)
})

test('dev behind main fails; a major release warns', () => {
  failsWith(check({ behindBy: 2 }), /`main` has 2 commits that `dev` does not/)
  const major = check({
    pr: { title: 'feat!: release v2.0.0' },
    releaseTitle: 'feat!: release v2.0.0',
  })
  assert.deepEqual(major.fails, [])
  assert.match(major.warnings[0], /\*\*major\*\*/)
})

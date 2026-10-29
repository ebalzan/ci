// The work-PR rules (actions/pr-check/work-pr/rules.mjs) on plain objects: what
// Danger fails or warns about for a feat/fix/… PR into dev. What every PR needs
// (assignee, milestone, board, description) is pr-check.test.mjs's.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { prConfig } from '../actions/pr-check/rules.mjs'
import { checkWorkPr } from '../actions/pr-check/work-pr/rules.mjs'

const config = { ...prConfig({}), projectOwner: 'me' }

// A PR that passes every rule; each test changes one thing.
function check({ pr = {}, ...rest } = {}) {
  return checkWorkPr({
    pr: {
      title: 'feat(search): add filters',
      body: '## Summary\nFilters.',
      head: 'feat/search-filters',
      base: 'dev',
      authorAssociation: 'OWNER',
      assignees: ['me'],
      labels: ['feat'],
      milestone: null,
      changedLines: 120,
      ...pr,
    },
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

test('a complete PR passes with no warnings', () => {
  assert.deepEqual(check(), { fails: [], warnings: [] })
})

test('base must be dev', () => {
  failsWith(check({ pr: { base: 'main' } }), /merge into `dev`, not `main`/)
})

test('branch must be <type>/<description> with a known type', () => {
  for (const head of ['feature/x', 'refactor/x', 'feat', 'feat/', 'my-branch']) {
    failsWith(check({ pr: { head } }), /is not `<type>\/<description>`/)
  }
  assert.deepEqual(check({ pr: { head: 'feat/a/b' } }).fails, [])
})

test('title type must equal the branch type; scope and ! are fine', () => {
  failsWith(check({ pr: { title: 'fix: add filters' } }), /must start with `feat:`/)
  failsWith(check({ pr: { title: 'Merge branch dev' } }), /must start with `feat:`/)
  assert.deepEqual(check({ pr: { title: 'feat: add filters' } }).fails, [])
  assert.deepEqual(check({ pr: { title: 'feat(ui)!: drop old filters' } }).fails, [])
})

test('exactly one type label: the branch type', () => {
  failsWith(check({ pr: { labels: [] } }), /Add the `feat` label/)
  failsWith(check({ pr: { labels: ['feat', 'fix'] } }), /Remove the `fix` label:/)
  assert.deepEqual(check({ pr: { labels: ['Feat', 'needs-design'] } }).fails, [])
})

test('author must be the owner, a member or a collaborator', () => {
  for (const authorAssociation of ['MEMBER', 'COLLABORATOR']) {
    assert.deepEqual(check({ pr: { authorAssociation } }).fails, [])
  }
  for (const authorAssociation of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', undefined]) {
    failsWith(check({ pr: { authorAssociation } }), /owner, members and collaborators only/)
  }
})

test('what every PR needs applies too', () => {
  failsWith(check({ pr: { assignees: [] } }), /Assign the PR/)
})

test('warnings: size, major release, behind base', () => {
  assert.match(check({ pr: { changedLines: 501 } }).warnings[0], /changes 501 lines/)
  assert.match(check({ pr: { title: 'feat!: x' } }).warnings[0], /\*\*major\*\*.*title's `!`/)
  assert.match(
    check({ commitMessages: ['feat: x\n\nBREAKING CHANGE: y'] }).warnings[0],
    /\*\*major\*\*.*footer in `feat: x`/,
  )
  assert.match(check({ behindBy: 3 }).warnings[0], /3 commits behind `dev`/)
  for (const result of [check({ pr: { changedLines: 501 } }), check({ behindBy: 1 })]) {
    assert.deepEqual(result.fails, [])
  }
})

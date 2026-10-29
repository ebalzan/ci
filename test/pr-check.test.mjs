// What every PR needs, whatever its kind (actions/pr-check/rules.mjs), on plain
// objects: the AUTO_* knobs, then assignee, milestone, board and description.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkTracking, prConfig } from '../actions/pr-check/rules.mjs'

const config = { ...prConfig({}), projectOwner: 'me' }

// A PR that passes every rule; each test changes one thing.
function check({ pr = {}, ...rest } = {}) {
  return checkTracking({
    pr: { body: '## Summary\nFilters.', assignees: ['me'], milestone: null, ...pr },
    config,
    ...rest,
  })
}

function failsWith(fails, pattern) {
  assert.ok(
    fails.some(message => pattern.test(message)),
    `expected a fail matching ${pattern}, got: ${JSON.stringify(fails)}`,
  )
}

test('a tracked PR passes', () => {
  assert.deepEqual(check(), [])
})

test('prConfig reads the AUTO_* knobs, with defaults', () => {
  assert.deepEqual(prConfig({}), {
    baseBranch: 'dev',
    releaseBranch: 'main',
    milestoneTitle: '',
    projectNumber: 0,
    projectOwner: '',
    maxChangedLines: 500,
  })
  const set = prConfig({
    AUTO_BASE_BRANCH: 'develop',
    AUTO_RELEASE_BRANCH: 'release',
    AUTO_MILESTONE_TITLE: ' Q4 ',
    AUTO_PROJECT_NUMBER: '15',
    AUTO_PROJECT_OWNER: 'org',
    AUTO_MAX_CHANGED_LINES: 'nope',
  })
  assert.equal(set.baseBranch, 'develop')
  assert.equal(set.releaseBranch, 'release')
  assert.equal(set.milestoneTitle, 'Q4')
  assert.equal(set.projectNumber, 15)
  assert.equal(set.projectOwner, 'org')
  assert.equal(set.maxChangedLines, 500)
})

test('needs an assignee', () => {
  failsWith(check({ pr: { assignees: [] } }), /Assign the PR/)
})

test('milestone is required only when AUTO_MILESTONE_TITLE is set', () => {
  const run = milestone => check({ pr: { milestone }, config: { ...config, milestoneTitle: 'Q4' } })
  failsWith(run(null), /Set the milestone to `Q4`/)
  failsWith(run('Q3'), /Set the milestone to `Q4` \(AUTO_MILESTONE_TITLE\), not `Q3`/)
  assert.deepEqual(run('q4'), [])
})

test('board is required only when AUTO_PROJECT_NUMBER is set', () => {
  const run = extra => check({ config: { ...config, projectNumber: 15 }, ...extra })
  failsWith(run({ projects: [] }), /Add the PR to project #15 of `me`/)
  failsWith(run({ projects: [{ owner: 'other', number: 15 }] }), /Add the PR to project #15/)
  failsWith(run({ projectsError: 'Resource not accessible' }), /Could not check .*not accessible/)
  assert.deepEqual(run({ projects: [{ owner: 'Me', number: 15 }] }), [])
})

test('needs a description; HTML comments alone do not count', () => {
  failsWith(check({ pr: { body: '' } }), /Describe the change/)
  failsWith(check({ pr: { body: '<!-- template -->\n  ' } }), /Describe the change/)
})

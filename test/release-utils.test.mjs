import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  analyzeBranchName,
  analyzeConventionalMessage,
  bumpVersion,
  highestRelease,
  normalizeSubjectLine,
  supportedBranchTypes,
} from '../scripts/release/release-utils.mjs'

test('commit types map to the documented bumps', () => {
  assert.equal(analyzeConventionalMessage('feat(api): add x').release, 'minor')
  for (const type of [
    'fix',
    'docs',
    'style',
    'refact',
    'perf',
    'test',
    'build',
    'ci',
    'chore',
    'revert',
  ]) {
    assert.equal(analyzeConventionalMessage(`${type}: change`).release, 'patch', type)
  }
  assert.equal(analyzeConventionalMessage('refactor: nope').release, 'none')
  assert.equal(analyzeConventionalMessage('not conventional').release, 'none')
})

test('breaking changes are major, by ! or by footer', () => {
  assert.equal(analyzeConventionalMessage('fix!: drop x').release, 'major')
  assert.equal(analyzeConventionalMessage('chore(deps)!: bump').release, 'major')
  assert.equal(
    analyzeConventionalMessage('fix: x\n\nBREAKING CHANGE: the y input is gone').release,
    'major',
  )
})

test('the strongest release of a batch wins', () => {
  assert.equal(highestRelease(['docs: a', 'fix: b']), 'patch')
  assert.equal(highestRelease(['docs: a', 'feat: b', 'fix: c']), 'minor')
  assert.equal(highestRelease(['feat: a', 'fix!: b']), 'major')
  assert.equal(highestRelease(['Merge branch x', 'nope']), 'none')
})

test('the squash-merge PR suffix is ignored', () => {
  assert.equal(normalizeSubjectLine('feat: add x (#12)\n\nbody'), 'feat: add x')
})

test('branch prefixes map to release types', () => {
  assert.deepEqual(analyzeBranchName('refs/heads/feat/login'), {
    branch: 'feat/login',
    branchType: 'feat',
    release: 'minor',
  })
  assert.equal(analyzeBranchName('fix/crash').release, 'patch')
  assert.equal(analyzeBranchName('feature/login').release, 'none')
  assert.equal(analyzeBranchName('dev').release, 'none')
  assert.ok(supportedBranchTypes.includes('refact'))
})

test('semver bumps', () => {
  assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4')
  assert.equal(bumpVersion('v1.2.3', 'minor'), '1.3.0')
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0')
  assert.equal(bumpVersion('0.0.0', 'minor'), '0.1.0')
  assert.throws(() => bumpVersion('1.2', 'patch'))
  assert.throws(() => bumpVersion('1.2.3', 'none'))
})

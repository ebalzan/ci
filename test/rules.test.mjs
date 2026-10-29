// THE list of work types (config/types.json) must be well-formed and is
// what every reader sees. Plus the shipped JSON rules must be valid for the
// GitHub API shapes the bootstrap sends.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { deepMerge, diffTopLevel, stripDocKeys } from '../bin/_json.mjs'
import commitlintConfig, { types } from '../commitlint.config.mjs'
import { branchReleaseTypes, commitTypes } from '../scripts/release/release-utils.mjs'
import { ROOT } from './helpers.mjs'

test('types.json: release, color, minor types first; every reader sees it', () => {
  const fromFile = stripDocKeys(
    JSON.parse(readFileSync(join(ROOT, 'config', 'types.json'), 'utf8')),
  )
  const order = Object.keys(fromFile)
  const releases = order.map(type => fromFile[type].release)
  for (const [type, { release, color }] of Object.entries(fromFile)) {
    assert.ok(['minor', 'patch'].includes(release), `${type}: release must be minor or patch`)
    assert.match(color, /^[0-9A-F]{6}$/, `${type}: label color`)
  }
  assert.deepEqual(
    releases,
    [...releases].sort((a, b) => (a === b ? 0 : a === 'minor' ? -1 : 1)),
    'minor types come first: the promotion title takes the first type present',
  )

  assert.deepEqual(types, order)
  assert.deepEqual(commitlintConfig.rules['type-enum'][2], order)
  assert.deepEqual(Object.keys(commitTypes), order)
  assert.deepEqual([...branchReleaseTypes.keys()], order)
})

test('deepMerge: objects merge, arrays and scalars are replaced', () => {
  const base = { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] }
  const merged = deepMerge(base, { nested: { y: 3 }, list: [9], b: true })
  assert.deepEqual(merged, { a: 1, nested: { x: 1, y: 3 }, list: [9], b: true })
  assert.deepEqual(base.nested, { x: 1, y: 2 }, 'the base is not mutated')
})

test('stripDocKeys drops top-level $ keys only', () => {
  assert.deepEqual(stripDocKeys({ $comment: 'x', a: { $keep: 1 } }), { a: { $keep: 1 } })
})

test('diffTopLevel reports changed and unset keys', () => {
  assert.deepEqual(diffTopLevel({ a: 1, b: 'x', c: true }, { a: 1, b: 'y' }), [
    ['b', '"y"', '"x"'],
    ['c', '(unset)', 'true'],
  ])
})

test('shipped rulesets are well-formed and managed', () => {
  const dir = join(ROOT, 'config', 'rulesets')
  const files = readdirSync(dir).filter(file => file.endsWith('.json'))
  assert.ok(files.length > 0)
  const names = new Set()
  for (const file of files) {
    const ruleset = stripDocKeys(JSON.parse(readFileSync(join(dir, file), 'utf8')))
    assert.ok(ruleset.name?.startsWith('ci: '), `${file}: name must start with "ci: " (pruning)`)
    assert.ok(!names.has(ruleset.name), `${file}: duplicate name`)
    names.add(ruleset.name)
    assert.equal(ruleset.target, 'branch', file)
    assert.ok(['active', 'disabled', 'evaluate'].includes(ruleset.enforcement), file)
    assert.ok(Array.isArray(ruleset.rules) && ruleset.rules.length > 0, file)
    assert.ok(ruleset.conditions?.ref_name?.include?.length > 0, file)
  }
})

test('dev stays force-pushable: sync-dev depends on it', () => {
  const dir = join(ROOT, 'config', 'rulesets')
  for (const file of readdirSync(dir).filter(name => name.endsWith('.json'))) {
    const ruleset = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    if (ruleset.enforcement !== 'active') continue
    const coversDev = ruleset.conditions.ref_name.include.includes('refs/heads/dev')
    const blocksForcePush = ruleset.rules.some(rule => rule.type === 'non_fast_forward')
    assert.ok(!(coversDev && blocksForcePush), `${file} would break release.yml's sync-dev`)
  }
})

test('repo settings force PR-title squash commits', () => {
  const settings = JSON.parse(readFileSync(join(ROOT, 'config', 'repo-settings.json'), 'utf8'))
  assert.equal(settings.allow_squash_merge, true)
  assert.equal(settings.squash_merge_commit_title, 'PR_TITLE')
})

// THE list of work types (config/types.json) must be well-formed and is
// what every reader sees. Plus the shipped JSON rules must be valid for the
// GitHub API shapes the bootstrap sends.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { deepMerge, diffTopLevel, stripDocKeys } from '../bin/_json.mjs'
import commitlintConfig, { types } from '../commitlint.config.mjs'
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
    'minor types come first: the release PR title takes the first type present',
  )

  assert.deepEqual(types, order)
  assert.deepEqual(commitlintConfig.rules['type-enum'][2], order)
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

const ruleset = file => JSON.parse(readFileSync(join(ROOT, 'config', 'rulesets', file), 'utf8'))
const mergeMethods = ({ rules }) =>
  rules.find(rule => rule.type === 'pull_request').parameters.allowed_merge_methods

test('main and dev are never force-pushed: the release only moves them forward', () => {
  for (const [file, ref] of [
    ['protect-main.json', 'refs/heads/main'],
    ['protect-dev.json', 'refs/heads/dev'],
  ]) {
    const { enforcement, conditions, rules } = ruleset(file)
    assert.equal(enforcement, 'active', file)
    assert.deepEqual(conditions.ref_name.include, [ref], file)
    assert.ok(
      rules.some(rule => rule.type === 'non_fast_forward'),
      file,
    )
  }
})

test('work PRs squash into dev; the release PR merge-commits into main', () => {
  const dev = ruleset('require-pull-request.json')
  assert.deepEqual(dev.conditions.ref_name.include, ['refs/heads/dev'])
  assert.deepEqual(mergeMethods(dev), ['squash'])
  const main = ruleset('require-release-pr.json')
  assert.deepEqual(main.conditions.ref_name.include, ['refs/heads/main'])
  assert.deepEqual(mergeMethods(main), ['merge'])
  // The release commit and the dev sync are pushed with GITHUB_TOKEN.
  for (const { bypass_actors } of [dev, main]) {
    assert.ok(
      bypass_actors.some(actor => actor.actor_type === 'Integration' && actor.actor_id === 15368),
    )
  }
})

test('repo settings: PR-title squash commits, default merge commits, no rebase', () => {
  const settings = JSON.parse(readFileSync(join(ROOT, 'config', 'repo-settings.json'), 'utf8'))
  assert.equal(settings.allow_squash_merge, true)
  assert.equal(settings.squash_merge_commit_title, 'PR_TITLE')
  assert.equal(settings.allow_merge_commit, true)
  // `Merge pull request #N from …`: commitlint and git-cliff skip it.
  assert.equal(settings.merge_commit_title, 'MERGE_MESSAGE')
  assert.equal(settings.allow_rebase_merge, false)
})

// This repo's own workflows (.github/workflows) run its actions from the commit
// under test (./actions/<name>), never a released ebalzan/ci/…@vN, and keep the
// job and file names the onboarded templates have, which the rulesets, the
// release action and the Auto PR wait depend on.

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { ROOT } from './helpers.mjs'

const SELF = join(ROOT, '.github', 'workflows')
const TEMPLATES = join(ROOT, 'templates', '.github', 'workflows')
const read = (dir, file) => readFileSync(join(dir, file), 'utf8')
const jobNames = text => [...text.matchAll(/^ {4}name: (.+)$/gm)].map(([, name]) => name)

test('this repo has a workflow for every onboarded template', () => {
  const self = readdirSync(SELF).filter(file => file.endsWith('.yml'))
  const templates = readdirSync(TEMPLATES).filter(file => file.endsWith('.yml'))
  assert.deepEqual(self.sort(), templates.sort())
})

test('the workflows run the actions by local path, never a released tag', () => {
  let calls = 0
  for (const file of readdirSync(SELF)) {
    const text = read(SELF, file)
    assert.doesNotMatch(text, /uses: ebalzan\/ci\//i, file)
    assert.doesNotMatch(text, /__CI_(REPO|REF)__|__RUNS_ON__/, file)
    for (const [, path] of text.matchAll(/uses: \.\/(actions\/[a-z-]+)\s/g)) {
      calls++
      assert.ok(existsSync(join(ROOT, path, 'action.yml')), `${file}: ${path} is missing`)
    }
  }
  assert.ok(calls >= 3, 'auto-pr, pr-checks and release each call an action')
})

test('every job sets up through ./actions/setup, after a sparse checkout of it', () => {
  for (const file of readdirSync(SELF)) {
    const text = read(SELF, file)
    assert.doesNotMatch(text, /uses: actions\/setup-node@/, file)
    for (const job of text.split(/^ {2}[a-z-]+:$/m).slice(1)) {
      if (!job.includes('steps:')) continue
      const steps = [...job.matchAll(/^ {6}- (?:id: \S+\n {8})?uses: (\S+)/gm)].map(
        ([, uses]) => uses,
      )
      assert.deepEqual(steps.slice(0, 2), ['actions/checkout@v7', './actions/setup'], file)
      assert.equal(steps.filter(uses => uses.startsWith('actions/checkout@')).length, 1, file)
      const bootstrap = job.split('uses: ./actions/setup')[0].split('uses: actions/checkout@v7')[1]
      assert.match(bootstrap, /^ {10}sparse-checkout: actions\/setup$/m, file)
      assert.match(bootstrap, /^ {10}persist-credentials: false$/m, file)
    }
  }
})

test('the template job names are kept, so required checks still match', () => {
  for (const file of readdirSync(TEMPLATES)) {
    const self = jobNames(read(SELF, file))
    for (const name of jobNames(read(TEMPLATES, file))) {
      assert.ok(self.includes(name), `${file}: job '${name}'`)
    }
  }
})

test('only release keeps push credentials', () => {
  for (const file of readdirSync(SELF)) {
    const persists = /^ {10}checkout-persist-credentials: true$/m.test(read(SELF, file))
    assert.equal(persists, file === 'release.yml', file)
  }
})

test('release grants deploy exactly what deploy.yml asks for', () => {
  const block = text => text.match(/^( *)permissions:\n((?:\1 {2}.+\n)+)/m)[2].replace(/^ +/gm, '')
  const release = read(SELF, 'release.yml').split('\n  deploy:\n')[1]
  assert.equal(block(release), block(read(SELF, 'deploy.yml')))
})

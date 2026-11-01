// The workflow templates `onboard` writes into other repos are self-contained:
// they call this repo's composite actions (actions/<name>), never a workflow in
// its .github/, which is this repo's own.

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { ROOT } from './helpers.mjs'

const TEMPLATE_WORKFLOWS = join(ROOT, 'templates', '.github', 'workflows')
const templates = readdirSync(TEMPLATE_WORKFLOWS).filter(file => file.endsWith('.yml'))
const read = file => readFileSync(join(TEMPLATE_WORKFLOWS, file), 'utf8')

test('templates call existing actions of the CI repo, never its workflows', () => {
  let calls = 0
  for (const file of templates) {
    const text = read(file)
    assert.doesNotMatch(text, /__CI_REPO__\/\.github\//, `${file} calls a CI repo workflow`)
    for (const [, path] of text.matchAll(/uses: __CI_REPO__\/(\S+?)@__CI_REF__/g)) {
      calls++
      assert.match(path, /^actions\/[a-z-]+$/, `${file}: ${path}`)
      assert.ok(
        existsSync(join(ROOT, path, 'action.yml')),
        `${file}: ${path}/action.yml is missing`,
      )
    }
    for (const [, ref] of text.matchAll(/uses: (__CI_REPO__\/\S+)/g)) {
      assert.match(ref, /@__CI_REF__$/, `${file}: ${ref} must pin __CI_REF__`)
    }
  }
  assert.ok(calls >= 3, 'auto-pr, pr-checks and release each call an action')
})

test('pr-checks.yml reports the check names the shared rulesets require', () => {
  const text = read('pr-checks.yml')
  for (const file of readdirSync(join(ROOT, 'config', 'rulesets'))) {
    const ruleset = JSON.parse(readFileSync(join(ROOT, 'config', 'rulesets', file), 'utf8'))
    for (const rule of ruleset.rules) {
      for (const { context } of rule.parameters?.required_status_checks ?? []) {
        assert.ok(text.includes(`name: ${context}\n`), `${file} requires '${context}'`)
      }
    }
  }
})

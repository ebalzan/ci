// The workflow templates `onboard` writes into other repos are self-contained:
// they call this repo's composite actions (actions/<name>), never a workflow in
// its .github/, which is this repo's own.

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { SHIP_LABEL } from '../actions/pr-checks/release-pr/rules.mjs'
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

test('auto-pr edits the PR with GITHUB_TOKEN, so only the push or the new PR starts PR Checks', () => {
  const action = readFileSync(join(ROOT, 'actions', 'auto-pr', 'action.yml'), 'utf8')
  const stepEnv = name => action.split(`- name: ${name}\n`)[1].split('run:')[0]
  assert.match(stepEnv('Find or open PR'), /EDIT_TOKEN: \$\{\{ github\.token \}\}/)
  for (const step of ['Sync metadata', 'Describe']) {
    assert.match(stepEnv(step), /GH_TOKEN: \$\{\{ github\.token \}\}/, step)
  }
  assert.doesNotMatch(action, /gh pr ready/)
})

test('pr-checks waits for auto-pr only on the events auto-pr goes with', () => {
  const action = readFileSync(join(ROOT, 'actions', 'pr-checks', 'action.yml'), 'utf8')
  const wait = action.split('- name: Wait for Auto PR\n')[1].split('- name:')[0]
  assert.match(wait, /\["opened", "synchronize"\]/)
  assert.ok(
    action.indexOf('- name: Wait for Auto PR') < action.indexOf('- name: Conventional title'),
    'the wait comes before any check',
  )
})

test('pr-checks skips only adding the ship label to the release PR', () => {
  const text = read('pr-checks.yml')
  const adding = `github.event.action == 'labeled' && github.event.label.name == '${SHIP_LABEL}'`
  const ifOf = job => text.split(`name: pr-check / ${job}\n`)[1].split('\n')[0]
  assert.ok(ifOf('Release PR').includes(`!(${adding})`))
  assert.doesNotMatch(ifOf('Work PR'), /label/)
  assert.ok(
    text.includes(`${adding} && github.event.pull_request.head.ref == 'dev' && '-ship' || ''`),
  )
})

test('release.yml ships on the label the release PR rules name, which auto-pr creates', () => {
  const text = read('release.yml')
  assert.ok(text.includes(`github.event.label.name == '${SHIP_LABEL}'`))
  assert.match(text, /types: \[labeled, closed\]/)
  const syncMetadata = readFileSync(join(ROOT, 'actions', 'auto-pr', 'sync-metadata.sh'), 'utf8')
  assert.ok(syncMetadata.includes(`gh label create ${SHIP_LABEL} `))
})

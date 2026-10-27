import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { ROOT, runCli, tempDir } from './helpers.mjs'

test('version matches package.json', () => {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const result = runCli(['--version'])
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), version)
})

test('help lists every command; no command is an error', () => {
  const help = runCli(['help'])
  assert.equal(help.status, 0)
  for (const command of ['onboard', 'bootstrap', 'reset', 'commit-msg', 'sync-managed', 'path']) {
    assert.match(help.stdout, new RegExp(`\\b${command}\\b`))
  }
  assert.equal(runCli([]).status, 1)
})

test('unknown commands fail, including Object prototype names', () => {
  assert.equal(runCli(['nope']).status, 1)
  assert.equal(runCli(['toString']).status, 1)
})

test('path prints the package root', () => {
  assert.equal(runCli(['path']).stdout.trim(), ROOT)
})

test('commit-msg accepts a Conventional Commit subject', () => {
  assert.equal(runCli(['commit-msg', 'feat(api): add login']).status, 0)
  assert.equal(runCli(['commit-msg', 'fix!: drop legacy flag']).status, 0)
})

test('commit-msg rejects anything else, with an example', () => {
  const result = runCli(['commit-msg', 'added stuff'])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /Invalid commit message/)
  assert.match(result.stdout, /feat\(viewer\)/)
  assert.equal(runCli(['commit-msg', 'refactor: x']).status, 1)
})

test('commit-msg reads the message file husky passes, first real line only', t => {
  const dir = tempDir(t)
  const file = join(dir, 'COMMIT_EDITMSG')
  writeFileSync(file, '# comment\n\ndocs: explain setup\n\nbody line that is not conventional\n')
  assert.equal(runCli(['commit-msg', file]).status, 0)
  writeFileSync(file, 'wip\n')
  assert.equal(runCli(['commit-msg', file]).status, 1)
})

test('commit-msg lets git-generated subjects through', () => {
  for (const subject of [
    'Merge branch dev into main',
    'Revert "feat: x"',
    'fixup! feat: x',
    'squash! fix: y',
  ]) {
    assert.equal(runCli(['commit-msg', subject]).status, 0, subject)
  }
})

test('script commands forward --help to the bash tool', () => {
  for (const [command, marker] of [
    ['bootstrap', /gh-bootstrap\.sh — apply the shared rules/],
    ['reset', /gh-reset\.sh — delete GitHub Actions variables/],
    ['onboard', /onboard\.sh — bring a repo under the shared rules/],
    ['sync-managed', /DEPRECATED/],
  ]) {
    const result = runCli([command, '--help'])
    assert.equal(result.status, 0, command)
    assert.match(result.stdout, marker, command)
  }
})

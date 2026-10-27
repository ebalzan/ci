import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { gitRepo, isolatedEnv, runCli } from './helpers.mjs'

const WORKFLOWS = ['auto-pr.yml', 'pr-checks.yml', 'promote-dev-to-main.yml', 'release.yml']

test('dry run changes nothing', t => {
  const env = isolatedEnv(t)
  const { dir, git } = gitRepo(t, env)
  const result = runCli(['onboard', '-C', dir, '--dry-run', '--no-push'], { env })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /create +\.github\/workflows\/auto-pr\.yml/)
  assert.match(result.stdout, /Dry run complete/)
  assert.equal(git('status', '--porcelain'), '')
  assert.equal(git('branch', '--show-current').trim(), 'main')
})

test('--no-push renders every template and commits locally', t => {
  const env = isolatedEnv(t)
  const { dir, git } = gitRepo(t, env)
  const result = runCli(
    ['onboard', '-C', dir, '--no-push', '--runs-on', 'self-hosted', '--ref', 'v9'],
    { env },
  )
  assert.equal(result.status, 0, result.stderr + result.stdout)

  assert.equal(git('branch', '--show-current').trim(), 'ci/onboard-ebalzan-ci')
  assert.match(
    git('log', '-1', '--pretty=%s'),
    /^ci: onboard ebalzan\/ci shared workflows and rules/,
  )

  for (const name of WORKFLOWS) {
    const text = readFileSync(join(dir, '.github', 'workflows', name), 'utf8')
    assert.doesNotMatch(text, /__[A-Z_]+__/, `${name} has an unfilled placeholder`)
    assert.match(text, /uses: ebalzan\/ci\/\.github\/workflows\/[a-z-]+\.yml@v9/, name)
    assert.match(text, /runs-on: self-hosted/, name)
  }
  assert.match(
    readFileSync(join(dir, 'renovate.json'), 'utf8'),
    /github>ebalzan\/ci\/\/renovate\/tooling#v9/,
  )
  assert.ok(existsSync(join(dir, '.github', 'actions.env')))
  assert.ok(!existsSync(join(dir, '.husky', 'commit-msg')), 'no package.json → no husky hook')
})

test('a Node repo also gets the executable husky hook', t => {
  const env = isolatedEnv(t)
  const { dir } = gitRepo(t, env, { 'package.json': '{ "name": "x", "version": "1.0.0" }\n' })
  const result = runCli(['onboard', '-C', dir, '--no-push', '--no-npm'], { env })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const hook = join(dir, '.husky', 'commit-msg')
  assert.ok(existsSync(hook))
  assert.ok(statSync(hook).mode & 0o111, 'hook is executable')
  const text = readFileSync(hook, 'utf8')
  assert.match(text, /node_modules\/\.bin\/ebalzan-ci/)
  assert.match(text, /\.\.\/ci\}/)
  assert.doesNotMatch(text, /__[A-Z_]+__/)
})

test('existing files are kept unless --force', t => {
  const env = isolatedEnv(t)
  const mine = 'name: mine\n'
  const { dir, git } = gitRepo(t, env, {
    '.github/workflows/release.yml': mine,
    'renovate.json5': '{}\n',
  })
  const result = runCli(['onboard', '-C', dir, '--no-push'], { env })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(readFileSync(join(dir, '.github', 'workflows', 'release.yml'), 'utf8'), mine)
  assert.ok(!existsSync(join(dir, 'renovate.json')), 'own Renovate config is respected')

  git('switch', '--quiet', 'main')
  git('branch', '-D', 'ci/onboard-ebalzan-ci')
  const forced = runCli(['onboard', '-C', dir, '--no-push', '--force'], { env })
  assert.equal(forced.status, 0, forced.stderr + forced.stdout)
  assert.notEqual(readFileSync(join(dir, '.github', 'workflows', 'release.yml'), 'utf8'), mine)
})

test('refuses a dirty tree and an existing branch', t => {
  const env = isolatedEnv(t)
  const { dir, git } = gitRepo(t, env)
  assert.equal(runCli(['onboard', '-C', dir, '--no-push'], { env }).status, 0)
  const again = runCli(['onboard', '-C', dir, '--no-push'], { env })
  assert.equal(again.status, 1)
  assert.match(again.stderr, /already exists/)

  git('switch', '--quiet', 'main')
  git('branch', '-D', 'ci/onboard-ebalzan-ci')
  appendFileSync(join(dir, 'README.md'), 'local edit\n')
  const dirty = runCli(['onboard', '-C', dir, '--no-push'], { env })
  assert.equal(dirty.status, 1)
  assert.match(dirty.stderr, /uncommitted changes/)
})

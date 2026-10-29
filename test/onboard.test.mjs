import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { gitRepo, isolatedEnv, runCli } from './helpers.mjs'

const WORKFLOWS = ['auto-pr.yml', 'pr-checks.yml']

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
    '.github/workflows/pr-checks.yml': mine,
    'renovate.json5': '{}\n',
  })
  const result = runCli(['onboard', '-C', dir, '--no-push'], { env })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(readFileSync(join(dir, '.github', 'workflows', 'pr-checks.yml'), 'utf8'), mine)
  assert.ok(!existsSync(join(dir, 'renovate.json')), 'own Renovate config is respected')

  git('switch', '--quiet', 'main')
  git('branch', '-D', 'ci/onboard-ebalzan-ci')
  const forced = runCli(['onboard', '-C', dir, '--no-push', '--force'], { env })
  assert.equal(forced.status, 0, forced.stderr + forced.stdout)
  assert.notEqual(readFileSync(join(dir, '.github', 'workflows', 'pr-checks.yml'), 'utf8'), mine)
})

test('a caller this version replaced is removed', t => {
  const env = isolatedEnv(t)
  const old = '.github/workflows/promote-dev-to-main.yml'
  const { dir, git } = gitRepo(t, env, { [old]: 'name: Promote dev to main\n' })
  const plan = runCli(['onboard', '-C', dir, '--dry-run', '--no-push'], { env })
  assert.match(plan.stdout, /remove +\.github\/workflows\/promote-dev-to-main\.yml \(replaced/)

  const result = runCli(['onboard', '-C', dir, '--no-push'], { env })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.ok(!existsSync(join(dir, old)))
  assert.match(git('show', '--stat', 'HEAD'), /promote-dev-to-main\.yml/)
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

test('secrets files are gitignored, examples are not', t => {
  const env = isolatedEnv(t)
  const { dir, git } = gitRepo(t, env, { '.gitignore': 'node_modules/' })
  const result = runCli(['onboard', '-C', dir, '--no-push'], { env })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const ignored = path => spawnSync('git', ['check-ignore', '-q', path], { cwd: dir }).status === 0
  assert.ok(ignored('.github/secrets.env'))
  assert.ok(ignored('.github/secrets.production.env'))
  assert.ok(!ignored('.github/secrets.env.example'))
  assert.match(
    readFileSync(join(dir, '.gitignore'), 'utf8'),
    /^node_modules\/\n\n# Actions secrets/,
  )
  assert.match(git('show', '--stat', 'HEAD'), /\.gitignore/)
})

test('.gitignore is left alone when it already ignores the secrets', t => {
  const env = isolatedEnv(t)
  const { dir } = gitRepo(t, env, { '.gitignore': '.github/secrets*.env\n' })
  const result = runCli(['onboard', '-C', dir, '--no-push'], { env })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), '.github/secrets*.env\n')
})

test('a Node repo without its own style config is wired to @ebalzan/config', t => {
  const env = isolatedEnv(t)
  const { dir } = gitRepo(t, env, { 'package.json': '{ "name": "x", "version": "1.0.0" }\n' })
  const result = runCli(['onboard', '-C', dir, '--no-push', '--no-npm'], { env })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.equal(pkg.prettier, '@ebalzan/config/prettier')
  assert.match(
    readFileSync(join(dir, 'eslint.config.mjs'), 'utf8'),
    /import node from '@ebalzan\/config\/eslint\/node'/,
  )
})

test("a repo's own style config is kept, never duplicated", t => {
  const env = isolatedEnv(t)
  const { dir } = gitRepo(t, env, {
    'package.json': '{ "name": "x", "version": "1.0.0" }\n',
    '.prettierrc.json': '{ "semi": true }\n',
    'eslint.config.js': 'export default []\n',
    'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
  })
  const plan = runCli(['onboard', '-C', dir, '--dry-run', '--no-push'], { env })
  assert.equal(plan.status, 0, plan.stderr + plan.stdout)
  assert.match(plan.stdout, /skip +eslint\.config\.mjs \(repo has eslint\.config\.js/)
  assert.match(plan.stdout, /keep +\.prettierrc\.json \(own Prettier config/)
  assert.match(plan.stdout, /tsconfig\.json does not extend @ebalzan\/config\/tsconfig/)

  const result = runCli(['onboard', '-C', dir, '--no-push', '--no-npm'], { env })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.ok(!existsSync(join(dir, 'eslint.config.mjs')))
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).prettier, undefined)
})

test('--no-config and non-Node repos get no style wiring', t => {
  const env = isolatedEnv(t)
  const node = gitRepo(t, env, { 'package.json': '{ "name": "x", "version": "1.0.0" }\n' })
  assert.equal(
    runCli(['onboard', '-C', node.dir, '--no-push', '--no-npm', '--no-config'], { env }).status,
    0,
  )
  assert.ok(!existsSync(join(node.dir, 'eslint.config.mjs')))
  assert.equal(JSON.parse(readFileSync(join(node.dir, 'package.json'), 'utf8')).prettier, undefined)

  const plain = gitRepo(t, env)
  const plan = runCli(['onboard', '-C', plain.dir, '--dry-run', '--no-push'], { env })
  assert.match(plan.stdout, /skip +eslint\.config\.mjs \(no package\.json\)/)
})

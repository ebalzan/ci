// Shared helpers for the tests: throwaway git repos and a gh that is installed
// but never authenticated, so nothing can reach a real GitHub account; and the
// fixtures of the PR-rule tests.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { prConfig } from '../actions/pr-checks/rules.mjs'
import { BRANCH_DEFAULTS } from '../scripts/shared-vars.mjs'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const CLI = join(ROOT, 'bin', 'cli.mjs')

export function tempDir(t, prefix = 'ebalzan-ci-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// An environment where gh has no credentials and git has an identity.
export function isolatedEnv(t) {
  const home = tempDir(t, 'ebalzan-ci-home-')
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GH_CONFIG_DIR: join(home, '.config', 'gh'),
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    NO_COLOR: '1',
  }
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'CI_DIR']) {
    delete env[key]
  }
  // Never the operator's real config/secrets.env: an empty shared secrets dir.
  env.CI_SECRETS_DIR = tempDir(t, 'ebalzan-ci-secrets-')
  return env
}

// A git repo with one commit and the given files ({ 'path': 'content' }).
export function gitRepo(t, env, files = {}) {
  const dir = tempDir(t)
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' })
  git('init', '--quiet', '--initial-branch=main')
  writeFile(dir, 'README.md', '# test\n')
  for (const [path, content] of Object.entries(files)) writeFile(dir, path, content)
  git('add', '-A')
  git('commit', '--quiet', '-m', 'chore: initial commit')
  return { dir, git }
}

export function writeFile(dir, path, content) {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), content)
}

export function runCli(args, { env, cwd, input } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: cwd ?? ROOT,
    env: env ?? process.env,
    input,
    encoding: 'utf8',
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

// ---- PR rules (actions/pr-checks) ------------------------------------------
// prConfig() as the action sees it with no repo variables, the board owner
// defaulted to the repo owner `me`.
export const PR_CONFIG = Object.freeze({ ...prConfig(BRANCH_DEFAULTS), projectOwner: 'me' })

// Asserts one fail matches PATTERN. RESULT is a rule's { fails, warnings }, or
// the fails array itself.
export function failsWith(result, pattern) {
  const fails = Array.isArray(result) ? result : result.fails
  assert.ok(
    fails.some(message => pattern.test(message)),
    `expected a fail matching ${pattern}, got: ${JSON.stringify(fails)}`,
  )
}

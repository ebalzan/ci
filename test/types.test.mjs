// scripts/types.mjs: the work types for the actions' shell steps, on plain
// strings and through its CLI — then actions/auto-pr/work-pr.sh end to end on a
// throwaway repo, with a gh stub that logs its arguments.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { TYPES, types } from '../commitlint.config.mjs'
import { branchType, firstTitle } from '../scripts/types.mjs'
import { ROOT, gitRepo, isolatedEnv, tempDir } from './helpers.mjs'

const TYPES_CLI = join(ROOT, 'scripts', 'types.mjs')
const typesCli = (...args) =>
  spawnSync(process.execPath, [TYPES_CLI, ...args], { encoding: 'utf8' })

test('branchType: <type>/<description> with a known type, else empty', () => {
  assert.equal(branchType('feat/search'), 'feat')
  assert.equal(branchType('fix/a/b'), 'fix')
  for (const branch of ['feature/x', 'refactor/x', 'feat', 'feat/', '$comment/x', '']) {
    assert.equal(branchType(branch), '', branch)
  }
})

test('firstTitle: the first Conventional subject of the type', () => {
  const subjects = ['wip', 'fix: not this type', 'feat(ui)!: this one', 'feat: later']
  assert.equal(firstTitle('feat', subjects), 'feat(ui)!: this one')
  assert.equal(firstTitle('docs', subjects), '')
})

test('the CLI: branch-type, list, color', () => {
  assert.equal(typesCli('branch-type', 'docs/setup').stdout, 'docs\n')
  assert.equal(typesCli('branch-type', 'main').status, 1)
  assert.equal(typesCli('list').stdout, `${types.join(', ')}\n`)
  assert.doesNotMatch(typesCli('list').stdout, /\$/)
  assert.equal(typesCli('color', 'feat').stdout, `${TYPES.feat.color}\n`)
  assert.equal(typesCli('color', 'nope').status, 1)
  assert.equal(typesCli('color', 'toString').status, 1)
  assert.equal(typesCli('nope').status, 2)
})

// A work branch pushed to a bare origin, and a gh whose `pr list` finds no PR
// and whose `pr create` prints a URL.
function workBranch(t, branch, subjects) {
  const env = isolatedEnv(t)
  const origin = tempDir(t)
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=dev', origin], { env })
  const { dir, git } = gitRepo(t, env)
  git('remote', 'add', 'origin', origin)
  git('push', '--quiet', 'origin', 'HEAD:dev')
  git('fetch', '--quiet', 'origin')
  git('switch', '--quiet', '-c', branch)
  for (const subject of subjects) git('commit', '--quiet', '--allow-empty', '-m', subject)

  const bin = tempDir(t)
  writeFileSync(
    join(bin, 'gh'),
    '#!/bin/sh\necho "$*" >> "$GH_LOG"\n[ "$1 $2" = "pr create" ] && echo https://github.com/o/r/pull/1\nexit 0\n',
    { mode: 0o755 },
  )
  const temp = tempDir(t)
  const output = join(temp, 'output')
  writeFileSync(output, '')
  const result = spawnSync('bash', [join(ROOT, 'actions', 'auto-pr', 'work-pr.sh')], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_LOG: join(bin, 'gh.log'),
      GITHUB_OUTPUT: output,
      GITHUB_REF_NAME: branch,
      RUNNER_TEMP: temp,
      AUTO_BASE_BRANCH: 'dev',
    },
  })
  const read = file => {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }
  return {
    status: result.status,
    log: result.stdout + result.stderr,
    output: read(output),
    gh: read(join(bin, 'gh.log')),
  }
}

test('work-pr.sh: a misnamed branch fails with the type list', t => {
  const result = workBranch(t, 'feature/x', ['feat: a'])
  assert.equal(result.status, 1)
  assert.match(
    result.log,
    /::error::Branch 'feature\/x' is not <type>\/<description> with a type of: feat, fix,/,
  )
  assert.equal(result.gh, '')
})

test('work-pr.sh: the title is the first commit of the branch type', t => {
  const result = workBranch(t, 'feat/search', [
    'fix: unrelated',
    'feat(search)!: add filters',
    'feat: more',
  ])
  assert.equal(result.status, 0, result.log)
  assert.match(result.output, /^label=feat$/m)
  assert.match(
    result.gh,
    /^pr create --base dev --head feat\/search --title feat\(search\)!: add filters /m,
  )
})

test('work-pr.sh: without one, the title comes from the branch name', t => {
  const result = workBranch(t, 'docs/setup-guide_v2', ['fix: unrelated'])
  assert.equal(result.status, 0, result.log)
  assert.match(result.gh, /--title docs: setup guide v2 /)
})

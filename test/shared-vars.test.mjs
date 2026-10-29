// scripts/shared-vars.mjs: the AUTO_* layers every shared action reads — the job
// env first, then the caller repo's variables, then config/actions.env.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { applySharedVars, parseEnvFile } from '../scripts/shared-vars.mjs'
import { ROOT, tempDir, writeFile } from './helpers.mjs'

const quiet = { info() {}, warning() {} }

test('parseEnvFile: comments, blanks, quotes, values with =', () => {
  assert.deepEqual(parseEnvFile('# c\n\nA=1\nB="two words"\nC={"a":"b=c"}\n=x\n'), {
    A: '1',
    B: 'two words',
    C: '{"a":"b=c"}',
  })
})

test('job env beats repo variables beats config/actions.env', t => {
  const dir = tempDir(t)
  writeFile(dir, 'actions.env', 'AUTO_A=shared\nAUTO_B=shared\nAUTO_C=shared\n')
  const env = {
    AUTO_A: 'job',
    REPO_VARS_JSON: JSON.stringify({ AUTO_A: 'repo', AUTO_B: 'repo', OTHER: 'x', AUTO_E: ' ' }),
  }
  applySharedVars({ core: quiet, env, file: join(dir, 'actions.env') })
  assert.equal(env.AUTO_A, 'job')
  assert.equal(env.AUTO_B, 'repo')
  assert.equal(env.AUTO_C, 'shared')
  assert.equal(env.OTHER, undefined, 'only AUTO_* repo variables are taken')
  assert.equal(env.AUTO_E, undefined, 'a blank repo variable means unset')
})

test('run as a script, it appends what it set to $GITHUB_ENV', t => {
  const githubEnv = join(tempDir(t), 'github_env')
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'shared-vars.mjs')], {
    env: {
      PATH: process.env.PATH,
      GITHUB_ENV: githubEnv,
      REPO_VARS_JSON: '{"AUTO_PROJECT_NUMBER":"15"}',
    },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const written = readFileSync(githubEnv, 'utf8')
  assert.match(written, /^AUTO_PROJECT_NUMBER<<(ghadelimiter_[\w-]+)\n15\n\1$/m)
  assert.match(written, /^AUTO_DESCRIBE_MODEL<<(ghadelimiter_[\w-]+)\nclaude-sonnet-5-5\n\1$/m)
  assert.doesNotMatch(written, /^PATH</m, 'only the keys it set')
})

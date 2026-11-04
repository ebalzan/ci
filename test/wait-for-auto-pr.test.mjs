// actions/pr-checks/wait-for-auto-pr.sh with a fake gh: each call answers with
// the next line of a script of Actions API responses, the last one repeating.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { ROOT, tempDir } from './helpers.mjs'

const SCRIPT = join(ROOT, 'actions', 'pr-checks', 'wait-for-auto-pr.sh')
const AUTO_PR = '.github/workflows/auto-pr.yml'

const runs = (...list) =>
  JSON.stringify({ workflow_runs: list.map(([path, status]) => ({ path, status })) })

function wait(t, responses, env = {}) {
  const dir = tempDir(t)
  const calls = join(dir, 'calls')
  writeFileSync(calls, '')
  writeFileSync(join(dir, 'responses'), responses.join('\n') + '\n')
  writeFileSync(
    join(dir, 'gh'),
    `#!/usr/bin/env bash
echo "$*" >> "${calls}"
n="$(wc -l < "${calls}")"
total="$(wc -l < "${dir}/responses")"
[ "$n" -le "$total" ] || n="$total"
line="$(sed -n "\${n}p" "${dir}/responses")"
[ "$line" != FAIL ] || exit 1
echo "$line"
`,
  )
  chmodSync(join(dir, 'gh'), 0o755)
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      GH_REPO: 'me/repo',
      HEAD_SHA: 'abc123',
      WAIT_INTERVAL: '0.05',
      WAIT_GRACE: '30',
      WAIT_TIMEOUT: '30',
      ...env,
    },
  })
  return {
    status: result.status,
    stdout: result.stdout,
    calls: readFileSync(calls, 'utf8').trim().split('\n'),
  }
}

test('asks for the runs of the pushed commit', t => {
  const { calls } = wait(t, [runs([AUTO_PR, 'completed'])])
  assert.match(calls[0], /repos\/me\/repo\/actions\/runs\?head_sha=abc123&event=push/)
})

test('returns as soon as the run has finished', t => {
  const result = wait(t, [runs([AUTO_PR, 'completed'])])
  assert.equal(result.status, 0)
  assert.equal(result.calls.length, 1)
  assert.match(result.stdout, /has finished/)
})

test('waits while the run is queued or in progress, and for it to appear', t => {
  const result = wait(t, [
    runs(),
    runs([AUTO_PR, 'queued']),
    runs([AUTO_PR, 'in_progress']),
    runs([AUTO_PR, 'completed']),
  ])
  assert.equal(result.status, 0)
  assert.equal(result.calls.length, 4)
})

test('ignores other workflows, and finds a renamed copy by its path', t => {
  const other = ['.github/workflows/deploy.yml', 'in_progress']
  assert.equal(wait(t, [runs(other, [AUTO_PR, 'completed'])]).calls.length, 1)
  const self = wait(t, [runs(['.github/workflows/self-auto-pr.yml', 'completed'])])
  assert.equal(self.calls.length, 1)
})

test('a failed look is retried', t => {
  const result = wait(t, ['FAIL', runs([AUTO_PR, 'completed'])])
  assert.equal(result.status, 0)
  assert.equal(result.calls.length, 2)
})

test('with no run, gives up after the grace period without failing', t => {
  const result = wait(t, [runs()], { WAIT_GRACE: '1' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /::notice::No Auto PR run for abc123/)
})

test('a run that never finishes hits the timeout without failing', t => {
  const result = wait(t, [runs([AUTO_PR, 'in_progress'])], { WAIT_TIMEOUT: '1' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /::warning::Auto PR is still running/)
})

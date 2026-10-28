// release-main.mjs end to end against a local bare "origin" and a fake GitHub
// API (fixtures/mock-fetch.mjs): what it commits, tags and pushes.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { ROOT, isolatedEnv, tempDir, writeFile } from './helpers.mjs'

const SCRIPT = join(ROOT, 'scripts', 'release', 'release-main.mjs')
const MOCK = join(ROOT, 'test', 'fixtures', 'mock-fetch.mjs')

function setup(t, files) {
  const env = isolatedEnv(t)
  const origin = tempDir(t)
  const work = tempDir(t)
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
  git(origin, 'init', '--quiet', '--bare', '--initial-branch=main')
  git(work, 'init', '--quiet', '--initial-branch=main')
  git(work, 'remote', 'add', 'origin', origin)
  for (const [path, content] of Object.entries(files)) writeFile(work, path, content)
  writeFile(work, 'README.md', '# x\n')
  git(work, 'add', '-A')
  git(work, 'commit', '--quiet', '-m', 'feat: first feature')
  git(work, 'push', '--quiet', 'origin', 'main')

  const log = join(tempDir(t), 'fetch.log')
  const release = () =>
    spawnSync(process.execPath, ['--import', MOCK, SCRIPT], {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...env,
        GITHUB_REPOSITORY: 'someone/example',
        GITHUB_TOKEN: 'test-token',
        GITHUB_REF_NAME: 'main',
        GITHUB_SHA: git(work, 'rev-parse', 'HEAD'),
        MOCK_FETCH_LOG: log,
      },
    })
  const calls = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
  return { origin, work, git, release, calls }
}

test('without package.json: tag-only release, no commit', t => {
  const { origin, git, release, calls } = setup(t, {})
  const before = git(origin, 'rev-parse', 'main')

  const result = release()
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /tag-only release/)
  assert.equal(git(origin, 'rev-parse', 'main'), before, 'main did not move')
  assert.equal(git(origin, 'tag', '--points-at', before), 'v0.1.0')

  const created = calls().find(call => call.method === 'POST')
  assert.equal(created.path, '/repos/someone/example/releases')
  assert.equal(JSON.parse(created.body).tag_name, 'v0.1.0')
})

test('with package.json: bump, release commit, tag on it', t => {
  const { origin, git, release } = setup(t, {
    'package.json': '{ "name": "x", "version": "1.4.2" }\n',
  })
  const result = release()
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(git(origin, 'log', '-1', '--pretty=%s', 'main'), 'chore(release): 1.5.0')
  assert.equal(git(origin, 'tag', '--points-at', 'main'), 'v1.5.0')
  const pkg = JSON.parse(git(origin, 'show', 'main:package.json'))
  assert.equal(pkg.version, '1.5.0')
})

test('a re-run on an already released commit does nothing', t => {
  const { origin, git, release } = setup(t, {})
  assert.equal(release().status, 0)
  const again = release()
  assert.equal(again.status, 0, again.stderr + again.stdout)
  assert.match(again.stdout, /already released as v0\.1\.0/)
  assert.equal(git(origin, 'tag'), 'v0.1.0')
})

test('no Conventional Commit since the last tag fails the release', t => {
  const { work, git, release } = setup(t, {})
  assert.equal(release().status, 0)
  writeFile(work, 'notes.txt', 'x\n')
  git(work, 'add', '-A')
  git(work, 'commit', '--quiet', '-m', 'update notes')
  git(work, 'push', '--quiet', 'origin', 'main')
  const result = release()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Could not determine a release type/)
})

// actions/release's scripts end to end, on throwaway repos: a bare "origin", a
// working copy that plays the developer (dev, the release PR's merge), and a
// fresh clone at the merge commit that plays the runner. gh is a stub that logs
// its arguments.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { ROOT, gitRepo, isolatedEnv, tempDir, writeFile } from './helpers.mjs'

const SCRIPTS = join(ROOT, 'actions', 'release')

// main tagged v1.3.0, dev two commits ahead, the release PR merged with a merge
// commit and pushed. Returns the developer's git, origin, and the PR's SHAs.
function released(t, { files = {}, title = 'feat: release v1.4.0' } = {}) {
  const env = isolatedEnv(t)
  const origin = tempDir(t)
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin], { env })
  const { dir, git } = gitRepo(t, env, files)
  git('remote', 'add', 'origin', origin)
  git('tag', 'v1.3.0')
  git('push', '--quiet', 'origin', 'main', 'v1.3.0')
  git('switch', '--quiet', '-c', 'dev')
  writeFile(dir, 'a.txt', 'a\n')
  git('add', '-A')
  git('commit', '--quiet', '-m', 'feat: c1')
  git('commit', '--quiet', '--allow-empty', '-m', 'fix: c2')
  git('push', '--quiet', 'origin', 'dev')
  const head = git('rev-parse', 'HEAD').trim()
  git('switch', '--quiet', 'main')
  git('merge', '--quiet', '--no-ff', 'dev', '-m', 'Merge pull request #1 from o/dev', '-m', title)
  git('push', '--quiet', 'origin', 'main')
  const merge = git('rev-parse', 'HEAD').trim()
  return { env, origin, dir, git, head, merge, title }
}

// Runs one script the way the action does: in a fresh clone checked out at the
// merge commit. Returns its status, output, GITHUB_OUTPUT and the clone.
function run(t, ctx, script, extraEnv = {}) {
  const clone = tempDir(t)
  execFileSync('git', ['clone', '--quiet', ctx.origin, clone], { env: ctx.env })
  execFileSync('git', ['checkout', '--quiet', '--detach', ctx.merge], { cwd: clone, env: ctx.env })
  return runIn(t, ctx, clone, script, extraEnv)
}

function runIn(t, ctx, clone, script, extraEnv = {}) {
  const temp = tempDir(t)
  const outputFile = join(temp, 'output')
  writeFileSync(outputFile, '')
  const result = spawnSync('bash', [join(SCRIPTS, script)], {
    cwd: clone,
    encoding: 'utf8',
    env: {
      ...ctx.env,
      AUTO_BASE_BRANCH: 'dev',
      AUTO_RELEASE_BRANCH: 'main',
      GITHUB_OUTPUT: outputFile,
      RUNNER_TEMP: temp,
      HEAD_SHA: ctx.head,
      MERGE_SHA: ctx.merge,
      PR_TITLE: ctx.title,
      ...extraEnv,
    },
  })
  const output = Object.fromEntries(
    readFileSync(outputFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  )
  return { status: result.status, log: result.stdout + result.stderr, output, clone, temp }
}

const originGit = (ctx, ...args) =>
  execFileSync('git', ['--git-dir', ctx.origin, ...args], { env: ctx.env, encoding: 'utf8' }).trim()

test('verify-merge: a merge commit of the PR head passes', t => {
  const ctx = released(t)
  const result = run(t, ctx, 'verify-merge.sh')
  assert.equal(result.status, 0, result.log)
})

test('verify-merge: a squash or rebase merge, or another head, fails', t => {
  const ctx = released(t)
  ctx.git('reset', '--quiet', '--hard', 'v1.3.0')
  ctx.git('merge', '--quiet', '--squash', 'dev')
  ctx.git('commit', '--quiet', '-m', 'feat: release v1.4.0')
  ctx.git('push', '--quiet', '--force', 'origin', 'main')
  const squash = run(t, { ...ctx, merge: ctx.git('rev-parse', 'HEAD').trim() }, 'verify-merge.sh')
  assert.equal(squash.status, 1)
  assert.match(squash.log, /was not merged with a merge commit/)

  const other = run(t, { ...ctx, head: ctx.git('rev-parse', 'v1.3.0').trim() }, 'verify-merge.sh')
  assert.equal(other.status, 1)
})

test('release: bumps package.json in a release commit, tags it, pushes main and the tag', t => {
  const ctx = released(t, { files: { 'package.json': '{ "name": "x", "version": "1.3.0" }\n' } })
  const result = run(t, ctx, 'release.sh')
  assert.equal(result.status, 0, result.log)
  assert.equal(result.output.tag, 'v1.4.0')
  assert.equal(result.output.version, '1.4.0')

  assert.equal(originGit(ctx, 'rev-parse', 'main'), result.output.sha)
  assert.equal(originGit(ctx, 'rev-parse', 'v1.4.0^{commit}'), result.output.sha)
  assert.equal(originGit(ctx, 'log', '-1', '--format=%s', 'main'), 'chore(release): 1.4.0')
  assert.equal(originGit(ctx, 'rev-parse', 'main^'), ctx.merge)
  const pkg = JSON.parse(originGit(ctx, 'show', 'main:package.json'))
  assert.equal(pkg.version, '1.4.0')

  // A re-run (a fresh checkout at the merge commit) finds the tag.
  const again = run(t, ctx, 'release.sh')
  assert.equal(again.status, 0, again.log)
  assert.equal(again.output.sha, result.output.sha)
  assert.match(again.log, /v1\.4\.0 already exists/)
  assert.equal(originGit(ctx, 'rev-parse', 'main'), result.output.sha)
})

test('release: without package.json the merge commit itself is tagged', t => {
  const ctx = released(t)
  const result = run(t, ctx, 'release.sh')
  assert.equal(result.status, 0, result.log)
  assert.equal(result.output.sha, ctx.merge)
  assert.equal(originGit(ctx, 'rev-parse', 'v1.4.0^{commit}'), ctx.merge)
})

test('release: a PR title main does not compute releases nothing', t => {
  const ctx = released(t, { title: 'fix: release v1.3.1' })
  const result = run(t, ctx, 'release.sh')
  assert.equal(result.status, 1)
  assert.match(result.log, /main' computes 'feat: release v1\.4\.0'/)
  assert.equal(originGit(ctx, 'tag', '--list', 'v1.4.0'), '')
})

test('sync-dev: dev fast-forwards to the release', t => {
  const ctx = released(t, { files: { 'package.json': '{ "name": "x", "version": "1.3.0" }\n' } })
  const release = run(t, ctx, 'release.sh')
  const result = runIn(t, ctx, release.clone, 'sync-dev.sh', { RELEASE_SHA: release.output.sha })
  assert.equal(result.status, 0, result.log)
  assert.equal(originGit(ctx, 'rev-parse', 'dev'), release.output.sha)

  const again = runIn(t, ctx, release.clone, 'sync-dev.sh', { RELEASE_SHA: release.output.sha })
  assert.equal(again.status, 0, again.log)
  assert.match(again.log, /already at the release/)
})

test('sync-dev: work landed on dev meanwhile — main is merged into it', t => {
  const ctx = released(t, { files: { 'package.json': '{ "name": "x", "version": "1.3.0" }\n' } })
  const release = run(t, ctx, 'release.sh')
  ctx.git('switch', '--quiet', 'dev')
  ctx.git('commit', '--quiet', '--allow-empty', '-m', 'fix: c4')
  ctx.git('push', '--quiet', 'origin', 'dev')
  const c4 = ctx.git('rev-parse', 'HEAD').trim()

  const result = runIn(t, ctx, release.clone, 'sync-dev.sh', { RELEASE_SHA: release.output.sha })
  assert.equal(result.status, 0, result.log)
  assert.equal(originGit(ctx, 'log', '-1', '--format=%s', 'dev'), "Merge branch 'main' into dev")
  assert.equal(originGit(ctx, 'rev-parse', 'dev^1'), c4)
  assert.equal(originGit(ctx, 'rev-parse', 'dev^2'), release.output.sha)

  // The next release PR starts from the new tag: c4 alone.
  ctx.git('pull', '--quiet', '--ff-only', '--tags', 'origin', 'dev')
  const title = execFileSync('node', [join(ROOT, 'scripts', 'release-title.mjs')], {
    cwd: ctx.dir,
    env: ctx.env,
    encoding: 'utf8',
  })
  assert.equal(title.trim(), 'fix: release v1.4.1')
})

test('sync-dev: a conflict or a rewritten dev fails, dev untouched', t => {
  const ctx = released(t, { files: { 'package.json': '{ "name": "x", "version": "1.3.0" }\n' } })
  const release = run(t, ctx, 'release.sh')
  ctx.git('switch', '--quiet', 'dev')
  writeFile(ctx.dir, 'package.json', '{ "name": "x", "version": "9.9.9" }\n')
  ctx.git('commit', '--quiet', '-am', 'fix: c4')
  ctx.git('push', '--quiet', 'origin', 'dev')
  const c4 = ctx.git('rev-parse', 'HEAD').trim()

  const conflict = runIn(t, ctx, release.clone, 'sync-dev.sh', { RELEASE_SHA: release.output.sha })
  assert.equal(conflict.status, 1)
  assert.match(conflict.log, /conflicts/)
  assert.equal(originGit(ctx, 'rev-parse', 'dev'), c4)

  ctx.git('switch', '--quiet', '--orphan', 'other')
  ctx.git('commit', '--quiet', '--allow-empty', '-m', 'chore: unrelated')
  ctx.git('push', '--quiet', '--force', 'origin', 'other:dev')
  const rewritten = runIn(t, ctx, release.clone, 'sync-dev.sh', {
    RELEASE_SHA: release.output.sha,
  })
  assert.equal(rewritten.status, 1)
  assert.match(rewritten.log, /no longer contains the release PR's head/)
})

// A gh that logs each call; `gh release view` answers with GH_VIEW_STATUS.
function stubGh(t) {
  const bin = tempDir(t)
  const log = join(bin, 'gh.log')
  writeFileSync(
    join(bin, 'gh'),
    '#!/bin/sh\necho "$*" >> "$GH_LOG"\n[ "$1 $2" = "release view" ] && exit "${GH_VIEW_STATUS:-1}"\nexit 0\n',
    { mode: 0o755 },
  )
  return { bin, log }
}

test('publish: creates the Release with the PR description, or edits it on a re-run', t => {
  const ctx = released(t)
  const release = run(t, ctx, 'release.sh')
  const gh = stubGh(t)
  const env = {
    PATH: `${gh.bin}:${process.env.PATH}`,
    GH_LOG: gh.log,
    TAG: release.output.tag,
    PR_BODY: '## Summary\nFilters.',
  }

  const created = runIn(t, ctx, release.clone, 'publish.sh', env)
  assert.equal(created.status, 0, created.log)
  assert.match(
    readFileSync(gh.log, 'utf8'),
    /^release create v1\.4\.0 --verify-tag --title v1\.4\.0/m,
  )
  assert.equal(
    readFileSync(join(created.temp, 'release-notes.md'), 'utf8'),
    '## Summary\nFilters.\n',
  )

  const edited = runIn(t, ctx, release.clone, 'publish.sh', { ...env, GH_VIEW_STATUS: '0' })
  assert.equal(edited.status, 0, edited.log)
  assert.match(readFileSync(gh.log, 'utf8'), /^release edit v1\.4\.0/m)
})

test('publish: without a PR description, the changelog since the previous tag', t => {
  const ctx = released(t)
  const release = run(t, ctx, 'release.sh')
  const gh = stubGh(t)
  const result = runIn(t, ctx, release.clone, 'publish.sh', {
    PATH: `${gh.bin}:${process.env.PATH}`,
    GH_LOG: gh.log,
    TAG: release.output.tag,
    PR_BODY: '  \n',
  })
  assert.equal(result.status, 0, result.log)
  const notesFile = join(result.temp, 'release-notes.md')
  assert.ok(existsSync(notesFile))
  const notes = readFileSync(notesFile, 'utf8')
  assert.match(notes, /^## Changes\n/)
  assert.match(notes, /### feat\n\n- c1 \([0-9a-f]{7}\)\n\n### fix\n\n- c2/)
  assert.doesNotMatch(notes, /initial commit|Merge pull request/)
})

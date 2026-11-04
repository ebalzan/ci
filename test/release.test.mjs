// actions/release's scripts end to end, on throwaway repos: a bare "origin", a
// working copy that plays the developer (main, dev and the release PR's head),
// and a fresh clone at the PR's head that plays the runner. gh is a stub that
// logs its arguments.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { ROOT, gitRepo, isolatedEnv, tempDir, writeFile } from './helpers.mjs'

const SCRIPTS = join(ROOT, 'actions', 'release')

// main tagged v1.3.0 and dev two commits ahead, both pushed: the release PR as
// it waits for its `ship` label. Returns the developer's git, origin, and the
// PR's head.
function releasePr(t, { files = {}, title = 'feat: release v1.4.0' } = {}) {
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
  return { env, origin, dir, git, head, title }
}

// Runs one script the way the action does: in a fresh clone checked out at the
// PR's head. Returns its status, output, GITHUB_OUTPUT and the clone.
function run(t, ctx, script, extraEnv = {}) {
  const clone = tempDir(t)
  execFileSync('git', ['clone', '--quiet', ctx.origin, clone], { env: ctx.env })
  execFileSync('git', ['checkout', '--quiet', '--detach', ctx.head], { cwd: clone, env: ctx.env })
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
      MERGE_SHA: ctx.merge ?? '',
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

// A gh that logs each call. `gh release view` answers with GH_VIEW_STATUS;
// `gh api` (the check runs) prints GH_CHECK_RUN, as its --jq would, or runs its
// real --jq filter over GH_CHECK_RUNS (the API's JSON).
function stubGh(t) {
  const bin = tempDir(t)
  const log = join(bin, 'gh.log')
  writeFileSync(
    join(bin, 'gh'),
    '#!/bin/sh\necho "$*" >> "$GH_LOG"\n' +
      '[ "$1 $2" = "release view" ] && exit "${GH_VIEW_STATUS:-1}"\n' +
      'if [ "$1" = api ] && [ -n "${GH_CHECK_RUNS:-}" ]; then\n' +
      '  while [ "$1" != --jq ]; do shift; done\n' +
      '  printf %s "$GH_CHECK_RUNS" | jq -r "$2"\n' +
      '  exit 0\n' +
      'fi\n' +
      '[ "$1" = api ] && printf \'%s\\n\' "${GH_CHECK_RUN:-}"\n' +
      'exit 0\n',
    { mode: 0o755 },
  )
  return { bin, log }
}

// verify.sh's env: the stub gh, and the PR check passed unless overridden.
function checkEnv(t, extra = {}) {
  const gh = stubGh(t)
  return {
    PATH: `${gh.bin}:${process.env.PATH}`,
    GH_LOG: gh.log,
    GH_REPO: 'o/r',
    CHECK_NAME: 'pr-check / Release PR',
    GH_CHECK_RUN: 'completed success',
    CHECK_POLL: '0',
    ...extra,
  }
}

test('verify: dev at the PR head, main behind it, the check passed', t => {
  const ctx = releasePr(t)
  const env = checkEnv(t)
  const result = run(t, ctx, 'verify.sh', env)
  assert.equal(result.status, 0, result.log)
  assert.match(result.log, /'main' fast-forwards to 'dev'/)
  assert.match(
    readFileSync(env.GH_LOG, 'utf8'),
    new RegExp(`commits/${ctx.head}/check-runs .*check_name=pr-check / Release PR`),
  )
})

test('verify: the check failed, never ran, or is still running', t => {
  const ctx = releasePr(t)
  for (const [check, pattern] of [
    ['completed failure', /concluded 'failure'/],
    ['', /never ran/],
    ['in_progress null', /still 'in_progress'/],
  ]) {
    const env = checkEnv(t, { GH_CHECK_RUN: check, CHECK_TIMEOUT: '0' })
    const result = run(t, ctx, 'verify.sh', env)
    assert.equal(result.status, 1, check)
    assert.match(result.log, pattern)
  }
})

test('verify: the skipped run the ship label starts does not count', t => {
  const ctx = releasePr(t)
  const skipped = { id: 9, status: 'completed', conclusion: 'skipped' }
  for (const [earlier, status, pattern] of [
    [{ id: 1, status: 'completed', conclusion: 'success' }, 0, /'main' fast-forwards to 'dev'/],
    [{ id: 1, status: 'completed', conclusion: 'failure' }, 1, /concluded 'failure'/],
    [{ id: 1, status: 'in_progress', conclusion: null }, 1, /still 'in_progress'/],
    [skipped, 1, /never ran/],
  ]) {
    const env = checkEnv(t, {
      GH_CHECK_RUNS: JSON.stringify({ check_runs: [skipped, earlier] }),
      CHECK_TIMEOUT: '0',
    })
    const result = run(t, ctx, 'verify.sh', env)
    assert.equal(result.status, status, result.log)
    assert.match(result.log, pattern)
  }
})

test('verify: dev moved, main has commits dev does not, or dev has a merge commit', t => {
  const moved = releasePr(t)
  moved.git('commit', '--quiet', '--allow-empty', '-m', 'fix: c3')
  moved.git('push', '--quiet', 'origin', 'dev')
  const movedResult = run(t, moved, 'verify.sh', checkEnv(t))
  assert.equal(movedResult.status, 1)
  assert.match(movedResult.log, /'dev' moved since the release PR was labelled/)

  const ahead = releasePr(t)
  ahead.git('switch', '--quiet', 'main')
  ahead.git('commit', '--quiet', '--allow-empty', '-m', 'fix: hotfix')
  ahead.git('push', '--quiet', 'origin', 'main')
  const aheadResult = run(t, ahead, 'verify.sh', checkEnv(t))
  assert.equal(aheadResult.status, 1)
  assert.match(aheadResult.log, /cannot fast-forward to 'dev'/)

  const merged = releasePr(t)
  merged.git('switch', '--quiet', '-c', 'side', 'HEAD^')
  merged.git('commit', '--quiet', '--allow-empty', '-m', 'fix: side')
  merged.git('switch', '--quiet', 'dev')
  merged.git('merge', '--quiet', '--no-ff', '--no-edit', 'side')
  merged.git('push', '--quiet', 'origin', 'dev')
  merged.head = merged.git('rev-parse', 'HEAD').trim()
  const mergedResult = run(t, merged, 'verify.sh', checkEnv(t))
  assert.equal(mergedResult.status, 1)
  assert.match(mergedResult.log, /1 merge commit\(s\)/)
})

test('verify: a head already on main is a re-run', t => {
  const ctx = releasePr(t)
  assert.equal(run(t, ctx, 'release.sh').status, 0)
  const result = run(t, ctx, 'verify.sh', checkEnv(t, { GH_CHECK_RUN: '' }))
  assert.equal(result.status, 0, result.log)
  assert.match(result.log, /already on 'main': a re-run/)
})

test('release: bumps package.json in a release commit, tags it, fast-forwards main and dev', t => {
  const ctx = releasePr(t, { files: { 'package.json': '{ "name": "x", "version": "1.3.0" }\n' } })
  const result = run(t, ctx, 'release.sh')
  assert.equal(result.status, 0, result.log)
  assert.equal(result.output.tag, 'v1.4.0')

  assert.equal(originGit(ctx, 'rev-parse', 'main'), result.output.sha)
  assert.equal(originGit(ctx, 'rev-parse', 'dev'), result.output.sha)
  assert.equal(originGit(ctx, 'rev-parse', 'v1.4.0^{commit}'), result.output.sha)
  assert.equal(originGit(ctx, 'log', '-1', '--format=%s', 'main'), 'chore(release): 1.4.0')
  // The PR's commits reached main as they are: no merge commit, same SHAs.
  assert.equal(originGit(ctx, 'rev-parse', 'main^'), ctx.head)
  assert.equal(originGit(ctx, 'rev-list', '--merges', '--count', 'main'), '0')
  const pkg = JSON.parse(originGit(ctx, 'show', 'main:package.json'))
  assert.equal(pkg.version, '1.4.0')
  assert.equal(originGit(ctx, 'rev-parse', 'v1^{commit}'), result.output.sha)

  // A re-run (a fresh checkout at the PR's head) finds the tag.
  const again = run(t, ctx, 'release.sh')
  assert.equal(again.status, 0, again.log)
  assert.equal(again.output.sha, result.output.sha)
  assert.match(again.log, /v1\.4\.0 already exists/)
  assert.equal(originGit(ctx, 'rev-parse', 'main'), result.output.sha)
})

test('release: without package.json the PR head itself is tagged', t => {
  const ctx = releasePr(t)
  const result = run(t, ctx, 'release.sh')
  assert.equal(result.status, 0, result.log)
  assert.equal(result.output.sha, ctx.head)
  assert.equal(originGit(ctx, 'rev-parse', 'v1.4.0^{commit}'), ctx.head)
  assert.equal(originGit(ctx, 'rev-parse', 'main'), ctx.head)
  assert.equal(originGit(ctx, 'rev-parse', 'dev'), ctx.head)
})

test('release: the major tag moves to the release, and a re-run only ever moves it forward', t => {
  const ctx = releasePr(t)
  ctx.git('tag', 'v1', 'v1.3.0')
  ctx.git('push', '--quiet', 'origin', 'v1')
  const result = run(t, ctx, 'release.sh')
  assert.equal(result.status, 0, result.log)
  assert.equal(originGit(ctx, 'rev-parse', 'v1^{commit}'), ctx.head)
  assert.equal(
    originGit(ctx, 'rev-parse', 'v1.3.0^{commit}'),
    ctx.git('rev-parse', 'v1.3.0').trim(),
  )

  // Missing (a release tagged by hand): a re-run creates it.
  ctx.git('push', '--quiet', 'origin', ':refs/tags/v1')
  const created = run(t, ctx, 'release.sh')
  assert.equal(created.status, 0, created.log)
  assert.match(created.log, /Moved v1 to v1\.4\.0/)
  assert.equal(originGit(ctx, 'rev-parse', 'v1^{commit}'), ctx.head)

  // Ahead (a later release): a re-run of this one leaves it there.
  ctx.git('commit', '--quiet', '--allow-empty', '-m', 'fix: later')
  ctx.git('push', '--quiet', '--force', 'origin', 'HEAD:refs/tags/v1')
  const later = ctx.git('rev-parse', 'HEAD').trim()
  const again = run(t, ctx, 'release.sh')
  assert.equal(again.status, 0, again.log)
  assert.doesNotMatch(again.log, /Moved v1/)
  assert.equal(originGit(ctx, 'rev-parse', 'v1^{commit}'), later)
})

test('release: a PR title the head does not compute releases nothing', t => {
  const ctx = releasePr(t, { title: 'fix: release v1.3.1' })
  const result = run(t, ctx, 'release.sh')
  assert.equal(result.status, 1)
  assert.match(result.log, /its head computes 'feat: release v1\.4\.0'/)
  assert.equal(originGit(ctx, 'tag', '--list', 'v1.4.0'), '')
})

test('release: dev moved during the release, so nothing is pushed', t => {
  const ctx = releasePr(t)
  ctx.git('commit', '--quiet', '--allow-empty', '-m', 'fix: c3')
  ctx.git('push', '--quiet', 'origin', 'dev')
  const result = run(t, ctx, 'release.sh')
  assert.equal(result.status, 1)
  assert.match(result.log, /moved during the release, so nothing was pushed/)
  assert.equal(originGit(ctx, 'tag', '--list', 'v1.4.0'), '')
  assert.equal(originGit(ctx, 'rev-parse', 'main'), ctx.git('rev-parse', 'v1.3.0').trim())
})

test('check-merged: a release PR shipped by fast-forward passes', t => {
  const ctx = releasePr(t)
  const release = run(t, ctx, 'release.sh')
  const result = run(t, { ...ctx, merge: release.output.sha }, 'check-merged.sh')
  assert.equal(result.status, 0, result.log)
  assert.match(result.log, /released by fast-forward/)
})

test('check-merged: a release PR merged with a button fails with how to put main back', t => {
  const ctx = releasePr(t)
  ctx.git('switch', '--quiet', 'main')
  ctx.git('merge', '--quiet', '--squash', 'dev')
  ctx.git('commit', '--quiet', '-m', 'feat: release v1.4.0')
  ctx.git('push', '--quiet', 'origin', 'main')
  const merge = ctx.git('rev-parse', 'HEAD').trim()
  const result = run(t, { ...ctx, merge }, 'check-merged.sh')
  assert.equal(result.status, 1)
  assert.match(result.log, /merged with a GitHub merge button/)
  const before = ctx.git('rev-parse', 'v1.3.0').trim()
  assert.ok(
    result.log.includes(`--force-with-lease=main:${merge} origin ${before}:refs/heads/main`),
  )
})

test('publish: creates the Release with the PR description, or edits it on a re-run', t => {
  const ctx = releasePr(t)
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
  const ctx = releasePr(t)
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

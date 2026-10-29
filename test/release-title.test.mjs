// The release PR's title (scripts/release-title.mjs): the pure rule on plain
// objects, then end to end with git-cliff (config/cliff.toml) on throwaway
// repos — the version, the moving major tags, the changelog.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

import { releaseTitle, unreleased } from '../scripts/release-title.mjs'
import { ROOT, gitRepo, isolatedEnv } from './helpers.mjs'

const commit = (raw_message, breaking = false) => ({ raw_message, breaking })

test('the first type in config/types.json order wins', () => {
  const commits = [commit('refact: a'), commit('fix(api): b (#4)'), commit('docs: c')]
  assert.equal(releaseTitle({ version: 'v1.2.1', commits }), 'fix: release v1.2.1')
  commits.push(commit('feat(search): d'))
  assert.equal(releaseTitle({ version: '1.3.0', commits }), 'feat: release v1.3.0')
})

test('a breaking commit adds the !', () => {
  const commits = [commit('refact: a\n\nBREAKING CHANGE: b', true)]
  assert.equal(releaseTitle({ version: 'v2.0.0', commits }), 'refact!: release v2.0.0')
})

test('nothing to release: no title', () => {
  assert.equal(releaseTitle({ version: 'v1.0.1', commits: [] }), '')
  assert.equal(releaseTitle({ version: null, commits: [commit('fix: a')] }), '')
})

// A repo whose history is the given commit messages, tagged where asked.
function history(t, steps) {
  const env = isolatedEnv(t)
  const { dir, git } = gitRepo(t, env)
  for (const step of steps) {
    if (step.startsWith('tag ')) git('tag', step.slice(4))
    else git('commit', '--quiet', '--allow-empty', '-m', step)
  }
  return dir
}

const titleOf = dir => releaseTitle(unreleased(dir))

test('git-cliff: bumps from the last vX.Y.Z tag, ignoring the moving major tag', t => {
  const steps = ['tag v1.2.0', 'refact: a', 'fix: b', 'tag v1']
  assert.equal(titleOf(history(t, steps)), 'fix: release v1.2.1')
  assert.equal(titleOf(history(t, [...steps, 'Merge branch x', 'feat: c'])), 'feat: release v1.3.0')
  assert.equal(
    titleOf(history(t, [...steps, 'docs: c\n\nBREAKING CHANGE: d'])),
    'fix!: release v2.0.0',
  )
  assert.equal(titleOf(history(t, ['tag v0.3.0', 'feat!: a'])), 'feat!: release v1.0.0')
})

test('git-cliff: no tag yet starts at v0.1.0; a released HEAD has no title', t => {
  assert.equal(titleOf(history(t, ['fix: a'])), 'fix: release v0.1.0')
  assert.equal(titleOf(history(t, ['fix: a', 'tag v0.1.0'])), '')
})

test('git-cliff: the changelog groups by type, feat first', t => {
  const dir = history(t, ['tag v1.0.0', 'fix(api): b (#4)', 'feat: a', 'chore(release): 1.0.1'])
  const changelog = execFileSync(
    join(ROOT, 'node_modules', '.bin', 'git-cliff'),
    ['--config', join(ROOT, 'config', 'cliff.toml'), '--unreleased', '--bump', '--strip', 'all'],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )
  assert.match(changelog, /### feat\n\n- a \([0-9a-f]{7}\)\n\n### fix\n\n- \*\*api:\*\* b \(#4\)/)
  assert.doesNotMatch(changelog, /chore|<!--/)
})

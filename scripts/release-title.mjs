// The release PR's title: `<type>[!]: release vX.Y.Z`, from the commits on dev
// that are not released yet. It names the release: the first type present in
// config/types.json's order (the minor types lead), `!` when a commit is
// breaking. The version is git-cliff's (config/cliff.toml). Merged with a merge
// commit, the release PR brings the same commits to main, where actions/release
// recomputes the title and requires it to equal the PR's.
//
// Two ways in:
//   import { releaseTitle } from './release-title.mjs'   (tests)
//   node scripts/release-title.mjs                       (actions/auto-pr, actions/pr-check,
//                                                         actions/release)
// The second prints the title for the checkout in the current directory, or
// nothing when there is no Conventional Commit to release.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../', import.meta.url)
const GIT_CLIFF = fileURLToPath(new URL('node_modules/.bin/git-cliff', ROOT))
const CLIFF_CONFIG = fileURLToPath(new URL('config/cliff.toml', ROOT))
const TYPES = Object.keys(
  JSON.parse(readFileSync(new URL('config/types.json', ROOT), 'utf8')),
).filter(key => !key.startsWith('$'))

const HEADER = /^(\w+)(?:\([^)]*\))?!?: /

/**
 * @param version  the next version, with or without the `v`
 * @param commits  git-cliff's unreleased commits: [{ raw_message, breaking }]
 * @returns the title, or '' when there is nothing to release
 */
export function releaseTitle({ version, commits }) {
  if (!version || commits.length === 0) return ''
  const present = new Set(commits.map(commit => commit.raw_message.match(HEADER)?.[1]))
  const type = TYPES.find(candidate => present.has(candidate)) ?? 'chore'
  const breaking = commits.some(commit => commit.breaking)
  return `${type}${breaking ? '!' : ''}: release v${version.replace(/^v/, '')}`
}

// git-cliff's unreleased release for the checkout in `cwd`: { version, commits }.
export function unreleased(cwd = process.cwd()) {
  const context = execFileSync(
    GIT_CLIFF,
    ['--config', CLIFF_CONFIG, '--unreleased', '--bump', '--context'],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    },
  )
  const [release] = JSON.parse(context)
  return release ?? { version: null, commits: [] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const title = releaseTitle(unreleased())
    if (title) console.log(title)
  } catch (error) {
    console.error(`git-cliff failed:\n${error.stderr || error.message}`)
    process.exit(1)
  }
}

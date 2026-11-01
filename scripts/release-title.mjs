// The release PR's title: `<type>[!]: release vX.Y.Z`, from the commits on dev
// that are not released yet. It names the release: the first type present in
// config/types.json's order (the minor types lead), `!` when a commit is
// breaking. The version is git-cliff's (config/cliff.toml). Merged with a merge
// commit, the release PR brings the same commits to main, where actions/release
// recomputes the title and requires it to equal the PR's. The format is built
// and read back only here.
//
// Two ways in:
//   import { releaseTitle } from './release-title.mjs'   (tests)
//   node scripts/release-title.mjs                       (actions/auto-pr, actions/pr-checks,
//                                                         actions/release)
//   node scripts/release-title.mjs --version-of TITLE    (actions/release)
// The first prints the title for the checkout in the current directory, or
// nothing when there is no Conventional Commit to release. The second prints
// the X.Y.Z a release title names, or nothing when TITLE is not one.

import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { HEADER_PATTERN, types } from '../commitlint.config.mjs'
import { gitCliff } from './changelog.mjs'

// What releaseTitle() builds.
export const RELEASE_TITLE_PATTERN =
  /^(?<type>\w+)(?<breaking>!)?: release v(?<version>\d+\.\d+\.\d+)$/

/**
 * @param version  the next version, with or without the `v`
 * @param commits  git-cliff's unreleased commits: [{ raw_message, breaking }]
 * @returns the title, or '' when there is nothing to release
 */
export function releaseTitle({ version, commits }) {
  if (!version || commits.length === 0) return ''
  const present = new Set(
    commits.map(commit => commit.raw_message.match(HEADER_PATTERN)?.groups.type),
  )
  const type = types.find(candidate => present.has(candidate)) ?? 'chore'
  const breaking = commits.some(commit => commit.breaking)
  return `${type}${breaking ? '!' : ''}: release v${version.replace(/^v/, '')}`
}

// The X.Y.Z a release title names, or '' when TITLE is not one.
export const releaseVersion = title => RELEASE_TITLE_PATTERN.exec(title)?.groups.version ?? ''

// git-cliff's unreleased release for the checkout in `cwd`: { version, commits }.
export function unreleased(cwd = process.cwd()) {
  const [release] = JSON.parse(gitCliff(['--unreleased', '--bump', '--context'], { cwd }))
  return release ?? { version: null, commits: [] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, title = ''] = process.argv.slice(2)
  try {
    const out = flag === '--version-of' ? releaseVersion(title) : releaseTitle(unreleased())
    if (out) console.log(out)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

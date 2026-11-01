// git-cliff (config/cliff.toml), the one place its binary, its config and the
// changelog's heading are named. The release title (release-title.mjs) reads
// its context; the release PR body (actions/auto-pr/release-pr.sh) and the
// fallback GitHub Release notes (actions/release/publish.sh) are its changelog.
//
// Two ways in:
//   import { changelog, gitCliff } from './changelog.mjs'   (release-title.mjs, tests)
//   node scripts/changelog.mjs [git-cliff args…]            (actions/auto-pr, actions/release)
// The second prints `## Changes` and the changelog of the checkout in the
// current directory, with the given range arguments (e.g. --unreleased --bump,
// or v1.2.0..v1.3.0).

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../', import.meta.url)
const GIT_CLIFF = fileURLToPath(new URL('node_modules/.bin/git-cliff', ROOT))
const CLIFF_CONFIG = fileURLToPath(new URL('config/cliff.toml', ROOT))

export const HEADING = '## Changes'

// git-cliff ARGS in CWD with config/cliff.toml: its stdout, or a throw with its
// stderr.
export function gitCliff(args, { cwd = process.cwd() } = {}) {
  const result = spawnSync(GIT_CLIFF, ['--config', CLIFF_CONFIG, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  })
  if (result.error) throw new Error(`git-cliff failed: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`git-cliff failed:\n${result.stderr.trim()}`)
  return result.stdout
}

// The changelog of RANGE_ARGS, under its heading, as markdown.
export function changelog(rangeArgs, options) {
  return `${HEADING}\n${gitCliff([...rangeArgs, '--strip', 'all'], options)}`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(changelog(process.argv.slice(2)))
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

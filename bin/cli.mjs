#!/usr/bin/env node
//
// ebalzan-ci — the command-line entry point of @ebalzan/ci.
//
// sync is lib/sync.mjs, onboard lib/onboard.mjs. `ebalzan-ci <cmd> --help`
// prints the command's own help.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { onboard } from '../lib/onboard.mjs'
import { sync } from '../lib/sync.mjs'

const BIN_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(BIN_DIR)
const COMMITLINT_CONFIG = join(ROOT, 'commitlint.config.mjs')

const HELP = `Usage: ebalzan-ci <command> [options]

Commands:
  sync           Push variables, secrets, settings and rulesets to this repo
  onboard        Add the shared workflows, hook and rules to a repo, then sync it
  commit-msg     Validate a commit message (the husky commit-msg hook calls this)
  path           Print the package directory (to read config/)
  version        Print the package version
  help           Show this help

Run 'ebalzan-ci <command> --help' for a command's options.`

function version() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
}

// commit-msg FILE|SUBJECT — husky passes the path of the message file; a
// non-path argument is checked as the subject itself (handy for scripts). The
// subject goes through commitlint with commitlint.config.mjs — the rule the
// work-PR check applies to the PR title and commits. Subjects git writes itself
// (Merge …, Revert "…", fixup! …) are let through by commitlint's defaults.
function commitMsg(args) {
  const [arg] = args
  if (!arg || arg === '--help' || arg === '-h') {
    console.log('Usage: ebalzan-ci commit-msg <message-file | subject>')
    return arg ? 0 : 1
  }
  const text = existsSync(arg) ? readFileSync(arg, 'utf8') : arg
  const subject =
    text
      .split(/\r?\n/)
      .find(line => line.trim() && !line.startsWith('#'))
      ?.trim() ?? ''
  const result = spawnSync(process.execPath, [commitlintCli(), '--config', COMMITLINT_CONFIG], {
    input: `${subject}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  if (result.error) {
    console.error(`ebalzan-ci: could not run commitlint: ${result.error.message}`)
    return 127
  }
  if (result.status === 0) return 0
  console.log(`Invalid commit message: "${subject}"`)
  console.log('Use Conventional Commits, for example:')
  console.log('  feat(viewer): add section filters')
  console.log('  fix: prevent null model crash')
  return 1
}

function commitlintCli() {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('@commitlint/cli/package.json')), 'cli.js')
}

async function main(argv) {
  const [command, ...args] = argv
  switch (command) {
    case 'sync':
    case 'bootstrap': // the 3.x name, still written in onboarded repos
      return sync(args)
    case 'onboard':
      return onboard(args)
    case 'commit-msg':
      return commitMsg(args)
    case 'path':
      console.log(ROOT)
      return 0
    case 'version':
    case '--version':
    case '-v':
      console.log(version())
      return 0
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP)
      return command === undefined ? 1 : 0
    default:
      console.error(`ebalzan-ci: unknown command '${command}'.\n\n${HELP}`)
      return 1
  }
}

process.exit(await main(process.argv.slice(2)))

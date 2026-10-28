#!/usr/bin/env node
//
// ebalzan-ci — the command-line entry point of @ebalzan/ci.
//
// Every command except commit-msg, path and version runs one of the bash tools
// next to this file with the arguments unchanged, so `ebalzan-ci <cmd> --help`
// prints that tool's own help. Reference: docs/CLI.md.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const BIN_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(BIN_DIR)
const VALIDATOR = join(ROOT, 'managed', 'scripts', 'release', 'validate-conventional-subject.sh')

const SCRIPTS = {
  bootstrap: 'gh-bootstrap.sh',
  reset: 'gh-reset.sh',
  onboard: 'onboard.sh',
}

// Subjects git writes itself; they are not Conventional Commits and need not be.
const GIT_GENERATED = /^(Merge |Revert "|fixup! |squash! |amend! )/

const HELP = `Usage: ebalzan-ci <command> [options]

Commands:
  onboard        Add the shared workflows, hook and rules to a repo, then bootstrap it
  bootstrap      Sync variables, secrets, settings and rulesets onto a repo (or --all)
  reset          Delete Actions variables/secrets on a repo (typed confirmation)
  commit-msg     Validate a commit message (the husky commit-msg hook calls this)
  path           Print the package directory (to source bin/_lib.sh, read config/)
  version        Print the package version
  help           Show this help

Run 'ebalzan-ci <command> --help' for a command's options.
Docs: https://github.com/ebalzan/ci#readme`

function version() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
}

// commit-msg FILE|SUBJECT — husky passes the path of the message file; a
// non-path argument is checked as the subject itself (handy for scripts).
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
  if (GIT_GENERATED.test(subject)) return 0
  return run('sh', [VALIDATOR, subject, 'commit message'])
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) {
    console.error(`ebalzan-ci: could not run ${command}: ${result.error.message}`)
    if (command === 'bash' || command === 'sh') {
      console.error('The tools need a POSIX shell (Linux, macOS, WSL or Git Bash on Windows).')
    }
    return 127
  }
  return result.status ?? 1
}

function main(argv) {
  const [command, ...args] = argv
  if (Object.hasOwn(SCRIPTS, command ?? ''))
    return run('bash', [join(BIN_DIR, SCRIPTS[command]), ...args])
  switch (command) {
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

process.exit(main(process.argv.slice(2)))

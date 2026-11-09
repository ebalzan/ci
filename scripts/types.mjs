// The work types (config/types.json, through commitlint.config.mjs) for the
// shell steps of the actions, so that `types` and HEADER_PATTERN stay the only
// definitions of a type and of a Conventional header.
//
// Two ways in:
//   import { branchType, workTitle } from './types.mjs'    (actions/pr-checks, tests)
//   node scripts/types.mjs <command> …                     (actions/auto-pr)
// Commands:
//   branch-type BRANCH      the type of a <type>/<description> branch; exits 1
//                           when BRANCH is not one
//   list                    the types, comma-separated (for messages)
//   color TYPE              the type's label color; exits 1 for an unknown type
//   work-title BRANCH RANGE the work PR's title: the branch name in the
//                           Conventional shape, `!` when a commit in RANGE
//                           (git log) is breaking — `refact/ifc-parsing` →
//                           `refact: ifc parsing` or `refact!: ifc parsing`
//   with-breaking TITLE     TITLE with `!` after its type (and scope); nothing
//                           when it already has one or is not a Conventional
//                           header

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { HEADER_PATTERN, TYPES, types } from '../commitlint.config.mjs'

// The type of BRANCH when it is <type>/<description> with a known type, else ''.
export function branchType(branch) {
  const [type, ...rest] = branch.split('/')
  return types.includes(type) && rest.join('/') !== '' ? type : ''
}

// A commit that releases a major: `!` in its header or a BREAKING CHANGE footer.
export const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m
export const isBreaking = message =>
  Boolean(HEADER_PATTERN.exec(message)?.groups.breaking) || BREAKING_FOOTER.test(message)

// The work PR's title for BRANCH (<type>/<description>): `<type>[!]: <description>`
// with - and _ as spaces, `!` when one of MESSAGES (full commit messages) is
// breaking. '' when BRANCH is not a work branch. The title becomes the squash
// commit on dev, so the `!` is what carries the major into the release.
export function workTitle(branch, messages = []) {
  const type = branchType(branch)
  if (!type) return ''
  const description = branch
    .slice(type.length + 1)
    .replace(/[-_/]+/g, ' ')
    .trim()
  return `${type}${messages.some(isBreaking) ? '!' : ''}: ${description}`
}

// TITLE with `!` before its `: `, or '' when it has one or is not a Conventional header.
export function withBreaking(title) {
  const header = HEADER_PATTERN.exec(title)
  if (!header || header.groups.breaking) return ''
  const { type, scope, subject } = header.groups
  return `${type}${scope ? `(${scope})` : ''}!: ${subject}`
}

function main([command, ...args]) {
  const print = value => {
    if (!value) return 1
    console.log(value)
    return 0
  }
  switch (command) {
    case 'branch-type':
      return print(branchType(args[0] ?? ''))
    case 'list':
      return print(types.join(', '))
    case 'color':
      return print(Object.hasOwn(TYPES, args[0] ?? '') && TYPES[args[0]].color)
    case 'work-title': {
      const [branch = '', range = ''] = args
      // NUL-separated full messages: a footer can sit in any commit's body.
      const log = execFileSync('git', ['log', '--format=%B%x00', range], { encoding: 'utf8' })
      return print(workTitle(branch, log.split('\0')))
    }
    case 'with-breaking':
      print(withBreaking(args[0] ?? ''))
      return 0
    default:
      console.error(`types.mjs: unknown command '${command ?? ''}'.`)
      return 2
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}

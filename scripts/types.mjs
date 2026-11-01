// The work types (config/types.json, through commitlint.config.mjs) for the
// shell steps of the actions, so that `types` and HEADER_PATTERN stay the only
// definitions of a type and of a Conventional header.
//
// Two ways in:
//   import { branchType, firstTitle } from './types.mjs'   (actions/pr-checks, tests)
//   node scripts/types.mjs <command> …                     (actions/auto-pr)
// Commands:
//   branch-type BRANCH      the type of a <type>/<description> branch; exits 1
//                           when BRANCH is not one
//   list                    the types, comma-separated (for messages)
//   color TYPE              the type's label color; exits 1 for an unknown type
//   first-title TYPE RANGE  the first subject in RANGE (git log, oldest first)
//                           that is a Conventional header of TYPE; nothing when
//                           there is none

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

// The first of SUBJECTS that is a Conventional header of TYPE, else ''.
export const firstTitle = (type, subjects) =>
  subjects.find(subject => HEADER_PATTERN.exec(subject)?.groups.type === type) ?? ''

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
    case 'first-title': {
      const [type = '', range = ''] = args
      const log = execFileSync('git', ['log', '--reverse', '--format=%s', range], {
        encoding: 'utf8',
      })
      print(firstTitle(type, log.split('\n')))
      return 0
    }
    default:
      console.error(`types.mjs: unknown command '${command ?? ''}'.`)
      return 2
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}

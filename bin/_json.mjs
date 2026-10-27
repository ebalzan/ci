#!/usr/bin/env node
//
// _json.mjs — JSON helpers for the bash tools (bash has no JSON of its own, and
// node is already a requirement of the package). Not a public command.
//
//   merge FILE...          Deep-merge the files left to right (later wins) and
//                          print the result. Objects merge key by key; arrays
//                          and scalars are replaced whole. Missing files are
//                          skipped. Top-level keys starting with `$` (e.g.
//                          "$comment") are documentation and are dropped.
//   get FILE KEY           Print one top-level value (strings unquoted).
//   diff DESIRED CURRENT   Print `key<TAB>current<TAB>desired` for every
//                          top-level key of DESIRED whose value differs in
//                          CURRENT. Exit 0 either way.
//
// Used by gh-bootstrap.sh for config/repo-settings.json and config/rulesets/.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

function fail(message) {
  console.error(`_json.mjs: ${message}`)
  process.exit(2)
}

function read(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`${file}: ${error instanceof Error ? error.message : error}`)
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override
  const merged = { ...base }
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in base ? deepMerge(base[key], value) : value
  }
  return merged
}

export function stripDocKeys(value) {
  if (!isPlainObject(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('$')))
}

export function diffTopLevel(desired, current) {
  const rows = []
  for (const [key, value] of Object.entries(desired)) {
    const now = current?.[key]
    if (JSON.stringify(now) !== JSON.stringify(value)) {
      rows.push([key, now === undefined ? '(unset)' : JSON.stringify(now), JSON.stringify(value)])
    }
  }
  return rows
}

function main(argv) {
  const [command, ...args] = argv
  switch (command) {
    case 'merge': {
      const docs = args.filter(file => existsSync(file)).map(read)
      if (docs.length === 0) fail('merge: none of the files exist')
      process.stdout.write(`${JSON.stringify(stripDocKeys(docs.reduce(deepMerge)), null, 2)}\n`)
      return
    }
    case 'get': {
      const [file, key] = args
      const value = read(file)?.[key]
      if (value === undefined || value === null) return
      process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
      return
    }
    case 'diff': {
      const [desired, current] = args
      for (const row of diffTopLevel(read(desired), read(current))) {
        process.stdout.write(`${row.join('\t')}\n`)
      }
      return
    }
    default:
      fail(`unknown command '${command ?? ''}' (merge | get | diff)`)
  }
}

// Run as a script, not when imported by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2))
}

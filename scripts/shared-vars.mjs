// The AUTO_* knobs every shared action reads: the caller repo's variables
// first, then config/actions.env from the copy of this repo the runner
// downloaded for `uses: ebalzan/ci/actions/<name>@<ref>` (the whole repo at
// that ref), then BRANCH_DEFAULTS — the one place `dev` and `main` are the
// default branches; the scripts after it require AUTO_BASE_BRANCH and
// AUTO_RELEASE_BRANCH. Nothing copies the shared values onto the calling
// repos, so a shared value changes by moving the ref.
//
// Two ways in:
//   import { applySharedVars } from './shared-vars.mjs'   (tests)
//   node scripts/shared-vars.mjs                          (the first step of every action)
// The second applies them to a copy of the environment and appends every key it
// set to $GITHUB_ENV, so the job's later steps see them as plain env vars.

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { parseEnvFile } from '../lib/config.mjs'

const SHARED_VARS_FILE = fileURLToPath(new URL('../config/actions.env', import.meta.url))

// Work PRs merge into AUTO_BASE_BRANCH; the release PR merges it into
// AUTO_RELEASE_BRANCH. The workflow templates set both in the job env.
export const BRANCH_DEFAULTS = { AUTO_BASE_BRANCH: 'dev', AUTO_RELEASE_BRANCH: 'main' }

// The caller repo's variables, passed whole by the workflows as
// `REPO_VARS_JSON: ${{ toJSON(vars) }}` — so a repo can set any AUTO_* knob,
// including ones added later, without a workflow edit. Only AUTO_* keys are
// taken; a key the job env already sets (AUTO_BASE_BRANCH, from an input) wins.
export function applyRepoVars({ core, env }) {
  const raw = (env.REPO_VARS_JSON ?? '').trim()
  if (!raw) return

  let vars
  try {
    vars = JSON.parse(raw)
  } catch {
    core.warning('REPO_VARS_JSON is not valid JSON; ignoring repo variables.')
    return
  }
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return

  const applied = []
  for (const [key, value] of Object.entries(vars)) {
    if (!key.startsWith('AUTO_') || typeof value !== 'string' || !value.trim()) continue
    if ((env[key] ?? '').trim()) continue
    env[key] = value
    applied.push(key)
  }

  if (applied.length > 0) {
    core.info(`Repo variables: ${applied.join(', ')}`)
  }
}

// Repo variables first, then every AUTO_* knob still unset from
// config/actions.env, then the branch defaults. A repo variable always wins.
export function applySharedVars({ core, env, file = SHARED_VARS_FILE }) {
  applyRepoVars({ core, env })

  if (existsSync(file)) {
    const applied = fillUnset(env, parseEnvFile(readFileSync(file, 'utf8')))
    if (applied.length > 0) {
      core.info(`Shared variables from config/actions.env: ${applied.join(', ')}`)
    }
  } else {
    core.warning(`Shared variables file not found at ${file}; using repo variables only.`)
  }

  fillUnset(env, BRANCH_DEFAULTS)
}

// Sets each key of VARS that ENV leaves unset or blank; returns those keys.
function fillUnset(env, vars) {
  const applied = []
  for (const [key, value] of Object.entries(vars)) {
    if ((env[key] ?? '').trim()) continue
    env[key] = value
    applied.push(key)
  }
  return applied
}

// One $GITHUB_ENV entry per key, in the multiline form so no value can break
// out of its line.
export function toGithubEnv(vars) {
  return Object.entries(vars)
    .map(([key, value]) => {
      const delimiter = `ghadelimiter_${randomUUID()}`
      return `${key}<<${delimiter}\n${value}\n${delimiter}\n`
    })
    .join('')
}

function main() {
  const env = { ...process.env }
  applySharedVars({
    core: { info: console.log, warning: message => console.log(`::warning::${message}`) },
    env,
  })

  const changed = Object.fromEntries(
    Object.entries(env).filter(([key, value]) => process.env[key] !== value),
  )
  if (!process.env.GITHUB_ENV) {
    console.log(toGithubEnv(changed))
    return
  }
  appendFileSync(process.env.GITHUB_ENV, toGithubEnv(changed))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { CoreClient } from './types'

// The shared variables, read from the copy of tracebim-ci the runner downloaded
// for `uses: ebalzan/tracebim-ci/actions/auto-work-items@<ref>` (the whole repo
// at that ref; dist/ → auto-work-items/ → actions/ → repo root). Nothing copies
// them onto the calling repos, so a shared value changes by moving the ref.
// scripts/release/promote-dev-to-main.mjs reads the same file the same way.
const SHARED_VARS_FILE = join(__dirname, '..', '..', '..', 'config', 'actions.env')

// KEY=VALUE lines; blank lines and `#` comments skipped, one pair of
// surrounding quotes stripped — the dotenv subset bin/_lib.sh reads.
export function parseEnvFile(text: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue
    const i = line.indexOf('=')
    if (i < 1) continue
    let value = line.slice(i + 1)
    if (value.length >= 2 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1)
    vars[line.slice(0, i).trim()] = value
  }
  return vars
}

// The caller repo's variables, passed whole by the workflows as
// `REPO_VARS_JSON: ${{ toJSON(vars) }}` — so a repo can set any AUTO_* knob,
// including ones added later, without a workflow edit. Only AUTO_* keys are
// taken; a key the job env already sets (AUTO_BASE_BRANCH, from an input) wins.
export function applyRepoVars({
  core,
  env,
}: {
  core: Pick<CoreClient, 'info' | 'warning'>
  env: NodeJS.ProcessEnv
}): void {
  const raw = (env.REPO_VARS_JSON ?? '').trim()
  if (!raw) return

  let vars: unknown
  try {
    vars = JSON.parse(raw)
  } catch {
    core.warning('REPO_VARS_JSON is not valid JSON; ignoring repo variables.')
    return
  }
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return

  const applied: string[] = []
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
// config/actions.env. A repo variable always wins; the code defaults still
// apply to keys neither layer sets.
export function applySharedVars({
  core,
  env,
  file = SHARED_VARS_FILE,
}: {
  core: Pick<CoreClient, 'info' | 'warning'>
  env: NodeJS.ProcessEnv
  file?: string
}): void {
  applyRepoVars({ core, env })

  if (!existsSync(file)) {
    core.warning(`Shared variables file not found at ${file}; using repo variables only.`)
    return
  }

  const applied: string[] = []
  for (const [key, value] of Object.entries(parseEnvFile(readFileSync(file, 'utf8')))) {
    if ((env[key] ?? '').trim()) continue
    env[key] = value
    applied.push(key)
  }

  if (applied.length > 0) {
    core.info(`Shared variables from config/actions.env: ${applied.join(', ')}`)
  }
}

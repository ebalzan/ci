// config.mjs — what a repo should look like on GitHub, read from files only.
//
// Every section has two layers: the SHARED one (this package's config/) and
// the repo's OWN one (<repo>/.github/). For any key the repo's value wins.
// Nothing here talks to GitHub; lib/sync.mjs compares the result with it.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

// A value that was copied from an .example and never filled in.
const PLACEHOLDER = /xxxx|sk-ant-xxx|github_pat_xxx/i

// KEY=VALUE lines; blank lines and `#` comments skipped, one pair of
// surrounding quotes stripped.
export function parseEnvFile(text) {
  const vars = {}
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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Objects merge key by key; arrays and scalars are replaced whole.
export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override
  const merged = { ...base }
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in base ? deepMerge(base[key], value) : value
  }
  return merged
}

// Top-level keys starting with `$` (e.g. "$comment") are documentation.
export function stripDocKeys(value) {
  if (!isPlainObject(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('$')))
}

// [key, current, desired] for every top-level key of DESIRED that differs in CURRENT.
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

function readEnv(file) {
  return existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {}
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file}: ${error.message}`)
  }
}

// mergeJson FILE... — missing files skipped, later wins; null when none exist.
function mergeJson(...files) {
  const docs = files.filter(file => existsSync(file)).map(readJson)
  return docs.length ? stripDocKeys(docs.reduce(deepMerge)) : null
}

// mergeEnv SHARED REPO — one entry per key: { name, key, value, file, layer }.
// `layer` says where the value comes from, and flags a repo line that only
// repeats the shared value (it can be deleted). For secrets, FOO_FILE and FOO
// are the same key, so either layer can override the other.
export function mergeEnv(sharedFile, repoFile, { secrets = false } = {}) {
  const merged = new Map()
  for (const [file, layer] of [
    [sharedFile, 'shared'],
    [repoFile, 'repo'],
  ]) {
    for (const [key, value] of Object.entries(readEnv(file))) {
      const name = secrets ? key.replace(/_FILE$/, '') : key
      const shared = merged.get(name)
      let label = layer
      if (shared?.layer === 'shared' && layer === 'repo') {
        label =
          shared.key === key && shared.value === value
            ? 'repo (same as shared: redundant)'
            : 'repo (overrides shared)'
      }
      merged.set(name, { name, key, value, file, layer: label })
    }
  }
  return [...merged.values()]
}

// The value to push for a secret entry, refusing empty and placeholder values:
// a secret cannot be read back to notice a bad write. KEY_FILE=path yields that
// file's contents (multiline values cannot live in a dotenv file); a relative
// path is relative to the env file.
export function secretValue({ key, value, file }) {
  if (key.endsWith('_FILE')) {
    let path = value.replace(/^~(?=\/|$)/, homedir())
    if (!isAbsolute(path)) path = join(dirname(file), path)
    if (!existsSync(path))
      throw new Error(`${key} in ${file} points to '${value}', which does not exist.`)
    return readFileSync(path, 'utf8')
  }
  if (!value)
    throw new Error(`${key} has an empty value in ${file}. Fill it in, or comment the line out.`)
  if (PLACEHOLDER.test(value))
    throw new Error(`${key} in ${file} is still a placeholder. Fill it in.`)
  return value
}

// Where the shared secrets files live: they are gitignored, so never inside an
// installed npm package.
export function sharedSecretsDir(ciRoot, env = process.env) {
  if (env.CI_SECRETS_DIR) return env.CI_SECRETS_DIR
  if (existsSync(join(ciRoot, '.git'))) return join(ciRoot, 'config')
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'ebalzan-ci')
}

function filesIn(dir, pattern) {
  return existsSync(dir) ? readdirSync(dir).filter(name => pattern.test(name)) : []
}

// desiredState — the merged config for the repo checked out at REPO_DIR:
//   variables     [entry]   shared ones are read by the actions at run time
//   secrets       { repository: [entry], environments: { name: [entry] } }
//   settings      object | null
//   rulesets      [{ file, body }]
export function desiredState({ sharedDir, secretsDir, repoDir }) {
  const own = join(repoDir, '.github')

  const environments = {}
  const envNames = [
    ...filesIn(secretsDir, /^secrets\..+\.env$/),
    ...filesIn(own, /^secrets\..+\.env$/),
  ].map(name => name.slice('secrets.'.length, -'.env'.length))
  for (const env of [...new Set(envNames)].sort()) {
    environments[env] = mergeEnv(
      join(secretsDir, `secrets.${env}.env`),
      join(own, `secrets.${env}.env`),
      {
        secrets: true,
      },
    )
  }

  const rulesetFiles = [
    ...new Set([
      ...filesIn(join(sharedDir, 'rulesets'), /\.json$/),
      ...filesIn(join(own, 'rulesets'), /\.json$/),
    ]),
  ].sort()
  const rulesets = rulesetFiles.map(file => {
    const body = mergeJson(join(sharedDir, 'rulesets', file), join(own, 'rulesets', file))
    if (!body.name) throw new Error(`Ruleset ${file} has no "name".`)
    return { file, body }
  })

  return {
    variables: mergeEnv(join(sharedDir, 'actions.env'), join(own, 'actions.env')),
    secrets: {
      repository: mergeEnv(join(secretsDir, 'secrets.env'), join(own, 'secrets.env'), {
        secrets: true,
      }),
      environments,
    },
    settings: mergeJson(join(sharedDir, 'repo-settings.json'), join(own, 'repo-settings.json')),
    rulesets,
  }
}

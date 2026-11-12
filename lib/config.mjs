// config.mjs — what a repo should look like on GitHub, read from files only.
//
// Every section has two layers: the SHARED one (this package's config/) and
// the repo's OWN one (<repo>/.github/). For any key the repo's value wins.
// Nothing here talks to GitHub; lib/sync.mjs compares the result with it.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

// A value that was copied from an .example and never filled in.
const PLACEHOLDER = /xxxx/i

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
    throw new Error(`${file}: ${error.message}`, { cause: error })
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

// ---- validation ----------------------------------------------------------------
// GitHub ignores keys it does not know, so a typo would sync "successfully" and
// change nothing. These lists follow the REST API (PATCH /repos/{owner}/{repo},
// POST /repos/{owner}/{repo}/rulesets); add to them when GitHub adds a field.
// Rule parameters are not checked: GitHub rejects bad ones itself.
export const REPO_SETTINGS_KEYS = new Set([
  'name',
  'description',
  'homepage',
  'private',
  'visibility',
  'security_and_analysis',
  'has_issues',
  'has_projects',
  'has_wiki',
  'has_discussions',
  'is_template',
  'default_branch',
  'allow_squash_merge',
  'allow_merge_commit',
  'allow_rebase_merge',
  'allow_auto_merge',
  'allow_update_branch',
  'allow_forking',
  'delete_branch_on_merge',
  'use_squash_pr_title_as_default',
  'squash_merge_commit_title',
  'squash_merge_commit_message',
  'merge_commit_title',
  'merge_commit_message',
  'web_commit_signoff_required',
  'archived',
])
const RULESET_KEYS = new Set([
  'name',
  'target',
  'enforcement',
  'bypass_actors',
  'conditions',
  'rules',
])
const RULESET_ENUMS = {
  target: ['branch', 'tag', 'push'],
  enforcement: ['disabled', 'active', 'evaluate'],
}
export const RULE_TYPES = new Set([
  'creation',
  'update',
  'deletion',
  'required_linear_history',
  'merge_queue',
  'required_deployments',
  'required_signatures',
  'pull_request',
  'required_status_checks',
  'non_fast_forward',
  'commit_message_pattern',
  'commit_author_email_pattern',
  'committer_email_pattern',
  'branch_name_pattern',
  'tag_name_pattern',
  'file_path_restriction',
  'max_file_path_length',
  'file_extension_restriction',
  'max_file_size',
  'workflows',
  'code_scanning',
  'copilot_code_review',
])

const unknownKeys = (object, known) => Object.keys(object).filter(key => !known.has(key))

export function validateSettings(settings, where) {
  const unknown = unknownKeys(settings, REPO_SETTINGS_KEYS)
  if (unknown.length)
    throw new Error(`${where}: unknown repository setting(s) ${unknown.join(', ')}.`)
}

export function validateRuleset(body, where) {
  if (!body.name) throw new Error(`Ruleset ${where} has no "name".`)
  const unknown = unknownKeys(body, RULESET_KEYS)
  if (unknown.length) throw new Error(`Ruleset ${where}: unknown key(s) ${unknown.join(', ')}.`)
  for (const [key, allowed] of Object.entries(RULESET_ENUMS)) {
    if (key in body && !allowed.includes(body[key]))
      throw new Error(
        `Ruleset ${where}: ${key} is '${body[key]}', expected one of ${allowed.join(', ')}.`,
      )
  }
  for (const rule of body.rules ?? []) {
    if (!RULE_TYPES.has(rule?.type))
      throw new Error(`Ruleset ${where}: unknown rule type '${rule?.type}'.`)
  }
}

// The keys of EXAMPLE (secrets.env.example) that no layer sets — a secret
// added to the example after the real file was copied from it. KEY_FILE counts
// as KEY.
export function missingSecrets(exampleFile, entries) {
  const have = new Set(entries.map(entry => entry.name))
  return Object.keys(readEnv(exampleFile))
    .map(key => key.replace(/_FILE$/, ''))
    .filter(name => !have.has(name))
}

function filesIn(dir, pattern) {
  return existsSync(dir) ? readdirSync(dir).filter(name => pattern.test(name)) : []
}

// desiredState — the merged config for the repo checked out at REPO_DIR:
//   variables     [entry]   shared ones are read by the actions at run time
//   secrets       { repository: [entry], environments: { name: [entry] },
//                   missing: [name] }   in secrets.env.example, set by no layer
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
    validateRuleset(body, file)
    return { file, body }
  })

  const settings = mergeJson(join(sharedDir, 'repo-settings.json'), join(own, 'repo-settings.json'))
  if (settings) validateSettings(settings, 'repo-settings.json')

  const repository = mergeEnv(join(secretsDir, 'secrets.env'), join(own, 'secrets.env'), {
    secrets: true,
  })

  return {
    variables: mergeEnv(join(sharedDir, 'actions.env'), join(own, 'actions.env')),
    secrets: {
      repository,
      environments,
      missing: missingSecrets(join(sharedDir, 'secrets.env.example'), repository),
    },
    settings,
    rulesets,
  }
}

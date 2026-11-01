// github.mjs — the GitHub side, through the gh CLI (it owns authentication).
// Every call throws with gh's own message when it fails.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function gh(args, { input } = {}) {
  const result = spawnSync('gh', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) {
    throw new Error(
      result.error.code === 'ENOENT'
        ? 'GitHub CLI (gh) is not installed: https://cli.github.com'
        : result.error.message,
    )
  }
  if (result.status !== 0) throw new Error(result.stderr.trim() || `gh ${args.join(' ')} failed`)
  return result.stdout
}

const ghJson = args => JSON.parse(gh(args) || 'null')

export function isAuthenticated() {
  try {
    gh(['auth', 'status'])
    return true
  } catch {
    return false
  }
}

export function requireAuth() {
  gh(['--version'])
  if (!isAuthenticated()) throw new Error('gh is not authenticated. Run: gh auth login')
}

// ---- repos -------------------------------------------------------------------
export const isCheckout = dir => existsSync(join(dir, '.git'))

// OWNER/REPO of the checkout at DIR, or ''. Starts from the git remote, then
// asks GitHub for the canonical name, so a transferred repo resolves to where
// it lives now.
export function detectRepo(dir) {
  const remote = spawnSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' })
  if (remote.status !== 0) return ''
  const slug = remote.stdout
    .trim()
    .replace(/^(git@|ssh:\/\/git@|https:\/\/)[^/:]+[:/]/, '')
    .replace(/\.git$/, '')
  try {
    return (
      gh(['repo', 'view', slug, '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim() || slug
    )
  } catch {
    return slug
  }
}

// Creates branch NAME on GitHub at the head of the default branch:
// { from: the default branch, sha }.
export function createBranchFromDefault(repo, name) {
  const from = gh([
    'repo',
    'view',
    repo,
    '--json',
    'defaultBranchRef',
    '-q',
    '.defaultBranchRef.name',
  ]).trim()
  const sha = gh(['api', `repos/${repo}/commits/${from}`, '-q', '.sha']).trim()
  gh([
    'api',
    '-X',
    'POST',
    `repos/${repo}/git/refs`,
    '-f',
    `ref=refs/heads/${name}`,
    '-f',
    `sha=${sha}`,
  ])
  return { from, sha }
}

// ---- variables & secrets -----------------------------------------------------
// KIND is "variable" or "secret"; ENV, when given, is an environment's scope.
const scope = (repo, env) => (env ? ['--repo', repo, '--env', env] : ['--repo', repo])

export const listNames = (kind, repo, env) =>
  ghJson([kind, 'list', ...scope(repo, env), '--json', 'name']).map(entry => entry.name)

export const setVariable = (repo, name, value) =>
  gh(['variable', 'set', name, '--body', value, '--repo', repo])

export const setSecret = (repo, name, value, env) =>
  gh(['secret', 'set', name, ...scope(repo, env)], { input: value })

export const deleteEntry = (kind, repo, name, env) =>
  gh([kind, 'delete', name, ...scope(repo, env)])

// Idempotent: PUT creates the environment or leaves it as it is.
export const createEnvironment = (repo, env) =>
  gh(['api', '-X', 'PUT', `repos/${repo}/environments/${env}`])

// ---- settings & rulesets -----------------------------------------------------
export const getRepo = repo => ghJson(['api', `repos/${repo}`])

export const patchRepo = (repo, settings) =>
  gh(['api', '-X', 'PATCH', `repos/${repo}`, '--input', '-'], { input: JSON.stringify(settings) })

// The repo's own rulesets (not those inherited from an organization).
export const listRulesets = repo =>
  ghJson(['api', `repos/${repo}/rulesets?includes_parents=false`]).filter(
    ruleset => ruleset.source_type === 'Repository',
  )

export const createRuleset = (repo, body) =>
  gh(['api', '-X', 'POST', `repos/${repo}/rulesets`, '--input', '-'], {
    input: JSON.stringify(body),
  })

export const updateRuleset = (repo, id, body) =>
  gh(['api', '-X', 'PUT', `repos/${repo}/rulesets/${id}`, '--input', '-'], {
    input: JSON.stringify(body),
  })

export const deleteRuleset = (repo, id) =>
  gh(['api', '-X', 'DELETE', `repos/${repo}/rulesets/${id}`])

// The API's answer when rulesets need a paid plan (a private repo on GitHub Free).
export const rulesetsUnavailable = error =>
  /upgrade to github pro|make this repository public/i.test(error.message)

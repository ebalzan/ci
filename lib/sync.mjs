// sync.mjs — `ebalzan-ci sync`: make GitHub repos match the config files.
// lib/config.mjs reads what each repo should have; lib/github.mjs reads and
// writes what it has. Every step prints what it does; --dry-run stops before
// any write.

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { desiredState, diffTopLevel, secretValue, sharedSecretsDir } from './config.mjs'
import * as github from './github.mjs'
import { bold, confirm, dim, fail, info, ok, step, warn } from './log.mjs'

const CI_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SHARED_DIR = join(CI_ROOT, 'config')
const SECTIONS = ['vars', 'secrets', 'settings', 'rulesets']
// Rulesets named like this are managed here, and --prune may delete them.
const MANAGED_RULESET_PREFIX = 'ci: '

export const HELP = `Usage: ebalzan-ci sync [options]

Make the GitHub repo of the checkout you run it in match the config files:
Actions variables and secrets, repository settings and branch rulesets. Each comes from two layers; for any
key, the repo's own value wins.

                        shared, every repo               the repo's own
  variables             config/actions.env               .github/actions.env
  secrets               <secrets>/secrets.env            .github/secrets.env
  environment secrets   <secrets>/secrets.<env>.env      .github/secrets.<env>.env
  repository settings   config/repo-settings.json        .github/repo-settings.json
  branch rulesets       config/rulesets/<file>.json      .github/rulesets/<file>.json

  - Shared variables are not pushed: the actions read config/actions.env at run
    time, so changing one only needs a new release of this package.
  - JSON files deep-merge; top-level keys starting with $ are comments. A
    ruleset is matched to the one on GitHub by its "name".
  - KEY_FILE=path in a secrets file sets KEY from that file's contents.
  - Secrets files are gitignored. <secrets> is $CI_SECRETS_DIR, else config/ in
    a git checkout of this package, else ~/.config/ebalzan-ci.
  - Removing a key does not delete it on GitHub: pass --prune. It only deletes
    rulesets named "${MANAGED_RULESET_PREFIX}…".

Options:
  -C, --repo-dir DIR      Checkout of the repo to sync (default: .)
  -R, --repo OWNER/REPO   Its slug (default: from the checkout's origin remote)
      --skip LIST         Sections to leave alone, comma-separated:
                          ${SECTIONS.join(', ')}
      --prune             Also delete what no file defines (asks first)
  -n, --dry-run           Show the plan; change nothing
  -y, --yes               Skip the confirmations
  -h, --help              Show this help

Requires gh, authenticated with admin on the repo (a dry run works without).`

// ---- target ------------------------------------------------------------------
// The checkout to read (-C, else .) and the GitHub repo to write (-R, else the
// checkout's origin remote).
function resolveTarget(opts) {
  const dir = resolve(opts['repo-dir'] ?? '.')
  if (!github.isCheckout(dir)) {
    throw new Error(
      `${dir} is not a git checkout.${opts['repo-dir'] ? '' : ' Run sync in the repo, or pass -C DIR.'}`,
    )
  }
  const repo = opts.repo || github.detectRepo(dir)
  if (!repo) throw new Error(`Could not determine the repo for ${dir}. Pass --repo OWNER/REPO.`)
  return { repo, dir }
}

// ---- plan --------------------------------------------------------------------
function listEntries(title, entries) {
  if (entries.length === 0) return
  info(`  ${bold(title)}`)
  for (const { name, layer } of entries) info(`    ${name.padEnd(34)} ${dim(layer)}`)
}

function printPlan(ctx, repo, dir, want) {
  const { variables, secrets, settings, rulesets } = want
  info()
  info(`${bold('Sync')}   ${dim(`${repo}  ←  ${dir}`)}`)
  info(
    dim(
      `shared config: ${SHARED_DIR} · shared secrets: ${ctx.secretsDir}${ctx.skip.length ? ` · skipping: ${ctx.skip}` : ''}`,
    ),
  )
  info()
  if (ctx.on('vars')) {
    listEntries(
      'repository variables',
      variables.filter(entry => entry.layer !== 'shared'),
    )
    const runtime = variables.filter(entry => entry.layer === 'shared').map(entry => entry.name)
    if (runtime.length)
      info(`  ${dim(`shared variables, read at run time (not pushed): ${runtime.join(' ')}`)}`)
  }
  if (ctx.on('secrets')) {
    listEntries('repository secrets', secrets.repository)
    for (const [env, entries] of Object.entries(secrets.environments)) {
      listEntries(`environment '${env}' secrets`, entries)
    }
  }
  if (ctx.on('settings') && settings) {
    info(`  ${bold('repository settings')}`)
    const show = value => (typeof value === 'object' ? JSON.stringify(value) : value)
    info(
      `    ${Object.entries(settings)
        .map(([key, value]) => `${key}=${show(value)}`)
        .join(' ')}`,
    )
  }
  if (ctx.on('rulesets') && rulesets.length) {
    info(`  ${bold('rulesets')}`)
    for (const { file, body } of rulesets)
      info(`    ${body.name.padEnd(34)} ${dim(`${body.enforcement} · ${file}`)}`)
  }
  info()
}

// ---- apply -------------------------------------------------------------------
// prune — delete the KIND entries on GitHub that KEEP does not name.
async function prune(ctx, kind, repo, keep, env) {
  let existing
  try {
    existing = github.listNames(kind, repo, env)
  } catch {
    return // e.g. the environment does not exist yet
  }
  const stale = existing.filter(name => !keep.includes(name))
  if (stale.length === 0) return
  step(`Stale ${kind}s on ${env ? `environment '${env}' of ` : ''}${repo} (no file defines them):`)
  for (const name of stale) info(`    - ${name}`)
  if (ctx.dryRun) return
  if (!ctx.yes && !(await confirm('Delete these?'))) return warn('Kept.')
  for (const name of stale) {
    github.deleteEntry(kind, repo, name, env)
    ok(`deleted ${kind} ${name}`)
  }
}

async function syncVariables(ctx, repo, variables) {
  const own = variables.filter(entry => entry.layer !== 'shared')
  if (!ctx.dryRun && own.length) {
    step(`Setting ${own.length} repo variable(s)`)
    for (const { name, value } of own) github.setVariable(repo, name, value)
    ok('done')
  }
  if (ctx.prune)
    await prune(
      ctx,
      'variable',
      repo,
      own.map(entry => entry.name),
    )
}

async function syncSecrets(ctx, repo, secrets) {
  const scopes = [[undefined, secrets.repository], ...Object.entries(secrets.environments)]
  for (const [env, entries] of scopes) {
    const names = entries.map(entry => entry.name)
    if (!ctx.dryRun) {
      // A job only sees an environment's secrets when it declares `environment: <name>`.
      if (env) github.createEnvironment(repo, env)
      for (const entry of entries) github.setSecret(repo, entry.name, secretValue(entry), env)
      if (names.length)
        ok(
          `${env ? `environment '${env}' ` : ''}secrets synced (values not shown): ${names.join(' ')}`,
        )
    }
    if (ctx.prune) await prune(ctx, 'secret', repo, names, env)
  }
}

function syncSettings(ctx, repo, settings) {
  const changes = diffTopLevel(settings, github.getRepo(repo))
  if (changes.length === 0) return ok('repository settings already match')
  step('Repository settings to change')
  for (const [key, now, want] of changes) info(`    ${key.padEnd(30)} ${now} → ${want}`)
  if (ctx.dryRun) return
  github.patchRepo(repo, settings)
  ok('repository settings updated')
}

async function syncRulesets(ctx, repo, rulesets) {
  const unavailable = () =>
    warn(
      `Rulesets are not available for ${repo} (a private repo needs GitHub Pro or Team) — skipped.`,
    )
  step('Rulesets')
  let existing
  try {
    existing = github.listRulesets(repo)
  } catch (error) {
    if (github.rulesetsUnavailable(error)) return unavailable()
    throw new Error(`Could not list rulesets on ${repo}: ${error.message}`, { cause: error })
  }

  for (const { file, body } of rulesets) {
    const match = existing.find(ruleset => ruleset.name === body.name)
    const action = match ? 'update' : 'create'
    if (ctx.dryRun) {
      info(`    ${action} ${`'${body.name}'`.padEnd(28)} ${dim(`${body.enforcement} · ${file}`)}`)
      continue
    }
    try {
      if (match) github.updateRuleset(repo, match.id, body)
      else github.createRuleset(repo, body)
    } catch (error) {
      if (github.rulesetsUnavailable(error)) return unavailable()
      throw new Error(`Could not ${action} ruleset '${body.name}': ${error.message}`, {
        cause: error,
      })
    }
    ok(`ruleset '${body.name}' ${action}d (${body.enforcement})`)
  }

  if (!ctx.prune) return
  const stale = existing.filter(
    ruleset =>
      ruleset.name.startsWith(MANAGED_RULESET_PREFIX) &&
      !rulesets.some(({ body }) => body.name === ruleset.name),
  )
  if (stale.length === 0) return
  step(`Stale rulesets on ${repo} (named '${MANAGED_RULESET_PREFIX}…', no file defines them):`)
  for (const { name } of stale) info(`    - ${name}`)
  if (ctx.dryRun) return
  if (!ctx.yes && !(await confirm('Delete these?'))) return warn('Kept.')
  for (const { id, name } of stale) {
    github.deleteRuleset(repo, id)
    ok(`deleted ruleset '${name}'`)
  }
}

async function syncRepo(ctx, repo, dir) {
  const want = desiredState({ sharedDir: SHARED_DIR, secretsDir: ctx.secretsDir, repoDir: dir })
  printPlan(ctx, repo, dir, want)

  if (ctx.dryRun) {
    // Comparing with GitHub needs credentials; without them the plan is all there is.
    if (!github.isAuthenticated()) return ok('Dry run complete — nothing was changed.')
  } else {
    github.requireAuth()
    if (ctx.on('vars')) {
      for (const { key, value, file, layer } of want.variables) {
        if (layer !== 'shared' && !value) throw new Error(`${key} has an empty value in ${file}.`)
      }
    }
    if (ctx.on('secrets')) {
      for (const entry of [
        want.secrets.repository,
        ...Object.values(want.secrets.environments),
      ].flat()) {
        secretValue(entry)
      }
    }
    if (!ctx.yes && !(await confirm(`Push this config → ${repo}?`))) throw new Error('Aborted.')
  }

  if (ctx.on('vars')) await syncVariables(ctx, repo, want.variables)
  if (ctx.on('secrets')) await syncSecrets(ctx, repo, want.secrets)
  if (ctx.on('settings') && want.settings) syncSettings(ctx, repo, want.settings)
  if (ctx.on('rulesets') && want.rulesets.length) await syncRulesets(ctx, repo, want.rulesets)

  info()
  ok(ctx.dryRun ? 'Dry run complete — nothing was changed.' : bold(`Sync complete for ${repo}.`))
}

export async function sync(argv) {
  let opts
  try {
    opts = parseArgs({
      args: argv,
      options: {
        'repo-dir': { type: 'string', short: 'C' },
        repo: { type: 'string', short: 'R' },
        skip: { type: 'string', default: '' },
        prune: { type: 'boolean' },
        'dry-run': { type: 'boolean', short: 'n' },
        yes: { type: 'boolean', short: 'y' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values
  } catch (error) {
    fail(`${error.message} (try --help)`)
    return 1
  }
  if (opts.help) {
    console.log(HELP)
    return 0
  }

  try {
    const skip = opts.skip.split(',').filter(Boolean)
    for (const section of skip) {
      if (!SECTIONS.includes(section))
        throw new Error(`--skip: unknown section '${section}' (${SECTIONS.join(', ')}).`)
    }
    const ctx = {
      secretsDir: sharedSecretsDir(CI_ROOT),
      skip,
      on: section => !skip.includes(section),
      prune: Boolean(opts.prune),
      dryRun: Boolean(opts['dry-run']),
      yes: Boolean(opts.yes),
    }
    const { repo, dir } = resolveTarget(opts)
    await syncRepo(ctx, repo, dir)
    return 0
  } catch (error) {
    fail(error.message)
    return 1
  }
}

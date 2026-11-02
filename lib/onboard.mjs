// onboard.mjs — `ebalzan-ci onboard`: bring a repo under the shared rules in
// one step. The templates/ files, the .gitignore entries and the npm wiring go
// into one local commit; then (unless --no-push) dev is created on GitHub when
// missing, `sync` runs, and the branch is pushed. Every step prints what it
// does; --dry-run stops after the plan.

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import * as github from './github.mjs'
import { bold, confirm, dim, fail, info, ok, step, warn } from './log.mjs'
import { sync } from './sync.mjs'

const CI_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TEMPLATES_DIR = join(CI_ROOT, 'templates')
const CI_PKG = JSON.parse(readFileSync(join(CI_ROOT, 'package.json'), 'utf8'))
// The slug every caller's `uses:` names: package.json "repository" (change it there if you fork).
const CI_REPO = (CI_PKG.repository?.url ?? '').replace(/^.*github\.com[/:]|\.git$/g, '')
const CI_PACKAGE = CI_PKG.name
const CI_MAJOR = CI_PKG.version.split('.')[0]
const CONFIG_PACKAGE = '@ebalzan/config'
const DEFAULT_BRANCH = 'ci/onboard-ebalzan-ci'

// Templates the repo owns once written: never overwritten, even with --force.
const NEVER_OVERWRITE = ['.github/workflows/deploy.yml']

const PRETTIER_FILES = [
  ...['', '.json', '.json5', '.yaml', '.yml', '.toml', '.js', '.cjs', '.mjs', '.ts'].map(
    ext => `.prettierrc${ext}`,
  ),
  ...['js', 'cjs', 'mjs', 'ts'].map(ext => `prettier.config.${ext}`),
]
const ESLINT_FILES = [
  ...['js', 'cjs', 'mjs', 'ts', 'mts', 'cts'].map(ext => `eslint.config.${ext}`),
  ...['', '.js', '.cjs', '.json', '.yaml', '.yml'].map(ext => `.eslintrc${ext}`),
]
const RENOVATE_FILES = [
  'renovate.json',
  'renovate.json5',
  '.renovaterc',
  '.renovaterc.json',
  '.github/renovate.json',
  '.github/renovate.json5',
]

// The lines added to the repo's .gitignore (step 3 of the help). Data, not a
// template file: it is appended, never rendered at its own path. This repo's
// own .gitignore ends with the same lines (test/onboard.test.mjs checks it).
export const GITIGNORE_SNIPPET = 'secrets.gitignore'

export const HELP = `Usage: ebalzan-ci onboard [options]

Bring a repo under the shared rules in one step. In the repo's checkout it:
  1. creates a branch (${DEFAULT_BRANCH}) from dev — or from the default
     branch when dev does not exist yet;
  2. writes the templates/ files: the workflows, a starter
     .github/actions.env, renovate.json and, for a Node repo, the husky
     commit-msg hook. A file that already exists is kept (--force replaces
     it), except .github/workflows/deploy.yml, which is the repo's own and is
     never replaced;
  3. adds the .github/secrets*.env files to .gitignore when they are not
     ignored yet (before any secret file exists);
  4. for a Node repo (package.json): installs this package and husky as
     devDependencies, sets \`prepare: husky\` when no prepare script exists,
     and wires the code-style rules of ${CONFIG_PACKAGE} — package.json
     "prettier" and an eslint.config.mjs — where the repo has no Prettier or
     ESLint config of its own (--no-config skips this);
  5. commits it all as \`ci: onboard <ci repo>\`.
Then, unless --no-push:
  6. creates the dev branch on GitHub if it is missing;
  7. runs \`ebalzan-ci sync\` (variables, secrets, settings, rulesets);
  8. pushes the branch. The auto-pr.yml it adds runs on that very push and
     opens the PR into dev. Review and squash-merge it.

Options:
  -C, --repo-dir DIR     Checkout of the repo to onboard (default: .)
  -R, --repo OWNER/REPO  Its slug (default: from DIR's git remote)
      --runs-on LABEL    Runner label for every job (default: ubuntu-latest)
      --ref REF          Ref the callers pin (default: v${CI_MAJOR}, this package's major)
      --branch NAME      Branch to commit on (default: ${DEFAULT_BRANCH})
      --force [FILE]     Overwrite FILE (a template path, e.g.
                         .github/workflows/pr-checks.yml) when it exists;
                         repeat for more. Without FILE: every template file.
                         .github/workflows/deploy.yml is never overwritten.
      --no-npm           Skip the npm installs even when package.json exists
      --no-config        Do not wire ${CONFIG_PACKAGE} (Prettier, ESLint)
      --no-push          Stop after the local commit (no GitHub changes at all)
  -n, --dry-run          Show what would happen; change nothing
  -y, --yes              Skip the confirmations (also for the sync)
  -h, --help             Show this help

Requires git; gh authenticated with admin on the repo (not needed with
--no-push or --dry-run); npm for a Node repo. The CI repo itself is refused:
its callers would point it at a released copy of itself.`

// ---- args --------------------------------------------------------------------
// By hand rather than util.parseArgs: --force takes an optional value.
function parseOnboardArgs(argv) {
  const opts = {
    repoDir: '.',
    repo: '',
    runsOn: 'ubuntu-latest',
    ref: `v${CI_MAJOR}`,
    branch: DEFAULT_BRANCH,
    forceAll: false,
    forceFiles: [],
    npm: true,
    config: true,
    push: true,
    dryRun: false,
    yes: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => argv[++i] ?? ''
    switch (arg) {
      case '-C':
      case '--repo-dir':
        opts.repoDir = value()
        break
      case '-R':
      case '--repo':
        opts.repo = value()
        break
      case '--runs-on':
        opts.runsOn = value()
        break
      case '--ref':
        opts.ref = value()
        break
      case '--branch':
        opts.branch = value()
        break
      case '--force':
        // A following non-option argument is the file to force; else force all.
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
          opts.forceFiles.push(value().replace(/^\.\//, ''))
        } else {
          opts.forceAll = true
        }
        break
      case '--no-npm':
        opts.npm = false
        break
      case '--no-config':
        opts.config = false
        break
      case '--no-push':
        opts.push = false
        break
      case '-n':
      case '--dry-run':
        opts.dryRun = true
        break
      case '-y':
      case '--yes':
        opts.yes = true
        break
      case '-h':
      case '--help':
        return { ...opts, help: true }
      default:
        throw new Error(`Unknown option: ${arg} (try --help)`)
    }
  }
  return opts
}

// ---- helpers -----------------------------------------------------------------
// git -C DIR …: stdout, or a throw with git's own message.
function gitIn(dir) {
  const run = args => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  const git = (...args) => {
    const result = run(args)
    if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`)
    return result.stdout
  }
  git.ok = (...args) => run(args).status === 0
  return git
}

// npm in DIR, its output shown; true when it succeeded.
const npmIn = dir => args =>
  spawnSync('npm', args, { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' })
    .status === 0

function readPackage(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

const hasDependency = (pkg, name) =>
  Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name])

// Every template file under templates/ (all but GITIGNORE_SNIPPET), as a
// sorted list of relative paths.
function templateFiles() {
  return readdirSync(TEMPLATES_DIR, { recursive: true })
    .map(String)
    .filter(rel => rel !== GITIGNORE_SNIPPET && statSync(join(TEMPLATES_DIR, rel)).isFile())
    .map(rel => rel.split('\\').join('/'))
    .sort()
}

function render(rel, dir, opts) {
  const src = join(TEMPLATES_DIR, rel)
  const dest = join(dir, rel)
  const text = readFileSync(src, 'utf8')
    .replaceAll('__CI_REPO__', CI_REPO)
    .replaceAll('__CI_REF__', opts.ref)
    .replaceAll('__CI_PACKAGE__', CI_PACKAGE)
    .replaceAll('__RUNS_ON__', opts.runsOn)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, text)
  if (statSync(src).mode & 0o111 || rel.startsWith('.husky/')) {
    chmodSync(dest, statSync(dest).mode | 0o111)
  }
}

const samePath = (a, b) => {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

// ---- onboard -----------------------------------------------------------------
async function run(opts) {
  if (!CI_REPO.includes('/')) {
    throw new Error(`Could not read the CI repo from package.json "repository" (got '${CI_REPO}').`)
  }
  if (!opts.runsOn || !opts.ref || !opts.branch) {
    throw new Error('--runs-on, --ref and --branch need a value.')
  }

  // ---- preconditions ---------------------------------------------------------
  if (!github.isCheckout(opts.repoDir)) throw new Error(`${opts.repoDir} is not a git checkout.`)
  const dir = resolve(opts.repoDir)
  const git = gitIn(dir)
  const npm = npmIn(dir)

  if (opts.push && !opts.dryRun) github.requireAuth()
  const repo = opts.repo || github.detectRepo(dir)
  if (opts.push && !repo) {
    throw new Error(
      `Could not determine the repo for ${dir}. Pass --repo OWNER/REPO (or --no-push).`,
    )
  }
  // The CI repo is not onboarded: the callers would point it at a released copy
  // of itself. Caught by its checkout, its slug or its package name.
  const isNode = existsSync(join(dir, 'package.json'))
  if (
    samePath(dir, CI_ROOT) ||
    repo.toLowerCase() === CI_REPO.toLowerCase() ||
    (isNode && readPackage(dir).name === CI_PACKAGE)
  ) {
    throw new Error(`${dir} is ${CI_REPO} itself, which is not onboarded.`)
  }
  if (!opts.dryRun && git('status', '--porcelain')) {
    throw new Error(`${dir} has uncommitted changes. Commit or stash them first.`)
  }
  if (git.ok('rev-parse', '--verify', '--quiet', `refs/heads/${opts.branch}`)) {
    throw new Error(`Branch ${opts.branch} already exists in ${dir}. Delete it or pass --branch.`)
  }

  // Branch point: dev if it exists, else the default branch, else HEAD (no remote).
  const hasOrigin = git.ok('remote', 'get-url', 'origin')
  if (hasOrigin && !opts.dryRun && !git.ok('fetch', '--quiet', 'origin')) {
    warn('git fetch origin failed; using local refs.')
  }
  const devExists =
    hasOrigin && git.ok('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/dev')
  let baseRef = 'HEAD'
  if (devExists) baseRef = 'origin/dev'
  else if (hasOrigin && git.ok('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD')) {
    baseRef = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').trim()
  }

  const useConfig = isNode && opts.config
  const present = files => files.filter(file => existsSync(join(dir, file))).join(' ')

  // ---- plan ------------------------------------------------------------------
  const neverOverwrite = rel => NEVER_OVERWRITE.includes(rel)
  const forced = rel => !neverOverwrite(rel) && (opts.forceAll || opts.forceFiles.includes(rel))

  const templates = templateFiles()
  for (const rel of opts.forceFiles) {
    if (neverOverwrite(rel)) {
      throw new Error(
        `--force ${rel}: it is the repo's own file and is never overwritten. Delete it to get the template again.`,
      )
    }
    if (!templates.includes(rel)) {
      throw new Error(`--force ${rel}: not a template file. One of: ${templates.join(' ')}`)
    }
  }

  // Why template REL does not belong in this repo at all, or '' when it does.
  const skipReason = rel => {
    if (rel.startsWith('.husky/') && !isNode) return 'no package.json'
    if (rel === 'eslint.config.mjs') {
      if (!useConfig) return isNode ? '--no-config' : 'no package.json'
      // A repo with its own ESLint config extends the preset there; never add a second one.
      const own = present(ESLINT_FILES)
      if (own && own !== 'eslint.config.mjs') {
        return `repo has ${own} — extend ${CONFIG_PACKAGE}/eslint/node there`
      }
    }
    // Any existing Renovate config is the repo's own; extend the preset there.
    if (rel === 'renovate.json' && present(RENOVATE_FILES) && !forced(rel)) {
      return 'repo has its own Renovate config'
    }
    return ''
  }

  const plan = templates.map(rel => {
    const reason = skipReason(rel)
    if (reason) return { action: 'skip', rel, reason }
    if (!existsSync(join(dir, rel))) return { action: 'create', rel }
    if (forced(rel)) return { action: 'overwrite', rel }
    if (neverOverwrite(rel))
      return { action: 'keep', rel, reason: "the repo's own — never overwritten" }
    return { action: 'keep', rel, reason: `exists — --force ${rel} replaces it` }
  })

  // Secrets files must be ignored before the first one exists.
  const gitignore =
    !git.ok('check-ignore', '-q', '.github/secrets.env') ||
    !git.ok('check-ignore', '-q', '.github/secrets.production.env')

  // Prettier: point package.json at the shared config unless the repo has its own.
  let prettierSet = false
  let prettierOwn = ''
  if (useConfig) {
    prettierOwn = present(PRETTIER_FILES)
    if (!prettierOwn && readPackage(dir).prettier === undefined) prettierSet = true
    else if (!prettierOwn) prettierOwn = 'package.json "prettier"'
  }
  // TypeScript is reported, never edited: tsconfig files are JSON with comments.
  const tsconfig = join(dir, 'tsconfig.json')
  const tsconfigNote =
    useConfig &&
    existsSync(tsconfig) &&
    !readFileSync(tsconfig, 'utf8').includes(`${CONFIG_PACKAGE}/tsconfig/`)
      ? `tsconfig.json does not extend ${CONFIG_PACKAGE}/tsconfig/*.json — add "extends" by hand`
      : ''

  const ciRange = `${CI_PACKAGE}@^${CI_MAJOR}.0.0`
  info()
  info(
    `${bold('Onboard')}   ${dim(`${repo || basename(dir)}  ←  ${CI_REPO}@${opts.ref} (runs-on: ${opts.runsOn})`)}`,
  )
  info()
  info(`  ${bold('files')} ${dim(`(branch ${opts.branch} from ${baseRef})`)}`)
  for (const { action, rel, reason } of plan) {
    const line = `${action.padEnd(10)} ${rel}${reason ? ` (${reason})` : ''}`
    info(`    ${action === 'keep' || action === 'skip' ? dim(line) : line}`)
  }
  if (gitignore) info(`    ${'update'.padEnd(10)} .gitignore (ignore .github/secrets*.env)`)
  if (prettierSet) {
    info(`    ${'update'.padEnd(10)} package.json "prettier": "${CONFIG_PACKAGE}/prettier"`)
  }
  if (prettierOwn) {
    info(
      `    ${dim(`keep       ${prettierOwn} (own Prettier config — extend ${CONFIG_PACKAGE}/prettier there)`)}`,
    )
  }
  if (tsconfigNote) info(`    ${dim(`note       ${tsconfigNote}`)}`)
  if (isNode && opts.npm) {
    info(`  ${bold('npm')}`)
    info(`    install --save-dev ${ciRange} (and husky, if missing)`)
    if (useConfig) {
      info(
        `    install --save-dev --save-exact ${CONFIG_PACKAGE} (and eslint, prettier, if missing)`,
      )
    }
  }
  if (opts.push) {
    info(`  ${bold('GitHub')} ${dim(`(${repo})`)}`)
    if (!devExists) info(`    create branch dev from ${baseRef}`)
    info('    sync: variables, secrets, settings, rulesets')
    info(`    push ${opts.branch} → auto-pr.yml opens the PR into dev`)
  } else {
    info(`  ${dim('--no-push: GitHub is left untouched')}`)
  }
  info()

  if (opts.dryRun) {
    ok('Dry run complete — nothing was changed.')
    return 0
  }

  // ---- local changes ---------------------------------------------------------
  git('switch', '--quiet', '--no-track', '-c', opts.branch, baseRef)

  for (const { action, rel } of plan) {
    if (action === 'create' || action === 'overwrite') {
      render(rel, dir, opts)
      ok(`${action} ${rel}`)
    }
  }

  if (gitignore) {
    const file = join(dir, '.gitignore')
    let text = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (text && !text.endsWith('\n')) text += '\n'
    writeFileSync(file, `${text}\n${readFileSync(join(TEMPLATES_DIR, GITIGNORE_SNIPPET), 'utf8')}`)
    ok('update .gitignore')
  }

  if (prettierSet && npm(['pkg', 'set', `prettier=${CONFIG_PACKAGE}/prettier`])) {
    ok('set package.json "prettier"')
  }

  if (isNode && opts.npm) {
    step('Installing devDependencies')
    if (!npm(['install', '--save-dev', '--no-audit', '--no-fund', ciRange])) {
      warn(
        `Could not install ${CI_PACKAGE} (is it published?). The hook skips the local check until it is installed.`,
      )
    }
    if (!hasDependency(readPackage(dir), 'husky')) {
      if (!npm(['install', '--save-dev', '--no-audit', '--no-fund', 'husky'])) {
        warn('Could not install husky.')
      }
    }
    if (
      readPackage(dir).scripts?.prepare === undefined &&
      npm(['pkg', 'set', 'scripts.prepare=husky'])
    ) {
      ok('set scripts.prepare = husky')
    }
    if (useConfig) {
      // Its peers are pinned by the repo, so add the ones it does not list yet.
      const pkg = readPackage(dir)
      const packages = [
        CONFIG_PACKAGE,
        ...['eslint', 'prettier'].filter(peer => !hasDependency(pkg, peer)),
      ]
      if (!npm(['install', '--save-dev', '--save-exact', '--no-audit', '--no-fund', ...packages])) {
        warn(
          `Could not install ${packages.join(' ')}. Install them before running Prettier or ESLint.`,
        )
      }
    }
  }

  git('add', '-A')
  if (git.ok('diff', '--cached', '--quiet')) {
    warn('Nothing to commit — every file already exists. Use --force FILE to replace one.')
    git('switch', '--quiet', '-')
    git('branch', '--quiet', '-D', opts.branch)
    return 0
  }
  git('commit', '--quiet', '-m', `ci: onboard ${CI_REPO} shared workflows and rules`)
  ok(`Committed on ${opts.branch}: ${git('log', '-1', '--pretty=%s').trim()}`)

  if (!opts.push) {
    info()
    ok(`${bold('Local onboarding done.')} Review with: git -C ${dir} show --stat`)
    info('Then push it yourself, or re-run without --no-push after deleting the branch.')
    return 0
  }

  // ---- GitHub ----------------------------------------------------------------
  if (
    !opts.yes &&
    !(await confirm(`Apply the GitHub steps above to ${repo} and push ${opts.branch}?`))
  ) {
    throw new Error(`Stopped. The local commit on ${opts.branch} is kept.`)
  }

  if (!devExists) {
    const { from, sha } = github.createBranchFromDefault(repo, 'dev')
    ok(`created branch dev from ${from} (${sha.slice(0, 7)})`)
  }

  const syncArgs = ['--repo-dir', dir, '--repo', repo, ...(opts.yes ? ['--yes'] : [])]
  if ((await sync(syncArgs)) !== 0) {
    warn(`Sync did not finish; fix the cause and re-run: ebalzan-ci sync -C ${dir}`)
  }

  git('push', '--quiet', '-u', 'origin', opts.branch)
  ok(`pushed ${opts.branch}`)

  info()
  ok(`${bold(`${repo} is onboarded.`)}`)
  info('  1. The PR into dev opens within a minute (auto-pr.yml). If it does not:')
  info(`     https://github.com/${repo}/compare/dev...${opts.branch}`)
  info("  2. Add the repo's own checks to .github/workflows/pr-checks.yml (it has a")
  info('     commented example).')
  if (tsconfigNote) info(`  ·  ${tsconfigNote}`)
  info('  3. Squash-merge the PR: the dev → main release PR opens.')
  info('  4. Once its check passes, add the `ship` label to release: main fast-forwards')
  info('     to dev. Never merge the release PR with a button.')
  return 0
}

export async function onboard(argv) {
  try {
    const opts = parseOnboardArgs(argv)
    if (opts.help) {
      console.log(HELP)
      return 0
    }
    return await run(opts)
  } catch (error) {
    fail(error.message)
    return 1
  }
}

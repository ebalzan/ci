// Dry runs only, with gh unauthenticated (see helpers.isolatedEnv): these test
// how the layers merge and what the plan shows, never a real GitHub call.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { mergeEnv, secretValue } from '../lib/config.mjs'
import { gitRepo, isolatedEnv, runCli, tempDir, writeFile } from './helpers.mjs'

function dryRun(t, repoFiles, extraArgs = [], envOverrides = {}) {
  const env = { ...isolatedEnv(t), ...envOverrides }
  const { dir } = gitRepo(t, env, repoFiles)
  return runCli(['sync', '-C', dir, '-R', 'someone/example', '--dry-run', ...extraArgs], { env })
}

test('dry run: repo variables, shared runtime variables, settings, rulesets', t => {
  const result = dryRun(t, {
    '.github/actions.env': 'AUTO_PROJECT_NUMBER=7\nAUTO_DESCRIBE_EFFORT=high\n',
  })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const out = result.stdout
  assert.match(out, /AUTO_PROJECT_NUMBER +repo\n/)
  assert.match(out, /AUTO_DESCRIBE_EFFORT +repo \(overrides shared\)/)
  assert.match(out, /read at run time \(not pushed\): .*AUTO_DESCRIBE_MODEL/)
  assert.match(out, /repository settings\n.*squash_merge_commit_title=PR_TITLE/)
  assert.match(out, /ci: protect main +active · protect-main\.json/)
  assert.match(out, /ci: require pull request +disabled · require-pull-request\.json/)
  assert.match(out, /ci: require release pull request +disabled · require-release-pr\.json/)
  assert.match(out, /Dry run complete/)
})

test('dry run: a repo variable equal to the shared one is flagged redundant', t => {
  const result = dryRun(t, { '.github/actions.env': 'AUTO_DESCRIBE_MODEL=claude-sonnet-5-5\n' })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /AUTO_DESCRIBE_MODEL +repo \(same as shared: redundant\)/)
})

test('a repo file deep-merges over a shared ruleset and settings', t => {
  const result = dryRun(t, {
    '.github/rulesets/require-pull-request.json': '{ "enforcement": "active" }\n',
    '.github/rulesets/extra.json':
      '{ "name": "ci: tags", "target": "tag", "enforcement": "active", "conditions": {"ref_name": {"include": ["refs/tags/v*"], "exclude": []}}, "rules": [{"type": "deletion"}] }\n',
    '.github/repo-settings.json': '{ "delete_branch_on_merge": false }\n',
  })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /ci: require pull request +active/)
  assert.match(result.stdout, /ci: tags +active · extra\.json/)
  assert.match(result.stdout, /delete_branch_on_merge=false/)
})

test('a ruleset without a name is an error', t => {
  const result = dryRun(t, { '.github/rulesets/bad.json': '{ "enforcement": "active" }\n' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Ruleset bad\.json has no "name"/)
})

test("shared secrets come from CI_SECRETS_DIR; the repo's .github/ overrides them", t => {
  const secretsDir = tempDir(t)
  writeFile(secretsDir, 'secrets.env', 'ANTHROPIC_API_KEY=real-value\nGH_PROJECT_TOKEN=token\n')
  writeFile(secretsDir, 'secrets.staging.env', 'DB_URL=postgres://x\n')
  const result = dryRun(
    t,
    {
      '.github/secrets.env': 'GH_PROJECT_TOKEN=repo-token\n',
      '.github/secrets.production.env': 'DEPLOY_KEY_FILE=deploy.pem\n',
    },
    [],
    { CI_SECRETS_DIR: secretsDir },
  )
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /ANTHROPIC_API_KEY +shared/)
  assert.match(result.stdout, /GH_PROJECT_TOKEN +repo \(overrides shared\)/)
  assert.match(result.stdout, /environment 'production' secrets\n +DEPLOY_KEY +repo/)
  assert.match(result.stdout, /environment 'staging' secrets\n +DB_URL +shared/)
})

test('--skip leaves sections out of the plan, and rejects unknown ones', t => {
  const skipped = dryRun(t, {}, ['--skip', 'settings,rulesets'])
  assert.equal(skipped.status, 0, skipped.stderr + skipped.stdout)
  assert.doesNotMatch(skipped.stdout, /repository settings\n|ci: protect/)
  assert.match(skipped.stdout, /skipping: settings,rulesets/)

  const bad = dryRun(t, {}, ['--skip', 'everything'])
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /unknown section 'everything'/)
})

test('not a checkout is an error, with -C or in the current directory', t => {
  const env = isolatedEnv(t)
  const dir = tempDir(t)
  assert.equal(runCli(['sync', '-C', join(dir), '--dry-run'], { env }).status, 1)

  const result = runCli(['sync', '-R', 'someone/example', '--dry-run'], { env, cwd: dir })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /is not a git checkout\. Run sync in the repo/)
})

test('unknown options, --all among them, are errors', t => {
  const env = isolatedEnv(t)
  assert.match(runCli(['sync', '--nope'], { env }).stderr, /try --help/)
  assert.match(runCli(['sync', '--all'], { env }).stderr, /try --help/)
})

test('mergeEnv: FOO_FILE in the repo overrides a shared FOO (secrets)', t => {
  const dir = tempDir(t)
  writeFile(dir, 'shared.env', 'FOO=1\nBAR=2\n')
  writeFile(dir, 'repo.env', 'FOO_FILE=foo.txt\nBAR=2\n')
  assert.deepEqual(
    mergeEnv(join(dir, 'shared.env'), join(dir, 'repo.env'), { secrets: true }).map(e => [
      e.name,
      e.key,
      e.layer,
    ]),
    [
      ['FOO', 'FOO_FILE', 'repo (overrides shared)'],
      ['BAR', 'BAR', 'repo (same as shared: redundant)'],
    ],
  )
})

test('secretValue reads _FILE paths and refuses empty and placeholder values', t => {
  const dir = tempDir(t)
  const file = join(dir, 'secrets.env')
  writeFile(dir, 'key.pem', 'line 1\nline 2\n')
  assert.equal(secretValue({ key: 'KEY_FILE', value: 'key.pem', file }), 'line 1\nline 2\n')
  assert.throws(
    () => secretValue({ key: 'KEY_FILE', value: 'missing.pem', file }),
    /does not exist/,
  )
  assert.throws(() => secretValue({ key: 'TOKEN', value: '', file }), /empty value/)
  assert.throws(() => secretValue({ key: 'TOKEN', value: 'ghp_xxxxxxxx', file }), /placeholder/)
  assert.equal(secretValue({ key: 'TOKEN', value: 'real', file }), 'real')
})

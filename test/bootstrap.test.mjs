// Dry runs only, with gh unauthenticated (see helpers.isolatedEnv): these test
// how the layers merge and what the plan shows, never a real GitHub call.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

import { gitRepo, isolatedEnv, runCli, tempDir, writeFile } from './helpers.mjs'

const hasGh = spawnSync('gh', ['--version']).status === 0

function dryRun(t, repoFiles, extraArgs = [], envOverrides = {}) {
  const env = { ...isolatedEnv(t), ...envOverrides }
  const { dir } = gitRepo(t, env, repoFiles)
  return runCli(['bootstrap', '-C', dir, '-R', 'someone/example', '--dry-run', ...extraArgs], {
    env,
  })
}

test(
  'dry run: repo variables, shared runtime variables, settings, rulesets',
  { skip: !hasGh && 'gh not installed' },
  t => {
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
  },
)

test(
  'dry run: a repo variable equal to the shared one is flagged redundant',
  { skip: !hasGh && 'gh not installed' },
  t => {
    const result = dryRun(t, { '.github/actions.env': 'AUTO_DESCRIBE_MODEL=claude-sonnet-5-5\n' })
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.match(result.stdout, /AUTO_DESCRIBE_MODEL +repo \(same as shared: redundant\)/)
  },
)

test(
  'a repo file deep-merges over a shared ruleset and settings',
  { skip: !hasGh && 'gh not installed' },
  t => {
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
  },
)

test(
  'shared secrets come from CI_SECRETS_DIR; repo secrets override them',
  { skip: !hasGh && 'gh not installed' },
  t => {
    const secretsDir = tempDir(t)
    writeFile(secretsDir, 'secrets.env', 'ANTHROPIC_API_KEY=real-value\nGH_PROJECT_TOKEN=token\n')
    writeFile(secretsDir, 'secrets.staging.env', 'DB_URL=postgres://x\n')
    const result = dryRun(t, { '.github/secrets.env': 'GH_PROJECT_TOKEN=repo-token\n' }, [], {
      CI_SECRETS_DIR: secretsDir,
    })
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.match(result.stdout, /ANTHROPIC_API_KEY +shared/)
    assert.match(result.stdout, /GH_PROJECT_TOKEN +repo \(overrides shared\)/)
    assert.match(result.stdout, /environment 'staging' secrets\n +DB_URL +shared/)
  },
)

test(
  '--skip leaves sections out of the plan, and rejects unknown ones',
  { skip: !hasGh && 'gh not installed' },
  t => {
    const skipped = dryRun(t, {}, ['--skip', 'settings,rulesets'])
    assert.equal(skipped.status, 0, skipped.stderr + skipped.stdout)
    assert.doesNotMatch(skipped.stdout, /repository settings\n|ci: protect/)
    assert.match(skipped.stdout, /skipping: settings,rulesets/)

    const bad = dryRun(t, {}, ['--skip', 'everything'])
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /unknown section 'everything'/)
  },
)

test('not a checkout and no --repo is an error', t => {
  const env = isolatedEnv(t)
  const dir = tempDir(t)
  const result = runCli(['bootstrap', '-C', join(dir), '--dry-run'], { env })
  assert.equal(result.status, 1)
})

test(
  'repo secrets come from repos/<owner>/<repo>/ in the shared secrets dir when it exists',
  { skip: !hasGh && 'gh not installed' },
  t => {
    const secretsDir = tempDir(t)
    writeFile(secretsDir, 'secrets.env', 'ANTHROPIC_API_KEY=shared\n')
    // Matched case-insensitively against the slug.
    writeFile(
      secretsDir,
      'repos/Someone/Example/secrets.env',
      'ANTHROPIC_API_KEY=mine\nONLY_IN_VAULT=1\n',
    )
    writeFile(secretsDir, 'repos/Someone/Example/secrets.production.env', 'DEPLOY_KEY=k\n')
    const result = dryRun(t, { '.github/secrets.env': 'IGNORED_CHECKOUT_KEY=x\n' }, [], {
      CI_SECRETS_DIR: secretsDir,
    })
    assert.equal(result.status, 0, result.stderr + result.stdout)
    const out = result.stdout + result.stderr
    assert.match(out, /repo secrets: .*repos\/Someone\/Example/)
    assert.match(out, /secrets\*\.env files in .* are ignored/)
    assert.match(result.stdout, /ANTHROPIC_API_KEY +repo \(overrides shared\)/)
    assert.match(result.stdout, /ONLY_IN_VAULT +repo/)
    assert.match(result.stdout, /environment 'production' secrets\n +DEPLOY_KEY +repo/)
    assert.doesNotMatch(result.stdout, /IGNORED_CHECKOUT_KEY/)
  },
)

test(
  "without that folder, the checkout's .github/ holds the repo secrets",
  { skip: !hasGh && 'gh not installed' },
  t => {
    const result = dryRun(t, { '.github/secrets.env': 'CHECKOUT_KEY=x\n' })
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.match(result.stdout, /repo secrets: .*\/\.github/)
    assert.match(result.stdout, /CHECKOUT_KEY +repo/)
  },
)

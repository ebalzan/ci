// actions/setup wraps actions/checkout and actions/setup-node: every input of
// both is exposed under a prefix and passed through to its step. These tests
// keep the inputs and the steps' `with:` blocks in sync.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { ROOT, tempDir } from './helpers.mjs'

const action = readFileSync(join(ROOT, 'actions', 'setup', 'action.yml'), 'utf8')

const inputs = [
  ...action
    .split('\ninputs:\n')[1]
    .split('\noutputs:\n')[0]
    .matchAll(/^ {2}([a-z-]+):$/gm),
].map(([, name]) => name)

// The `with:` of the step with this id, as { key: value }.
function stepWith(id) {
  const block = action.split(`- id: ${id}\n`)[1].split(/\n\n|\n {4}- /)[0]
  return Object.fromEntries(
    [...block.split('with:\n')[1].matchAll(/^ {8}([a-z-]+): (.+)$/gm)].map(([, key, value]) => [
      key,
      value,
    ]),
  )
}

// node-version and node-version-file keep their names; every other input gets the prefix.
const inputName = (prefix, key) =>
  prefix === 'node-' && key.startsWith('node-') ? key : prefix + key

// The two inputs node-version.sh resolves first, and the outputs it passes on.
const RESOLVED = {
  'node-version': 'steps.node-version.outputs.version ',
  'node-version-file': 'steps.node-version.outputs.file ',
}

for (const [id, prefix] of [
  ['checkout', 'checkout-'],
  ['setup-node', 'node-'],
]) {
  test(`every input of ${id} is exposed as ${prefix}<input> and passed through`, () => {
    const withBlock = stepWith(id)
    assert.ok(Object.keys(withBlock).length > 5, `${id}: no with block found`)
    for (const [key, value] of Object.entries(withBlock)) {
      const name = inputName(prefix, key)
      assert.ok(inputs.includes(name), `${id}.${key} has no input ${name}`)
      const source = RESOLVED[name] ?? `inputs.${name} `
      assert.ok(value.includes(source), `${id}.${key} is not passed ${name}: ${value}`)
    }
    const passed = Object.keys(withBlock).map(key => inputName(prefix, key))
    for (const name of inputs.filter(n => n.startsWith(prefix))) {
      assert.ok(passed.includes(name), `input ${name} is not passed to ${id}`)
    }
  })
}

test('node-version.sh gets both inputs and the checkout path, and the 26 fallback', () => {
  const step = action.split('- id: node-version\n')[1].split('\n\n')[0]
  assert.match(step, /NODE_VERSION: \$\{\{ inputs\.node-version \}\}/)
  assert.match(step, /NODE_VERSION_FILE: \$\{\{ inputs\.node-version-file \}\}/)
  assert.match(step, /CHECKOUT_PATH: \$\{\{ inputs\.checkout-path \}\}/)
  assert.match(step, /DEFAULT_NODE_VERSION: '26'/)
})

test('the defaults that differ from upstream', () => {
  const input = name => action.split(`\n  ${name}:\n`)[1].split(/\n {2}\S/)[0]
  for (const name of [
    'checkout-persist-credentials',
    'checkout-show-progress',
    'node-package-manager-cache',
  ]) {
    assert.match(input(name), /default: 'false'/, name)
  }
  assert.match(input('node-version'), /default: ''/)
  assert.match(input('node-version-file'), /default: ''/)
})

// Runs node-version.sh in a workspace holding `files`; returns its outputs.
function resolveNode(t, env, files = []) {
  const workspace = tempDir(t)
  for (const file of files) {
    mkdirSync(join(workspace, file, '..'), { recursive: true })
    writeFileSync(join(workspace, file), '22\n')
  }
  const output = join(tempDir(t), 'output')
  writeFileSync(output, '')
  const result = spawnSync('bash', [join(ROOT, 'actions', 'setup', 'node-version.sh')], {
    env: {
      PATH: process.env.PATH,
      GITHUB_WORKSPACE: workspace,
      GITHUB_OUTPUT: output,
      DEFAULT_NODE_VERSION: '26',
      ...env,
    },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  return Object.fromEntries(
    readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .map(line => line.split(/=(.*)/s).slice(0, 2)),
  )
}

test('node-version.sh: node-version wins, even over a file and an .nvmrc', t => {
  assert.deepEqual(
    resolveNode(t, { NODE_VERSION: '24.x', NODE_VERSION_FILE: 'package.json' }, ['.nvmrc']),
    { version: '24.x', file: '' },
  )
})

test('node-version.sh: then node-version-file, as given', t => {
  assert.deepEqual(resolveNode(t, { NODE_VERSION_FILE: '.tool-versions' }, ['.nvmrc']), {
    version: '',
    file: '.tool-versions',
  })
})

test('node-version.sh: then .nvmrc, then .node-version, under the checkout path', t => {
  assert.deepEqual(resolveNode(t, {}, ['.nvmrc', '.node-version']), {
    version: '',
    file: '.nvmrc',
  })
  assert.deepEqual(resolveNode(t, {}, ['.node-version']), { version: '', file: '.node-version' })
  assert.deepEqual(resolveNode(t, { CHECKOUT_PATH: 'app/' }, ['.nvmrc', 'app/.node-version']), {
    version: '',
    file: 'app/.node-version',
  })
})

test('node-version.sh: else the default', t => {
  assert.deepEqual(resolveNode(t, {}), { version: '26', file: '' })
  assert.deepEqual(resolveNode(t, { CHECKOUT_PATH: 'app' }, ['.nvmrc']), {
    version: '26',
    file: '',
  })
})

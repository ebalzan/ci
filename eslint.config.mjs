// ESLint: the shared rules from @ebalzan/config, then this repo's own blocks.
// A later block wins for the files it matches, e.g. { ignores: ['generated/'] }
// or { files: [...], rules: {...} }. Run with `npm run lint`.
import node from '@ebalzan/config/eslint/node'

export default [
  ...node,
  {
    // Danger injects these into the dangerfile at run time.
    name: 'ci/dangerfile',
    files: ['actions/*/dangerfile.mjs'],
    languageOptions: { globals: { danger: 'readonly', fail: 'readonly', warn: 'readonly' } },
  },
]

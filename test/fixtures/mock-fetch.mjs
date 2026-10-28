// Preloaded with `node --import` by release.test.mjs: replaces fetch so the
// release script talks to a fake GitHub API. Every call is appended to
// $MOCK_FETCH_LOG as one JSON line.

import { appendFileSync } from 'node:fs'

globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname
  const method = options.method || 'GET'
  if (process.env.MOCK_FETCH_LOG) {
    appendFileSync(
      process.env.MOCK_FETCH_LOG,
      `${JSON.stringify({ method, path, body: options.body ?? null })}\n`,
    )
  }

  const reply = (status, body) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })

  if (/\/commits\/[^/]+\/pulls$/.test(path)) return reply(200, [])
  if (/\/releases\/tags\//.test(path)) return reply(404, { message: 'Not Found' })
  if (method === 'POST' && path.endsWith('/releases')) return reply(201, { id: 1 })
  return reply(404, { message: `mock-fetch: unexpected ${method} ${path}` })
}

/**
 * CSRF integration test for the mutating endpoints hardened alongside PR #545:
 *   POST /api/runs            — headless agent tool loop
 *   POST /api/routines        — persistent, scheduled variant
 *   POST /api/federation/optin  — join a federation org
 *   POST /api/federation/optout — leave / silently wipe an opt-in
 *
 * Boots the real server with the global origin guard DISABLED (NOETICA_ORIGIN_GUARD=0)
 * so this suite exercises the per-endpoint CSRF guard directly — the belt, not the
 * suspenders. NOETICA_API_TOKEN is set so requireApiToken becomes active and 401 can
 * be observed. Assertions per endpoint:
 *   - No Origin header (curl-style) + valid token → passes guards (not 401/403)
 *   - Origin: http://127.0.0.1:PORT + valid token → passes guards (not 401/403)
 *   - Origin: https://attacker.example (any token) → 403 cross_origin_blocked
 *   - No Origin + no token → 401 unauthorized
 *   - No Origin + invalid token → 401 unauthorized
 *
 * "Passes guards" means the response is NOT 401 / NOT 403 — the endpoint may still
 * return 400/500 based on payload, that's fine, we only care the CSRF wall let it in.
 *
 * Run: npm run test:integration:csrf   (from agent-machine/)
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

// Copilot round-1: a hard-coded port made this flaky on shared runners / dev machines
// where 8104 was already bound. Pick an ephemeral free port at runtime, pass it to
// the server via NOETICA_AM_PORT, and use the same PORT for the client URL below.
async function pickFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('could not read ephemeral port')))
      }
    })
  })
}

let PORT = 0
let BASE = ''
const TOKEN = 'itest-csrf-token'
let server: ChildProcess

async function req(
  path: string,
  opts: { method?: string; origin?: string; token?: string | null; body?: unknown; contentType?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {}
  if (opts.contentType !== undefined) headers['content-type'] = opts.contentType
  else if (opts.body !== undefined) headers['content-type'] = 'application/json'
  if (opts.origin) headers['origin'] = opts.origin
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`
  const r = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'POST',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    // 30s: federationOptIn/optOut touch hypercore + do disk I/O that's slow on cold
    // start; the CSRF guard itself is instant, but the passthrough response has to
    // wait for the real handler. The blocked cases (401/403) return well under 100ms.
    signal: AbortSignal.timeout(30_000),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

before(async () => {
  PORT = await pickFreePort()
  BASE = `http://127.0.0.1:${PORT}`
  server = spawn('node', ['--import', 'tsx', 'server.ts'], {
    // Copilot round-1: `new URL(...).pathname` produces an invalid path on Windows
    // (leading-slash encoding differs). `fileURLToPath` handles this correctly.
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    // NOETICA_ORIGIN_GUARD=0 disables the global guard so we isolate + test the per-endpoint
    // CSRF wall added alongside PR #545 (the belt, not the suspenders).
    // NOETICA_API_TOKEN=<TOKEN> turns on requireApiToken so we can observe 401.
    // Dead Ollama hosts keep the suite hermetic (no model dependency).
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NOETICA_AM_PORT: String(PORT),
      NOETICA_ORIGIN_GUARD: '0',
      NOETICA_API_TOKEN: TOKEN,
      OLLAMA_HOST: 'http://127.0.0.1:1',
      OLLAMA_FALLBACK_HOST: 'http://127.0.0.1:1',
    },
    stdio: 'ignore',
  })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      // Health probe: /api/status is GET + no auth. Requires no Origin header, no token.
      const r = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) return
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 500))
  }
  throw new Error('server did not start within 30s')
})

after(() => { server?.kill('SIGKILL') })

// Payloads chosen to be structurally VALID so guards are the only reason to reject.
// If guards pass, the endpoint may 200 (executeRun kicks off async, response is sent immediately)
// or 400 (federation optIn rejects an empty baseKey) — either is "past the CSRF wall".
const ENDPOINTS: Array<{ name: string; path: string; body?: unknown }> = [
  { name: 'runs',              path: '/api/runs',              body: { prompt: 'itest csrf', role: 'general' } },
  { name: 'routines',          path: '/api/routines',          body: { prompt: 'itest csrf', schedule: { every: '60s' } } },
  { name: 'federation/optin',  path: '/api/federation/optin',  body: { baseKey: 'a'.repeat(64) } },
  { name: 'federation/optout', path: '/api/federation/optout' /* no body */ },
]

for (const ep of ENDPOINTS) {
  test(`${ep.path}: cross-site Origin is blocked (403 cross_origin_blocked)`, async () => {
    const r = await req(ep.path, { origin: 'https://attacker.example', token: TOKEN, body: ep.body })
    assert.equal(r.status, 403, `expected 403 from attacker Origin, got ${r.status}`)
    assert.equal(r.body?.error, 'cross_origin_blocked')
  })

  test(`${ep.path}: no token is rejected (401 unauthorized)`, async () => {
    const r = await req(ep.path, { token: null, body: ep.body })
    assert.equal(r.status, 401, `expected 401 with no token, got ${r.status}`)
  })

  test(`${ep.path}: invalid token is rejected (401 unauthorized)`, async () => {
    const r = await req(ep.path, { token: 'wrong-token', body: ep.body })
    assert.equal(r.status, 401, `expected 401 with bad token, got ${r.status}`)
  })

  test(`${ep.path}: no Origin (curl-style) + valid token passes the CSRF wall`, async () => {
    const r = await req(ep.path, { token: TOKEN, body: ep.body })
    assert.notEqual(r.status, 401, `unexpected 401 for authenticated no-Origin caller: ${JSON.stringify(r.body)}`)
    assert.notEqual(r.status, 403, `unexpected 403 for no-Origin caller: ${JSON.stringify(r.body)}`)
  })

  test(`${ep.path}: loopback Origin + valid token passes the CSRF wall`, async () => {
    const r = await req(ep.path, { origin: `http://127.0.0.1:${PORT}`, token: TOKEN, body: ep.body })
    assert.notEqual(r.status, 401, `unexpected 401 for loopback Origin: ${JSON.stringify(r.body)}`)
    assert.notEqual(r.status, 403, `unexpected 403 for loopback Origin: ${JSON.stringify(r.body)}`)
  })
}

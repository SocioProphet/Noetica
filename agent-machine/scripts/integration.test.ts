/**
 * Black-box HTTP integration test for the agent-machine.
 *
 * Boots the real server in a child process (NODE_ENV=test → in-memory store,
 * isolated) on a test port and exercises the live HTTP surface end-to-end —
 * WITHOUT needing Ollama or any model. This catches wiring regressions across the
 * subsystems added over this project (goals, checkpoints, quality-SR, self-model,
 * contradiction ledger, graph health, benchmark) that pure unit tests can't.
 *
 * Run: npm run test:integration   (from agent-machine/)
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'

const PORT = 8099
const BASE = `http://127.0.0.1:${PORT}`
let server: ChildProcess

async function get(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(5000) })
  return { status: r.status, body: await r.json().catch(() => null) }
}
async function post(path: string, payload: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(5000),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

before(async () => {
  server = spawn('node', ['--import', 'tsx', 'server.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    // Dead Ollama hosts → embeddings fail fast (lexical fallback), so the suite is
    // hermetic and not flaky under load: ingest stays instant and RAG retrieval
    // still works via lexical search without depending on a live Ollama.
    // NOETICA_ORIGIN_GUARD=0: these are functional route tests (no Origin header), not CSRF tests.
    // Without this the suite is non-deterministic — it passes only when ~/.noetica/local-token happens
    // NOT to exist, since a present token makes the guard reject no-Origin writes with 403.
    env: { ...process.env, NODE_ENV: 'test', NOETICA_AM_PORT: String(PORT), NOETICA_ORIGIN_GUARD: '0', OLLAMA_HOST: 'http://127.0.0.1:1', OLLAMA_FALLBACK_HOST: 'http://127.0.0.1:1' },
    stdio: 'ignore',
  })
  // Poll until the server is listening.
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(1500) }); if (r.ok) return } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 500))
  }
  throw new Error('server did not start within 30s')
})

after(() => { server?.kill('SIGKILL') })

test('GET /api/status returns version + capabilities', async () => {
  const { status, body } = await get('/api/status')
  assert.equal(status, 200)
  assert.ok(body.version, 'version present')
})

test('goals CRUD round-trips', async () => {
  const create = await post('/api/goals', { session_id: 'itest', objective: 'ship integration tests', subtasks: [{ title: 'write', done: false }], slots: [{ name: 'scope', filled: false }] })
  assert.equal(create.status, 200)
  assert.equal(create.body.goal.objective, 'ship integration tests')
  const list = await get('/api/goals?session=itest')
  assert.ok(list.body.goals.some((g: any) => g.objective === 'ship integration tests'))
})

test('self-model + feedback endpoints respond', async () => {
  assert.equal((await get('/api/self/capabilities')).status, 200)
  const fb = await post('/api/self/feedback', { task: 'general', provider: 'ollama', model: 'qwen2.5:7b', reward: 0.9 })
  assert.equal(fb.status, 200)
  assert.equal(fb.body.ok, true)
})

test('quality drivers, checkpoints, contradictions, benchmark, graph health all respond', async () => {
  const q = await get('/api/quality/drivers'); assert.equal(q.status, 200); assert.ok('total_samples' in q.body)
  const c = await get('/api/checkpoints?session=itest'); assert.equal(c.status, 200); assert.ok(Array.isArray(c.body.checkpoints))
  const e = await get('/api/epistemic/contradictions'); assert.equal(e.status, 200); assert.ok(Array.isArray(e.body.contradictions))
  const b = await get('/api/benchmark/summary'); assert.equal(b.status, 200); assert.ok(Array.isArray(b.body.summary))
  const h = await get('/api/graph/health'); assert.equal(h.status, 200); assert.ok(h.body.graph)
})

test('learning trends endpoint exposes quality/bandit/graph axes', async () => {
  const { status, body } = await get('/api/self/trends')
  assert.equal(status, 200)
  assert.ok(body.quality && Array.isArray(body.quality.buckets), 'quality trend present')
  assert.ok(Array.isArray(body.bandit), 'bandit standings present')
  assert.ok(body.graph && typeof body.graph.derived_edges === 'number', 'graph derived-edge count present')
  assert.ok(Array.isArray(body.history), 'long-horizon trend history present')
  assert.ok(body.history.length >= 1, 'boot snapshot recorded')
  assert.ok('avg_worth' in body.history[0] && 'derived_edges' in body.history[0], 'snapshot shape')
})

test('RAG: document ingest chunks + stores (retrieval-into-chat asserted in fallback suite)', async () => {
  // This suite runs with no Ollama (hermetic), so the chat handler short-circuits
  // at the availability gate before retrieval. We assert ingest here; the full
  // "doc surfaces as semantic-documents in chat" assertion lives in the fallback
  // suite, which has a mock Ollama that lets the chat proceed to retrieval.
  const ing = await post('/api/ingest/document', {
    filename: 'baxter.txt',
    content: 'The Baxter facility in North Cove shut down after Hurricane Helene flooding in September 2024.',
  })
  assert.equal(ing.status, 200)
  assert.ok(ing.body.chunks >= 1, 'document chunked')
  assert.ok(typeof ing.body.embedded === 'number', 'embedded count reported')
})

test('flags endpoint reports feature-flag state + graduation status', async () => {
  const { status, body } = await get('/api/flags')
  assert.equal(status, 200)
  assert.ok(Array.isArray(body.flags) && body.flags.length >= 8)
  const f = body.flags[0]
  assert.ok('env' in f && 'enabled' in f && 'status' in f && 'description' in f)
  assert.equal(body.auth_required, false)
})

test('POST /api/acquire records a governed action + fails closed when the worker URL is unset', async () => {
  // ACQUIRE_WORKER_URL is not set in the test env, so acquisition MUST fail closed (503) rather than
  // Noetica fetching the URL itself — and the action MUST still be recorded as a governed run.
  const { status, body } = await post('/api/acquire', { url: 'https://example.com/', accountClass: 'sovereign', tier: 'T1' })
  assert.equal(status, 503)
  assert.equal(body.error, 'ACQUIRE_WORKER_URL not configured')
  assert.ok(typeof body.actionId === 'string' && body.actionId.startsWith('acq-'), 'returns the governed actionId')
  // The governed action is auditable in the same runs plane as /api/runs, marked failed.
  const runs = await get('/api/runs')
  const recorded = runs.body.runs.find((r: any) => r.id === body.actionId)
  assert.ok(recorded, 'acquisition action is recorded in the runs plane')
  assert.equal(recorded.role, 'acquire')
  assert.equal(recorded.status, 'error')
})

test('POST /api/acquire rejects a missing/invalid url', async () => {
  assert.equal((await post('/api/acquire', {})).status, 400)
  assert.equal((await post('/api/acquire', { url: 'not-a-url' })).status, 400)
})

test('acquire is advertised as a first-class built-in tool (the MCP/tool surface)', async () => {
  // /api/status maps over BUILTIN_TOOLS — the single tool-advertisement surface the tool plane serves,
  // so a first-class built-in MUST appear here, not only in the internal dispatch switch.
  const { body } = await get('/api/status')
  assert.ok(Array.isArray(body.tools), 'status advertises a tools list')
  assert.ok(body.tools.includes('acquire'), 'acquire is advertised in the tool list')
})

test('acquire tool handler fails closed (no worker) via POST /api/tool — never fetches inline', async () => {
  // The tool must reuse the SAME governed path as POST /api/acquire: with ACQUIRE_WORKER_URL unset it
  // fails closed (a clear tool error) rather than fetching the URL itself, and records a governed run.
  const { status, body } = await post('/api/tool', { name: 'acquire', input: { url: 'https://example.com/' } })
  assert.equal(status, 200)
  assert.equal(typeof body.result, 'string')
  assert.match(body.result, /failing closed|ACQUIRE_WORKER_URL not configured/i)
  const m = /\bacq-[a-z0-9-]+/i.exec(body.result)
  assert.ok(m, 'tool result names the governed actionId')
  // The governed action is recorded in the same runs plane as POST /api/acquire, marked failed.
  const runs = await get('/api/runs')
  const recorded = runs.body.runs.find((r: any) => r.id === m![0])
  assert.ok(recorded, 'acquire tool run is recorded in the runs plane')
  assert.equal(recorded.role, 'acquire')
  assert.equal(recorded.status, 'error')
})

test('self/reset prunes learned state (auth disabled by default)', async () => {
  const { status, body } = await post('/api/self/reset', {})
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.ok(body.cleared && typeof body.cleared.capabilities === 'number')
})

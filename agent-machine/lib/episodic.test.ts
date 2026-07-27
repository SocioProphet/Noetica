import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recallExchanges, formatExchanges, type ExchangeStore, type ExchangeNode } from './episodic.js'

class FakeStore implements ExchangeStore {
  nodes: ExchangeNode[] = []
  /** interaction node id → owning session id, mirroring the engine's HAS_INTERACTION edges */
  sessionOf = new Map<string, string>()
  add(properties: Record<string, unknown>, sessionId?: string) {
    const id = `i${this.nodes.length}`
    this.nodes.push({ id, labels: ['Interaction'], properties })
    if (sessionId) this.sessionOf.set(id, sessionId)
    return this
  }
  nodesByLabel(label: string) { return this.nodes.filter((n) => n.labels.includes(label)) }
  out(id: string, edgeLabel?: string) {
    if (edgeLabel !== 'HAS_INTERACTION') return []
    const sid = id.replace('urn:noetica:session:', '')
    return this.nodes.filter((n) => this.sessionOf.get(n.id) === sid)
  }
}

/** A store with no edge walk — the fail-closed case. */
class EdgelessStore implements ExchangeStore {
  constructor(private inner: FakeStore) {}
  nodesByLabel(label: string) { return this.inner.nodesByLabel(label) }
}

function seed() {
  return new FakeStore()
    .add({ promptSummary: 'How do I configure the local Ollama runtime port?', responseSummary: 'Set NOETICA_OLLAMA_PORT — it defaults to 11435.', timestamp: '2026-06-20T10:00:00Z' })
    .add({ promptSummary: 'What is the capital of France?', responseSummary: 'Paris.', timestamp: '2026-06-20T11:00:00Z' })
    .add({ promptSummary: 'List my files', responseSummary: 'patterns:cache-augmented sources:1', timestamp: '2026-06-20T12:00:00Z' }) // routing metadata
    .add({ promptSummary: 'Old pruned one', responseSummary: 'irrelevant', timestamp: '2026-06-19T09:00:00Z', hygiene_pruned: true })
}

test('recallExchanges finds the relevant prior exchange, ranked', () => {
  const got = recallExchanges(seed(), 'help me set the ollama runtime port', { limit: 3 })
  assert.equal(got.length, 1)
  assert.match(got[0]!.question, /Ollama runtime port/)
  assert.match(got[0]!.answer, /11435/)
})

test('excludes routing-metadata answers, pruned atoms, and unrelated questions', () => {
  const got = recallExchanges(seed(), 'tell me about list files', { minScore: 0.05 })
  assert.ok(!got.some((e) => /patterns:/.test(e.answer)), 'no routing-metadata answers')
  assert.ok(!got.some((e) => e.question === 'Old pruned one'), 'no pruned atoms')
})

test('thin query returns nothing (no spurious recall)', () => {
  assert.deepEqual(recallExchanges(seed(), 'hi'), [])
})

test('excludeRunId skips the current turn', () => {
  const s = new FakeStore().add({ promptSummary: 'configure ollama port', responseSummary: 'use 11435', timestamp: '2026-06-20T10:00:00Z', runId: 'run-now' })
  assert.equal(recallExchanges(s, 'configure ollama port', { excludeRunId: 'run-now', minScore: 0.05 }).length, 0)
})

// ─── Project knowledge boundary ──────────────────────────────────────────────

function seedTwoProjects() {
  return new FakeStore()
    .add({ promptSummary: 'What is our ollama runtime port policy?', responseSummary: 'Port 11435 everywhere.', timestamp: '2026-06-20T10:00:00Z' }, 'sess-alpha')
    .add({ promptSummary: 'What is the ollama runtime port for the client?', responseSummary: 'Client uses 9999.', timestamp: '2026-06-20T11:00:00Z' }, 'sess-beta')
}

test('sessionIds confines recall to the project — no cross-project leakage', () => {
  const got = recallExchanges(seedTwoProjects(), 'ollama runtime port', { sessionIds: ['sess-alpha'], minScore: 0.05, limit: 5 })
  assert.equal(got.length, 1)
  assert.match(got[0]!.answer, /11435/)
  assert.ok(!got.some((e) => /9999/.test(e.answer)), 'the other project must not surface')
})

test('multiple sessions in one project all recall', () => {
  const got = recallExchanges(seedTwoProjects(), 'ollama runtime port', { sessionIds: ['sess-alpha', 'sess-beta'], minScore: 0.05, limit: 5 })
  assert.equal(got.length, 2)
})

test('no sessionIds = unscoped recall (pre-Projects behaviour preserved)', () => {
  const got = recallExchanges(seedTwoProjects(), 'ollama runtime port', { minScore: 0.05, limit: 5 })
  assert.equal(got.length, 2)
})

test('scoped recall fails CLOSED when the store cannot walk edges', () => {
  const got = recallExchanges(new EdgelessStore(seedTwoProjects()), 'ollama runtime port', { sessionIds: ['sess-alpha'], minScore: 0.05 })
  assert.deepEqual(got, [], 'an unenforceable boundary must recall nothing, never everything')
})

test('an unfiled session recalls nothing rather than the global set', () => {
  const got = recallExchanges(seedTwoProjects(), 'ollama runtime port', { sessionIds: ['sess-unknown'], minScore: 0.05 })
  assert.deepEqual(got, [])
})

test('formatExchanges renders a block, empty when none', () => {
  assert.equal(formatExchanges([]), '')
  const block = formatExchanges([{ question: 'q', answer: 'a', ts: 't', score: 0.5 }])
  assert.match(block, /Prior related exchanges/)
  assert.match(block, /Earlier asked: "q" → answered: "a"/)
})

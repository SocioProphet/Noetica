import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeTurnGovernance } from './turnGovernance'
import type { GovernanceTrace } from '@/lib/types/governance'

// A meta event as the server emits it: it is the ONLY carrier of the sovereignty fields.
const meta: GovernanceTrace = {
  run_id: 'meta-run',
  model_routed: 'llava:13b',
  model_requested: 'deepseek-r1:8b',
  model_honored: false,
  route_overrides: [{ layer: 'vision-fallback', from: 'deepseek-r1:8b', to: 'llava:13b', reason: 'image attached', kind: 'capability' }],
} as GovernanceTrace

// The done rebuild the client constructs at end-of-turn — a complete trace, but note it
// carries NONE of the sovereignty fields (model_requested / model_honored / route_overrides).
const done: GovernanceTrace = {
  run_id: 'done-run',
  model_routed: 'llava:13b',
  provider: 'ollama',
  policy_admitted: true,
  memory_written: false,
  evidence_hash: 'sha256:abc',
  latency_ms: 1234,
} as GovernanceTrace

test('sovereignty fields from meta survive the done rebuild (the B2-4 clobber)', () => {
  const g = mergeTurnGovernance(meta, done)
  assert.equal(g.model_requested, 'deepseek-r1:8b')
  assert.equal(g.model_honored, false)
  assert.deepEqual(g.route_overrides, meta.route_overrides)
})

test('done fields win on overlap — they are the final authoritative result', () => {
  const g = mergeTurnGovernance(meta, done)
  assert.equal(g.run_id, 'done-run')
  assert.equal(g.evidence_hash, 'sha256:abc')
  assert.equal(g.latency_ms, 1234)
})

test('a turn with no meta event is safe (no throw, no stale carry)', () => {
  const g = mergeTurnGovernance(undefined, done)
  assert.equal(g.run_id, 'done-run')
  assert.equal(g.model_requested, undefined)
  assert.equal(g.route_overrides, undefined)
})

test('honoured selection is preserved too (not just overrides)', () => {
  const honoured: GovernanceTrace = { ...meta, model_requested: 'qwen2.5:7b', model_honored: true, route_overrides: [] } as GovernanceTrace
  const g = mergeTurnGovernance(honoured, done)
  assert.equal(g.model_requested, 'qwen2.5:7b')
  assert.equal(g.model_honored, true)
})

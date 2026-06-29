import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  bindAutonomy, autonomySession, decideAutonomy, permitsAutonomy, assertAutonomy,
  makeAutonomyGate, onAutonomyDecision, type AutonomySession,
} from './autonomy-gate.js'

afterEach(() => { bindAutonomy(null); onAutonomyDecision(null) })

const conductorL4: AutonomySession = {
  role: 'conductor', authorizedLevel: 'L4', evidence: ['conductor_response_envelope'],
}

test('unbound session does not enforce (backward compatible)', () => {
  assert.equal(autonomySession(), null)
  assert.equal(decideAutonomy('L4'), null)
  assert.equal(permitsAutonomy('L4'), true)
  assert.doesNotThrow(() => assertAutonomy('L4'))
})

test('bind/clear round-trips the session (operator endpoint state)', () => {
  bindAutonomy(conductorL4)
  assert.deepEqual(autonomySession(), conductorL4)
  bindAutonomy(null)
  assert.equal(autonomySession(), null)
})

test('bound session admits an action at its authorized level with evidence', () => {
  bindAutonomy(conductorL4)
  assert.equal(permitsAutonomy('L4'), true)
  assert.doesNotThrow(() => assertAutonomy('L4'))
})

test('bound session is blocked above what evidence supports', () => {
  bindAutonomy({ role: 'coding', authorizedLevel: 'L3', evidence: [] }) // no test/review receipt
  assert.equal(permitsAutonomy('L2'), false)
  assert.throws(() => assertAutonomy('L2'), /AUTONOMY BLOCKED/)
})

test('makeAutonomyGate: tool with no required level passes through', () => {
  bindAutonomy(conductorL4)
  const gate = makeAutonomyGate((t) => (t === 'delegate' ? 'L4' : undefined))
  assert.equal(gate({ name: 'read_file' }).allowed, true)
})

test('makeAutonomyGate: high-autonomy tool admitted with sufficient evidence', () => {
  bindAutonomy(conductorL4)
  const gate = makeAutonomyGate((t) => (t === 'delegate' ? 'L4' : undefined))
  const v = gate({ name: 'delegate', id: 'x' })
  assert.equal(v.allowed, true)
})

test('makeAutonomyGate: blocks + routes decision to the sink when evidence is insufficient', () => {
  bindAutonomy({ role: 'coding', authorizedLevel: 'L4', evidence: [] })
  const seen: string[] = []
  onAutonomyDecision((d) => seen.push(`${d.tool}:${d.grantedLevel}`))
  const gate = makeAutonomyGate((t) => (t === 'deploy' ? 'L4' : undefined))
  const v = gate({ name: 'deploy', id: 'd1' })
  assert.equal(v.allowed, false)
  assert.match(v.reason, /requires L4/)
  assert.equal(seen.length, 1)
  assert.match(seen[0]!, /^deploy:L/)
})

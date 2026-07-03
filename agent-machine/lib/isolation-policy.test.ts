import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifySensitivity, decideIsolation } from './isolation-policy.js'

test('unknown data fails closed → high / local / no egress', () => {
  const d = decideIsolation({ content: 'some benign text' })
  assert.equal(d.sensitivity, 'high')
  assert.equal(d.tier, 'local')
  assert.equal(d.egressAllowed, false)
  assert.equal(d.namespace, 'self')
})

test('public data may reach cloud (egress allowed)', () => {
  const d = decideIsolation({ labels: ['public'], content: 'a press release' })
  assert.equal(d.sensitivity, 'low')
  assert.deepEqual(d.allowedTiers, ['local', 'edge', 'cloud'])
  assert.equal(d.egressAllowed, true)
  assert.equal(d.namespace, 'collective')
})

test('secret content overrides a public label (leakage prevention)', () => {
  const d = decideIsolation({ labels: ['public'], content: 'token ghp_ABCDEFGHIJKLMNOPQRSTUV0123456789' })
  assert.equal(classifySensitivity({ content: 'ghp_ABCDEFGHIJKLMNOPQRSTUV0123456789' }), 'high')
  assert.equal(d.sensitivity, 'high')
  assert.equal(d.tier, 'local')
  assert.equal(d.egressAllowed, false)
  assert.ok(d.conflict)
})

test('requested cloud on high-sensitive is denied + clamped local', () => {
  const d = decideIsolation({ labels: ['secret'], requestedTier: 'cloud' })
  assert.equal(d.tier, 'local')
  assert.ok(d.conflict)
  assert.match(d.reason, /DENIED/)
})

test('medium data routes to edge, never cloud', () => {
  const d = decideIsolation({ labels: ['internal'] })
  assert.equal(d.sensitivity, 'medium')
  assert.equal(d.tier, 'edge')
  assert.deepEqual(d.allowedTiers, ['local', 'edge'])
  assert.equal(d.egressAllowed, false)
})

test('the self namespace keeps even low-sensitivity data on-device', () => {
  const d = decideIsolation({ labels: ['public'], namespace: 'self' })
  assert.equal(d.sensitivity, 'low')
  assert.equal(d.tier, 'local')          // namespace cap (self→local) beats sensitivity ceiling
  assert.equal(d.egressAllowed, false)
})

test('requested lower tier than the ceiling is honored', () => {
  const d = decideIsolation({ labels: ['public'], requestedTier: 'local' })
  assert.equal(d.tier, 'local')
  assert.equal(d.conflict, false)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recordOutcome, checkActorGrant, authorityStatus, authorityState, _reset, TRUST_FLOOR } from './a2a-trust.js'

const PEER = 'spiffe://aiwg.io/server/sdlc-1'

/** Drive a peer down to score 0.40 — below TRUST_FLOOR, but with NO threat/integrity strike, so it is
 *  `reduced`, not suspended or revoked. The trust floor is then the ONLY thing denying it. */
function degrade(id: string): number {
  _reset()
  for (let i = 0; i < 120; i++) recordOutcome(id, { ok: false, up: false })
  return checkActorGrant(id, 'probe').trust
}

test('a2a: fresh peer is cautious-but-allowed at the default floor, denied at a high floor', () => {
  _reset()
  assert.equal(checkActorGrant(PEER, 'read_artifacts').valid, true)
  assert.equal(checkActorGrant(PEER, 'graph_write', 0.8).valid, false, 'sensitive cap must be earned')
})

test('a2a: a threat strike suspends; integrity strike revokes (canonical TrustOps states)', () => {
  _reset()
  for (let i = 0; i < 20; i++) recordOutcome(PEER, { ok: true, up: true })
  assert.equal(authorityStatus(PEER), 'active')
  recordOutcome(PEER, { threat: true })
  assert.equal(authorityStatus(PEER), 'suspended')
  assert.equal(checkActorGrant(PEER, 'read_artifacts').valid, false, 'suspended actor denied')
  _reset()
  for (let i = 0; i < 20; i++) recordOutcome(PEER, { ok: true, up: true })
  recordOutcome(PEER, { integrityViolation: true })
  assert.equal(authorityStatus(PEER), 'revoked')
})

test('a2a: authorityState emits the canonical agent-registry schema', () => {
  _reset()
  const s = authorityState(PEER) as Record<string, unknown>
  assert.equal(s.schemaVersion, 'agent-registry.agent-authority-current-state.v0.1')
  assert.equal(s.recordType, 'AgentAuthorityCurrentState')
  for (const k of ['stateId', 'agentRef', 'authority_status', 'authorityEffects', 'restoration_required', 'receipt_hash']) {
    assert.ok(s[k] !== undefined, `required field ${k}`)
  }
})

test('a2a: a peer recovers after a sustained clean streak', () => {
  _reset()
  for (let i = 0; i < 20; i++) recordOutcome(PEER, { ok: true, up: true })
  recordOutcome(PEER, { threat: true })
  assert.equal(authorityStatus(PEER), 'suspended')
  for (let i = 0; i < 12; i++) recordOutcome(PEER, { ok: true, up: true })
  assert.equal(authorityStatus(PEER), 'active', 'recovers to active after a clean streak')
})

// ── the caller-supplied floor is a ONE-WAY RATCHET ──────────────────────────────────────────────
// Regression for a live authorization bypass: /api/a2a/grant/validate passed `body.floor` — a bare
// JSON.parse value behind a TS `as` cast — straight into checkActorGrant. The old signature
// `floor: number = TRUST_FLOOR` only defaulted on `undefined`, so every other JSON value slipped
// past and then compared FALSE in `r.score < floor`. A degraded peer that `undefined` correctly
// DENIED was GRANTED by {"floor":0} and by eight other hostile shapes.

test('a2a: a caller-supplied floor cannot LOOSEN the gate (the bypass vector table)', () => {
  const score = degrade(PEER)
  assert.equal(score, 0.4, 'fixture: peer sits at 0.40, under TRUST_FLOOR 0.45')
  assert.equal(authorityStatus(PEER), 'reduced', 'fixture: not suspended/revoked — the FLOOR is the gate')

  // Exactly the vectors that granted before the fix. `as unknown as number` is the point: this is
  // what an untyped wire value looks like once the TS cast has been erased at runtime.
  const hostile: Array<[string, unknown]> = [
    ['0', 0], ['-1', -1], ['null', null], ['"abc"', 'abc'], ['"0"', '0'],
    ['[]', []], ['{}', {}], ['false', false], ['""', ''],
    ['NaN', NaN], ['-Infinity', -Infinity],
  ]
  for (const [label, v] of hostile) {
    const d = checkActorGrant(PEER, 'graph_write', v as number)
    assert.equal(d.valid, false, `floor=${label} must NOT grant a peer below TRUST_FLOOR`)
  }
})

test('a2a: an omitted floor still denies a degraded peer and admits a healthy one (teeth both ways)', () => {
  degrade(PEER)
  assert.equal(checkActorGrant(PEER, 'graph_write').valid, false, 'degraded peer denied at the default floor')
  assert.equal(checkActorGrant(PEER, 'graph_write', undefined).valid, false, 'explicit undefined is the same')

  const healthy = 'spiffe://noetica.local/peer/healthy'
  for (let i = 0; i < 20; i++) recordOutcome(healthy, { ok: true, up: true })
  const ok = checkActorGrant(healthy, 'graph_write')
  assert.equal(ok.valid, true, 'a healthy peer is still ADMITTED — the fix is not a blanket deny')
  assert.ok(ok.trust > TRUST_FLOOR)
})

test('a2a: a floor may still TIGHTEN the gate — the legitimate use survives', () => {
  _reset()
  const healthy = 'spiffe://noetica.local/peer/healthy'
  for (let i = 0; i < 20; i++) recordOutcome(healthy, { ok: true, up: true })
  const score = checkActorGrant(healthy, 'graph_write').trust
  assert.equal(checkActorGrant(healthy, 'graph_write', score + 0.001).valid, false,
    'a HIGHER floor must still be honoured (sensitive capabilities demand a higher bar)')
  assert.equal(checkActorGrant(healthy, 'graph_write', TRUST_FLOOR).valid, true,
    'asking for exactly TRUST_FLOOR is a no-op, not a rejection')
})

test('a2a: revoked/suspended are decided BEFORE the floor — no floor value reaches them', () => {
  // Scope check: the bypass defeated the trust FLOOR only. Prove the strike states are unreachable
  // by any floor, hostile or otherwise, so the blast radius stays where it was measured.
  for (const strike of [{ threat: true }, { integrityViolation: true }] as const) {
    _reset()
    for (let i = 0; i < 20; i++) recordOutcome(PEER, { ok: true, up: true })
    recordOutcome(PEER, strike)
    for (const v of [0, -1, null, 'abc', [], {}, false, '', undefined]) {
      const d = checkActorGrant(PEER, 'graph_write', v as number)
      assert.equal(d.valid, false, `strike state must deny regardless of floor=${JSON.stringify(v)}`)
      assert.ok(/revoked|suspended/.test(d.reason), 'denied by the strike state, not the floor')
    }
  }
})

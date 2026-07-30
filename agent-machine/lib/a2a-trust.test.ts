import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { recordOutcome, checkActorGrant, authorityStatus, authorityState, _reset, _storePath, TRUST_FLOOR } from './a2a-trust.js'

// ── Point the ledger at a throwaway file BEFORE any test runs ───────────────────────────────────
// Every test here calls _reset() (and recordOutcome() in 120-iteration loops), and BOTH persist. Without
// this redirect the suite writes the operator's real ~/.noetica/a2a-trust.json — the ledger that
// /api/a2a/grant/validate makes live authorization decisions from. It did: a run on 2026-07-29 left the
// real ledger holding nothing but this file's PEER fixture.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'noetica-a2a-trust-'))
process.env['NOETICA_A2A_STORE'] = path.join(TMP_HOME, 'a2a-trust.json')
process.on('exit', () => { try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch { /* best effort */ } })

/** The operator's REAL ledger path, resolved from the passwd database rather than $HOME.
 *  os.homedir() honours $HOME, so a test that moved HOME could "pass" while still aimed at the real
 *  file (or mask a regression). os.userInfo().homedir cannot be talked out of the truth. */
const REAL_LEDGER = path.join(os.userInfo().homedir, '.noetica', 'a2a-trust.json')
/** exists/size/mtime fingerprint — null when absent. Never writes. */
const fingerprint = (p: string): string =>
  { try { const s = fs.statSync(p); return `${s.size}:${s.mtimeMs}` } catch { return 'ABSENT' } }

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

// ── the store path must never be the operator's real ledger ─────────────────────────────────────
// Regression for a data-destructive test hazard: the store path was a module-load constant
// (`const STORE = path.join(os.homedir(), …)`), so _reset()/recordOutcome() persisted straight into
// ~/.noetica/a2a-trust.json. A run wiped the real ledger down to this file's fixtures. Erasure is
// FAIL-OPEN — an absent record falls back to fresh() at score 0.64, over TRUST_FLOOR — so the suite
// silently re-granted authority to revoked peers. These tests are the reason it cannot come back.

test('a2a store path: the ledger under test is NEVER the operator real ~/.noetica ledger', () => {
  const store = path.resolve(_storePath())
  assert.notEqual(store, REAL_LEDGER, 'the suite must not be pointed at the production trust ledger')

  // Containment, not string-prefix: anything under the real ~/.noetica is off limits.
  const realDir = path.join(os.userInfo().homedir, '.noetica')
  const rel = path.relative(realDir, store)
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  assert.equal(inside, false, `store resolved inside the real sovereign data dir: ${store}`)
})

test('a2a store path: persisting writes the override and leaves the real ledger untouched', () => {
  const before = fingerprint(REAL_LEDGER)

  // The two functions that persist — exactly what every test above calls.
  _reset()
  recordOutcome(PEER, { ok: true, up: true })

  const store = _storePath()
  assert.ok(fs.existsSync(store), 'the override path is what actually received the write')
  assert.equal(fingerprint(REAL_LEDGER), before,
    'the real ledger was modified by the test suite — the store path leaked back to $HOME')
})

test('a2a store path: with no override the default IS the production ledger (teeth both ways)', () => {
  // The fix must not be a blanket redirect: with nothing injected, production still resolves to
  // ~/.noetica/a2a-trust.json. _storePath() is pure, so reading it here writes nothing.
  const saved = process.env['NOETICA_A2A_STORE']
  try {
    delete process.env['NOETICA_A2A_STORE']
    assert.equal(_storePath(), path.join(os.homedir(), '.noetica', 'a2a-trust.json'))
  } finally {
    if (saved === undefined) delete process.env['NOETICA_A2A_STORE']
    else process.env['NOETICA_A2A_STORE'] = saved
  }
  // …and the redirect is live again for anything that runs after this test.
  assert.equal(_storePath(), path.join(TMP_HOME, 'a2a-trust.json'))
})

test('a2a store path: resolution is LATE — an override set after import still takes effect', () => {
  // The original bug was a module-load constant, which made import ORDER load-bearing. Prove the path
  // is read at call time so a redirect works on an already-imported module.
  const saved = process.env['NOETICA_A2A_STORE']
  const late = path.join(TMP_HOME, 'late-override.json')
  try {
    process.env['NOETICA_A2A_STORE'] = late
    assert.equal(_storePath(), late, 'store path was frozen at import — the hazard has regressed')
    _reset()
    assert.ok(fs.existsSync(late), 'persist() honours the late override')
  } finally {
    if (saved === undefined) delete process.env['NOETICA_A2A_STORE']
    else process.env['NOETICA_A2A_STORE'] = saved
  }
})

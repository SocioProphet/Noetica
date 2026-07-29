/** Tests for the Reasoner pipeline (lib/reasoner.ts) — validating the spec's actual decision rules:
 *  evidence composition (§9 SEV-1), the small-N gate (§9 SEV-3), policy hard-block (§5), HC validity
 *  (§3.2), detector self-abstention (§2 ED-2), and the §6 counter-test routing table. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  reason, routeCtest, CTEST_ROUTING, DEFAULT_THRESHOLDS, REQUIRED_COUNTER_TESTS, undeclaredRequirement,
  type ReasonerInput, type DetectorFiring, type CounterTestResult,
} from './reasoner.js'

// helper: N detector firings against one claim, so the small-N gate can be exercised
function firings(claim: string, ruleId: string, score: number, n: number): DetectorFiring[] {
  return Array.from({ length: n }, () => ({ ruleId, targetClaim: claim, score }))
}

/** LOGFALL.STRAWMAN.V2's ruleset-required counter-test, CONFIRMED. Supplied by the composition tests so
 *  they exercise the §9 severity math rather than the counter-test gate — the gate has its own tests. */
const steelmanConfirmed = (claim: string): CounterTestResult[] => [
  { ctestId: 'CTEST.STEELMAN.CONFIRM.V2', targetClaim: claim, outcome: 'confirmed' },
]

test('a clean claim with no firings is pass and clear', () => {
  const v = reason({ claims: ['c1'], detectorFirings: [] })
  assert.equal(v.clear, true)
  assert.equal(v.verdicts[0]!.severity, 'pass')
  assert.ok(Math.abs(v.verdicts[0]!.pSound - 0.5) < 1e-9)   // no evidence → uniform prior
})

test('§9 SEV-1 composition: three sub-warn detections jointly cross into block, none would alone', () => {
  // 30 firings so the FULL MAP regime applies (small-N gate satisfied). Each modest negative weight;
  // they SUM on the same IsSound atom, driving pSound down past θ_block.
  const input: ReasonerInput = {
    claims: ['c1'],
    detectorFirings: firings('c1', 'LOGFALL.STRAWMAN.V2', 0.3, 30),
    counterTests: steelmanConfirmed('c1'),
  }
  const v = reason(input)
  assert.equal(v.verdicts[0]!.measurementQuality, 'full')
  assert.ok(v.verdicts[0]!.pSound < DEFAULT_THRESHOLDS.block, 'summed negative weights push pSound below θ_block')
  assert.equal(v.verdicts[0]!.severity, 'block')
  assert.equal(v.clear, false)   // fail-closed: one block fails the set
})

test('contradiction tolerance: strong grounded evidence offsets a detection rather than being nuked', () => {
  const input: ReasonerInput = {
    claims: ['c1'],
    detectorFirings: firings('c1', 'LOGFALL.HASTY.V1', 0.5, 30),
    groundedEvidence: Array.from({ length: 30 }, (_, i) => ({ targetClaim: 'c1', weight: 0.6, evidenceId: `ev${i}` })),
  }
  const v = reason(input)
  // positive grounding weight (0.6×30) outweighs the negative detections (−0.5×30) → claim stays sound-ish
  assert.ok(v.verdicts[0]!.pSound > 0.5, 'grounded evidence is not overridden by a single detector family')
  assert.notEqual(v.verdicts[0]!.severity, 'block')
})

test('§9 SEV-3 small-N gate: ≤10 firings falls back to deterministic per-detector severity (measurementQuality=fallback)', () => {
  const input: ReasonerInput = {
    claims: ['c1'],
    detectorFirings: firings('c1', 'LOGFALL.STRAWMAN.V2', 0.9, 3),
    counterTests: steelmanConfirmed('c1'),
  }
  const v = reason(input)
  assert.equal(v.verdicts[0]!.measurementQuality, 'fallback')
  assert.equal(v.verdicts[0]!.contributingFirings, 3)
  // deterministic fallback: worst score 0.9 → pSoundEquiv 0.1 < θ_block → block (per-detector behavior)
  assert.equal(v.verdicts[0]!.severity, 'block')
})

test('§9 SEV-3: 11-29 firings is the LIMITED regime (MAP-based but stamped limited)', () => {
  const input: ReasonerInput = { claims: ['c1'], detectorFirings: firings('c1', 'LOGFALL.STRAWMAN.V2', 0.5, 15) }
  const v = reason(input)
  assert.equal(v.verdicts[0]!.measurementQuality, 'limited')
})

test('§5 policy hard-constraint forces block regardless of pSound', () => {
  const input: ReasonerInput = {
    claims: ['c1'],
    detectorFirings: [],   // no detections at all → pSound would be 0.5 → pass
    policyConstraints: [{ claim: 'c1', reason: 'POLICY.CSAM.V1' }],
  }
  const v = reason(input)
  assert.equal(v.verdicts[0]!.policyBlocked, true)
  assert.equal(v.verdicts[0]!.severity, 'block')
  assert.equal(v.clear, false)
})

test('§2 ED-2 self-abstention: a decayed-weight detector still counts but exerts no force', () => {
  // implicationStrength drives the effective weight below ε_zero → abstained: audited, no inference effect.
  const input: ReasonerInput = {
    claims: ['c1'],
    detectorFirings: firings('c1', 'LOGFALL.STRAWMAN.V2', 0.5, 12).map((f) => ({ ...f, implicationStrength: 0.01 })),
  }
  const v = reason(input)
  assert.equal(v.verdicts[0]!.abstainedFirings.length, 12)   // all recorded as abstained
  assert.ok(Math.abs(v.verdicts[0]!.pSound - 0.5) < 1e-6)    // yet pSound is unmoved from the 0.5 prior
})

test('§3.2 HC validity: a non-finite weight is rejected with HC_VIOLATION before inference', () => {
  const input: ReasonerInput = { claims: ['c1'], detectorFirings: [{ ruleId: 'LOGFALL.X.V1', targetClaim: 'c1', score: Infinity }] }
  const v = reason(input)
  assert.ok(v.hcViolation)
  assert.match(v.hcViolation!, /HC_VIOLATION/)
  assert.equal(v.clear, false)
})

test('multiple claims are judged independently; the set is clear only if none block', () => {
  const input: ReasonerInput = {
    claims: ['c1', 'c2'],
    detectorFirings: firings('c1', 'LOGFALL.STRAWMAN.V2', 0.9, 3),   // c1 blocks (fallback)
    counterTests: steelmanConfirmed('c1'),
  }
  const v = reason(input)
  assert.equal(v.verdicts.find((x) => x.claim === 'c2')!.severity, 'pass')
  assert.equal(v.clear, false)   // c1's block fails the whole set
})


// ─── the counter-test gate (counter_tests_required_for_warn_or_block) ─────────────────────────────────

test('gate: a block with NO counter-test run is downgraded to info, not asserted', () => {
  const input: ReasonerInput = { claims: ['c1'], detectorFirings: firings('c1', 'LOGFALL.STRAWMAN.V2', 0.9, 3) }
  const v = reason(input)
  const verdict = v.verdicts[0]!
  assert.equal(verdict.provisionalSeverity, 'block', 'composition still computes block')
  assert.equal(verdict.severity, 'info', 'but an un-counter-tested block may not stand')
  assert.equal(verdict.counterTestGate.satisfied, false)
  assert.equal(verdict.counterTestGate.downgradedFrom, 'block')
  assert.deepEqual(verdict.counterTestGate.missing, ['CTEST.STEELMAN.CONFIRM.V2'])
  assert.equal(v.gatedDowngrades, 1)
  assert.equal(v.clear, true, 'an uncertified block does not fail the set')
})

test('gate: the same block STANDS once its required counter-test confirms', () => {
  const input: ReasonerInput = {
    claims: ['c1'],
    detectorFirings: firings('c1', 'LOGFALL.STRAWMAN.V2', 0.9, 3),
    counterTests: steelmanConfirmed('c1'),
  }
  const v = reason(input)
  assert.equal(v.verdicts[0]!.severity, 'block')
  assert.equal(v.verdicts[0]!.counterTestGate.satisfied, true)
  assert.equal(v.gatedDowngrades, 0)
  assert.equal(v.clear, false)
})

test('gate: a REFUTED or INCONCLUSIVE counter-test does not certify', () => {
  for (const outcome of ['refuted', 'inconclusive'] as const) {
    const v = reason({
      claims: ['c1'],
      detectorFirings: firings('c1', 'LOGFALL.STRAWMAN.V2', 0.9, 3),
      counterTests: [{ ctestId: 'CTEST.STEELMAN.CONFIRM.V2', targetClaim: 'c1', outcome }],
    })
    assert.equal(v.verdicts[0]!.severity, 'info', `${outcome} must not certify a block`)
  }
})

test('gate: conflicting outcomes for one counter-test do NOT certify', () => {
  // A confirmed entry must not certify past a refuted one for the same
  // (claim, ctestId). Conflicting evidence is not evidence of soundness.
  const v = reason({
    claims: ['c1'],
    detectorFirings: firings('c1', 'LOGFALL.STRAWMAN.V2', 0.9, 3),
    counterTests: [
      { ctestId: 'CTEST.STEELMAN.CONFIRM.V2', targetClaim: 'c1', outcome: 'confirmed' },
      { ctestId: 'CTEST.STEELMAN.CONFIRM.V2', targetClaim: 'c1', outcome: 'refuted' },
    ],
  })
  assert.equal(v.verdicts[0]!.severity, 'info', 'conflicting evidence must not certify a block')
  assert.equal(v.verdicts[0]!.counterTestGate.satisfied, false)
  assert.deepEqual(v.verdicts[0]!.counterTestGate.missing, ['CTEST.STEELMAN.CONFIRM.V2'])
})

test('gate: duplicate CONFIRMED entries still certify (agreement, not conflict)', () => {
  const v = reason({
    claims: ['c1'],
    detectorFirings: firings('c1', 'LOGFALL.STRAWMAN.V2', 0.9, 3),
    counterTests: [
      { ctestId: 'CTEST.STEELMAN.CONFIRM.V2', targetClaim: 'c1', outcome: 'confirmed' },
      { ctestId: 'CTEST.STEELMAN.CONFIRM.V2', targetClaim: 'c1', outcome: 'confirmed' },
    ],
  })
  assert.equal(v.verdicts[0]!.severity, 'block')
  assert.equal(v.verdicts[0]!.counterTestGate.satisfied, true)
})

test('gate: required and missing lists are de-duplicated', () => {
  const v = reason({
    claims: ['c1'],
    detectorFirings: [
      ...firings('c1', 'LOGFALL.STRAWMAN.V2', 0.9, 2),
      ...firings('c1', 'LOGFALL.STRAWMAN.V2', 0.8, 2),
    ],
  })
  const gate = v.verdicts[0]!.counterTestGate
  assert.deepEqual(gate.required, ['CTEST.STEELMAN.CONFIRM.V2'])
  assert.deepEqual(gate.missing, ['CTEST.STEELMAN.CONFIRM.V2'])
})

test('gate: a counter-test confirmed for a DIFFERENT claim does not certify this one', () => {
  const v = reason({
    claims: ['c1'],
    detectorFirings: firings('c1', 'LOGFALL.STRAWMAN.V2', 0.9, 3),
    counterTests: steelmanConfirmed('other-claim'),
  })
  assert.equal(v.verdicts[0]!.severity, 'info')
  assert.equal(v.verdicts[0]!.counterTestGate.satisfied, false)
})

test('gate: a detector with an UNDECLARED requirement cannot certify (unknown is not satisfied)', () => {
  // LOGFALL.ADHOMINEM.V1 is the id debate-detectors.ts implements; the 1.3.0 ruleset declares
  // LOGFALL.ADHOM.V2. The namespaces diverge, so the requirement is undeclared and cannot be certified.
  assert.equal(REQUIRED_COUNTER_TESTS['LOGFALL.ADHOMINEM.V1'], undefined)
  const v = reason({ claims: ['c1'], detectorFirings: firings('c1', 'LOGFALL.ADHOMINEM.V1', 0.9, 3) })
  assert.equal(v.verdicts[0]!.provisionalSeverity, 'block')
  assert.equal(v.verdicts[0]!.severity, 'info')
  assert.deepEqual(v.verdicts[0]!.counterTestGate.missing, [undeclaredRequirement('LOGFALL.ADHOMINEM.V1')])
})

test('gate: info and pass severities are never gated (nothing to certify)', () => {
  const v = reason({ claims: ['c1'], detectorFirings: [] })
  assert.equal(v.verdicts[0]!.severity, 'pass')
  assert.equal(v.verdicts[0]!.counterTestGate.satisfied, true)
  assert.equal(v.verdicts[0]!.counterTestGate.required.length, 0)
})

test('gate: a §5 POLICY hard block is NOT gated — independent authority', () => {
  const v = reason({
    claims: ['c1'],
    detectorFirings: [],
    policyConstraints: [{ claim: 'c1', reason: 'POLICY.CSAM.V1' }],
  })
  assert.equal(v.verdicts[0]!.severity, 'block', 'policy authority does not need a counter-test')
  assert.equal(v.verdicts[0]!.counterTestGate.satisfied, true)
  assert.equal(v.clear, false)
})

test('gate: every counter-test named in the map is a CTEST id', () => {
  for (const [ruleId, ctests] of Object.entries(REQUIRED_COUNTER_TESTS)) {
    assert.ok(ctests.length > 0, `${ruleId} declares no counter-test`)
    for (const id of ctests) assert.match(id, /^CTEST\./)
  }
})

// ─── §6 counter-test routing ───────────────────────────────────────────────────────────────────────────

test('§6 CTEST routing: identity-lock and acyclic-proof are Tier-A reasoner ops', () => {
  assert.equal(routeCtest('CTEST.TERMS.LOCK.V1').tier, 'A')
  assert.equal(routeCtest('CTEST.TERMS.LOCK.V1').engine, 'reasoner')
  assert.equal(routeCtest('CTEST.ACYCLIC.PROOF.V1').tier, 'A')
})

test('§6 CTEST routing: chain-probability and evidence-LR are Tier-B reasoner ops', () => {
  assert.equal(routeCtest('CTEST.CHAIN.PROB.V1').tier, 'B')
  assert.equal(routeCtest('CTEST.EVIDENCE-LR.V1').engine, 'reasoner')
})

test('§6 Rule CT-1: an unlisted counter-test defaults to the standalone classifier runner', () => {
  const r = routeCtest('CTEST.SOMETHING.NEW.V9')
  assert.equal(r.engine, 'classifier')
})

test('all six mapped counter-tests route to the reasoner engine (§6 table)', () => {
  for (const id of Object.keys(CTEST_ROUTING)) assert.equal(routeCtest(id).engine, 'reasoner')
})

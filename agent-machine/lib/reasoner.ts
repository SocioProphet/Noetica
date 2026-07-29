/**
 * reasoner — the Reasoner *pipeline* that composes the ground-MLN core (lib/mln.ts) into the decision
 * flow the "Debater 2.0 × Graph-Brain MLN Integration Layer" spec describes: detector firings + discourse
 * edges + an optional domain value-driver prior are fused into ONE ground network, and a claim's severity
 * (block/warn/info/pass) is read off the marginal probability that the claim is sound (§9) — NOT off any
 * single detector's fixed severity.
 *
 * This is pure logic: no event bus, no persistent store, no network I/O. It's the runnable core a real
 * Reasoner *service* would wrap (see reasoner-bus.ts for the mock-bus service shell). Everything the spec
 * bolts on around it — Kafka topics, Neo4j persistence, K8s, mTLS, the Tier-B async pool — is deployment
 * plumbing, deliberately absent here (documented in the mln.ts commit + memory).
 *
 * The key modeling reduction (faithful to §2 + §9's composition rule): a claim gets one boolean atom
 * IsSound(claim). Every detector firing against that claim contributes a SIGNED weight to that atom
 * (LOGFALL/COGBIAS negative, grounded evidence positive — §2.2). Because they all weight the same atom,
 * they SUM — so "three sub-θ_warn detections jointly cross θ_block" (§9 Rule SEV-1) is automatic, and
 * "one detector can't nuke a well-grounded claim" (contradiction tolerance) is automatic too: a strong
 * positive grounding weight offsets a negative detection rather than being overridden.
 */
import {
  type GroundNetwork, type Formula, type Severity, type SeverityThresholds,
  marginalProbability, mapInference, classifySeverity, canUseMapSeverity,
  signedWeight, isAbstained,
} from './mln.js'

export interface DetectorFiring {
  ruleId: string          // e.g. 'LOGFALL.STRAWMAN.V2' — sign comes from the family (§2.2)
  targetClaim: string     // the claim id this firing bears on
  score: number           // deterministic detector score in [0,1] (UNCHANGED from the base detector)
  implicationStrength?: number   // learned/calibrated multiplier on the score (default 1); decay→0 self-abstains
}

export interface GroundedEvidence {
  targetClaim: string
  weight: number          // positive weight raising IsSound(claim); e.g. a T1 grounded fact (§2.2)
  evidenceId: string
}

export interface PolicyHardConstraint {
  claim: string           // a claim under a hard POLICY.* constraint → block-critical (§5) regardless of P
  reason: string
}

export type CounterTestOutcome = 'confirmed' | 'refuted' | 'inconclusive'

export interface CounterTestResult {
  ctestId: string         // e.g. 'CTEST.STEELMAN.CONFIRM.V2'
  targetClaim: string     // the claim the counter-test was run against
  outcome: CounterTestOutcome
}

export interface ReasonerInput {
  claims: string[]
  detectorFirings: DetectorFiring[]
  groundedEvidence?: GroundedEvidence[]
  policyConstraints?: PolicyHardConstraint[]
  thresholds?: SeverityThresholds
  /** Counter-test results available for this pass. Absent = not run. See the gate below: a detection
   *  whose required counter-tests have not CONFIRMED cannot escalate a claim to warn or block. */
  counterTests?: CounterTestResult[]
  /** Override the detector→required-counter-test map (defaults to REQUIRED_COUNTER_TESTS). Injectable
   *  so a caller pinned to a different ruleset version supplies its own pairings rather than silently
   *  inheriting these. */
  requiredCounterTests?: Record<string, readonly string[]>
}

export const DEFAULT_THRESHOLDS: SeverityThresholds = { block: 0.3, warn: 0.55, ok: 0.8 }

const soundAtom = (claim: string): string => `IsSound(${claim})`

export interface CounterTestGate {
  satisfied: boolean                   // every required counter-test for the contributing firings CONFIRMED
  required: string[]                   // counter-test ids the contributing detections require
  missing: string[]                    // required but not confirmed: absent, refuted, inconclusive, or undeclared
  downgradedFrom?: Severity            // set when the gate suppressed a warn/block
}

export interface ClaimVerdict {
  claim: string
  pSound: number                       // marginal P(IsSound(claim)) — the number §9 thresholds against
  severity: Severity                   // AUTHORITATIVE: composition result after the counter-test gate
  provisionalSeverity: Severity        // what composition produced BEFORE gating (the §9 math, unchanged)
  counterTestGate: CounterTestGate     // why severity does or does not equal provisionalSeverity
  measurementQuality: 'full' | 'limited' | 'fallback'   // §9 Rule SEV-3 small-N gate
  contributingFirings: number          // how many detector firings bore on this claim (the "N" for the gate)
  policyBlocked: boolean               // a hard POLICY.* constraint forces block regardless of pSound (§5)
  abstainedFirings: string[]           // rule_ids whose weight decayed below ε_zero — audited, no force (§2 ED-2)
}

export interface ReasonerVerdict {
  clear: boolean                       // conform to the existing scope-d/action-cell verdict shape
  verdicts: ClaimVerdict[]
  hcViolation?: string                 // §3.2 Rule DG-2: network wasn't a valid Gibbs distribution
  gatedDowngrades: number              // how many claims would have warned/blocked but lacked counter-tests
}

/** Build the per-claim ground network for one claim: all firings + grounded evidence weighting its
 *  IsSound atom. Kept per-claim (not one giant network) because claims are conditionally independent
 *  given their own evidence here — which also keeps every network trivially inside the tractable atom
 *  ceiling, the block-critical-subset discipline of §5 made structural. */
function claimNetwork(claim: string, input: ReasonerInput): { net: GroundNetwork; firingCount: number; abstained: string[] } {
  const atom = soundAtom(claim)
  const formulas: Formula[] = []
  const abstained: string[] = []
  let firingCount = 0

  for (const f of input.detectorFirings) {
    if (f.targetClaim !== claim) continue
    firingCount++
    const magnitude = f.score * (f.implicationStrength ?? 1)
    const w = signedWeight(f.ruleId, magnitude)
    if (isAbstained(w)) { abstained.push(f.ruleId); continue }   // §2 ED-2: still counted, exerts no force
    formulas.push({ id: `${f.ruleId}@${claim}`, predicate: 'Detected', atoms: [atom], weight: w, source: 'detector' })
  }
  for (const e of input.groundedEvidence ?? []) {
    if (e.targetClaim !== claim) continue
    const w = Math.abs(e.weight)   // grounded evidence is positive by convention (§2.2)
    if (isAbstained(w)) continue
    formulas.push({ id: e.evidenceId, predicate: 'Grounded', atoms: [atom], weight: w, source: 'implication' })
  }
  return { net: { atoms: [atom], formulas }, firingCount, abstained }
}

/** §3.2 Rule DG-2 (Hammersley–Clifford validity): a strictly-positive Gibbs distribution requires finite
 *  weights (no unintended ±∞). Non-finite weights → HC_VIOLATION, reject before inference. */
function hcValidate(input: ReasonerInput): string | null {
  for (const f of input.detectorFirings) {
    const w = f.score * (f.implicationStrength ?? 1)
    if (!Number.isFinite(w)) return `HC_VIOLATION: non-finite weight from firing ${f.ruleId}@${f.targetClaim}`
  }
  for (const e of input.groundedEvidence ?? []) {
    if (!Number.isFinite(e.weight)) return `HC_VIOLATION: non-finite weight from evidence ${e.evidenceId}`
  }
  return null
}

/** The full Tier-A synchronous reasoning pass (§5): for each claim, compose evidence, run exact MAP/
 *  marginal over its (small, block-critical) network, and classify severity — with the small-N gate
 *  falling back to deterministic worst-detector severity below N≤10 (§9 Rule SEV-3). */
export function reason(input: ReasonerInput): ReasonerVerdict {
  const hc = hcValidate(input)
  if (hc) return { clear: false, verdicts: [], hcViolation: hc, gatedDowngrades: 0 }

  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS
  const policyClaims = new Set((input.policyConstraints ?? []).map((p) => p.claim))
  const verdicts: ClaimVerdict[] = []
  let gatedDowngrades = 0

  for (const claim of input.claims) {
    const { net, firingCount, abstained } = claimNetwork(claim, input)
    const pSound = marginalProbability(net, soundAtom(claim))
    const quality = canUseMapSeverity(firingCount)
    const policyBlocked = policyClaims.has(claim)

    let provisionalSeverity: Severity
    if (policyBlocked) {
      provisionalSeverity = 'block'                       // §5: a hard POLICY constraint blocks regardless of P
    } else if (quality === 'fallback') {
      // §9 Rule SEV-3: below N≤10, do NOT issue a MAP-generalized severity — fall back to the deterministic
      // worst single detector (the original per-detector behavior). This is the anti-clustering-illusion gasket.
      provisionalSeverity = deterministicFallbackSeverity(claim, input, thresholds)
    } else {
      provisionalSeverity = classifySeverity(pSound, thresholds)   // full or limited: MAP-based, limited stamped
    }

    const counterTestGate = evaluateCounterTestGate(claim, provisionalSeverity, policyBlocked, input)
    const severity = counterTestGate.downgradedFrom ? GATE_DOWNGRADE_SEVERITY : provisionalSeverity
    if (counterTestGate.downgradedFrom) gatedDowngrades++

    verdicts.push({
      claim, pSound, severity, provisionalSeverity, counterTestGate,
      measurementQuality: quality, contributingFirings: firingCount, policyBlocked, abstainedFirings: abstained,
    })
  }

  // clear = no claim is blocked (the verdict is fail-closed: a single block fails the whole set, matching
  // scope-d's fail-closed posture). Uses the GATED severity: an uncertified block does not fail the set —
  // it is surfaced as info with downgradedFrom set, so the missing counter-test is visible rather than
  // laundered into an authoritative-looking block.
  const clear = !verdicts.some((v) => v.severity === 'block')
  return { clear, verdicts, gatedDowngrades }
}

// ─── the counter-test gate (epistemic-governance principle: counter_tests_required_for_warn_or_block) ──
//
// The ruleset states three principles together: detector_findings_are_hypotheses,
// repair_before_punishment, and counter_tests_required_for_warn_or_block. Read as one, a detector firing
// is a HYPOTHESIS until its required counter-test confirms it — so escalating a claim to warn or block on
// an un-counter-tested detection asserts a finding that was never earned.
//
// Before this gate existed, `reason()` issued warn and block purely off composed detector weights while
// the ruleset declared counter-tests mandatory for exactly those two severities, and no counter-test
// runner existed at all. The system gated without the gate.
//
// Downgrading is NOT fail-open. The ruleset's own `info` tier means "log or gently surface; no
// interruption by default" — precisely the right posture for an unverified hypothesis. The detection is
// still reported, with `downgradedFrom` naming the severity it could not justify, so the missing
// counter-test is visible in the verdict rather than silently absent.
//
// POLICY hard constraints are deliberately NOT gated: §5 grants them independent authority, and they are
// not detector hypotheses.

/** Severity an un-certified warn/block collapses to — the ruleset's "surface, do not interrupt" tier. */
const GATE_DOWNGRADE_SEVERITY: Severity = 'info'

/**
 * Canonical detector → required counter-test pairings, transcribed from
 * sociosphere/standards/epistemic-governance/detector-countertest-map.yaml (ruleset_semver 1.3.0).
 *
 * NOTE — known version divergence: that ruleset declares V2-era ids (LOGFALL.ADHOM.V2), while
 * lib/debate-detectors.ts implements V1 ids (LOGFALL.ADHOMINEM.V1) under RULESET_SEMVER '0.1.0'. The two
 * are different id namespaces, not versions of one list. This map is transcribed VERBATIM from the
 * ruleset and deliberately does NOT guess aliases between them: a detector with no entry here has an
 * UNDECLARED requirement, which cannot certify warn/block either (unknown ≠ satisfied). That makes the
 * divergence produce visible downgrades instead of hiding it — reconciling the two namespaces is the
 * follow-up this gate is designed to force.
 */
export const REQUIRED_COUNTER_TESTS: Record<string, readonly string[]> = {
  'LOGFALL.STRAWMAN.V2':    ['CTEST.STEELMAN.CONFIRM.V2'],
  'LOGFALL.ADHOM.V2':       ['CTEST.REFOCUS.PROPOSITION.V1'],
  'LOGFALL.EMOTION.V2':     ['CTEST.BASELINE.DATA.V1'],
  'LOGFALL.FALSECAUSE.V2':  ['CTEST.CAUSAL.DO/COUNTERFACTUAL.V1'],
  'LOGFALL.GISH.V1':        ['CTEST.ACYCLIC.PROOF.V1'],
  'LOGFALL.SHARPSHOOT.V2':  ['CTEST.PREREG/MTP.V2'],
  'LOGFALL.LOADED.V1':      ['CTEST.PRESUP.EXPOSE.V1'],
  'LOGFALL.BURDEN.V1':      ['CTEST.BURDEN.REASSIGN.V1'],
  'LOGFALL.EQUIV.V1':       ['CTEST.TERMS.LOCK.V1'],
  'LOGFALL.MOTTEBAILEY.V1': ['CTEST.CRITERIA.PRE-REGISTER.V1'],
  'COGBIAS.ANCHORING.V2':   ['CTEST.COUNTER-ANCHOR.V1'],
  'COGBIAS.CONFIRM.V1':     ['CTEST.DEVIL-S.LIST.V1'],
  'COGBIAS.OVERCONF.V1':    ['CTEST.CALIBRATION-20Q.V1'],
  'COGBIAS.REACTDEV.V1':    ['CTEST.ATTRIBUTION-BLIND.A/B.V1'],
}

/** Marker placed in `missing` for a detector with no declared counter-test requirement. */
export const undeclaredRequirement = (ruleId: string): string => `<undeclared:${ruleId}>`

/** Decide whether a provisional warn/block has earned the right to stand. */
function evaluateCounterTestGate(
  claim: string,
  provisional: Severity,
  policyBlocked: boolean,
  input: ReasonerInput,
): CounterTestGate {
  // §5 POLICY authority is not a detector hypothesis — ungated by design.
  if (policyBlocked) return { satisfied: true, required: [], missing: [] }
  if (provisional !== 'warn' && provisional !== 'block') return { satisfied: true, required: [], missing: [] }

  const map = input.requiredCounterTests ?? REQUIRED_COUNTER_TESTS
  const confirmed = new Set(
    (input.counterTests ?? [])
      .filter((t) => t.targetClaim === claim && t.outcome === 'confirmed')
      .map((t) => t.ctestId),
  )

  const required: string[] = []
  const missing: string[] = []
  const seenRules = new Set<string>()

  for (const f of input.detectorFirings) {
    if (f.targetClaim !== claim || seenRules.has(f.ruleId)) continue
    seenRules.add(f.ruleId)

    const needed = map[f.ruleId]
    if (needed === undefined) {
      // Requirement undeclared: we cannot certify what the ruleset never specified.
      missing.push(undeclaredRequirement(f.ruleId))
      continue
    }
    for (const ctestId of needed) {
      if (!required.includes(ctestId)) required.push(ctestId)
      if (!confirmed.has(ctestId) && !missing.includes(ctestId)) missing.push(ctestId)
    }
  }

  if (missing.length === 0) return { satisfied: true, required, missing }
  return { satisfied: false, required, missing, downgradedFrom: provisional }
}

/** §9 Rule SEV-3 fallback: with too few groundings to trust MAP composition, map the single strongest
 *  (highest-score) detection to a fixed severity band — the deterministic, per-detector original behavior. */
function deterministicFallbackSeverity(claim: string, input: ReasonerInput, thresholds: SeverityThresholds): Severity {
  const firings = input.detectorFirings.filter((f) => f.targetClaim === claim)
  if (firings.length === 0) return 'pass'
  const worst = Math.max(...firings.map((f) => f.score))
  // map a raw detector score to a severity band conservatively: high score = low soundness.
  const pSoundEquiv = 1 - worst
  return classifySeverity(pSoundEquiv, thresholds)
}

/** Convenience: the MAP world for a claim (which atoms are most-probably true) — exposed for the
 *  rationale/proof-trace the spec's Generation tier (§5) would surface. */
export function claimMapWorld(claim: string, input: ReasonerInput): { pSound: number; sound: boolean } {
  const { net } = claimNetwork(claim, input)
  const { world } = mapInference(net)
  return { pSound: marginalProbability(net, soundAtom(claim)), sound: world[soundAtom(claim)] === true }
}

// ─── §6: counter-tests as Reasoner/prover operations (routing table) ──────────────────────────────────
// The CTEST library is UNCHANGED (§6); this only declares which counter-tests are Reasoner queries vs.
// standalone classifiers, and whether they gate synchronously (Tier-A, block-critical) or async (Tier-B).
// A real system routes on this table; here it's the auditable, testable declaration of that routing.

export type CtestEngine = 'reasoner' | 'classifier'
export type CtestTier = 'A' | 'B'
export interface CtestRoute { engine: CtestEngine; operation: string; tier: CtestTier }

export const CTEST_ROUTING: Record<string, CtestRoute> = {
  'CTEST.CAUSAL.DO/COUNTERFACTUAL.V1': { engine: 'reasoner', operation: 'do-calculus MAP with edge intervened', tier: 'B' },
  'CTEST.PRESUP.EXPOSE.V1':            { engine: 'reasoner', operation: 'implicit-proposition extraction → surface hidden formula', tier: 'B' },
  'CTEST.TERMS.LOCK.V1':              { engine: 'reasoner', operation: 'SameRecord transitivity guard (identity-collapse block)', tier: 'A' },
  'CTEST.ACYCLIC.PROOF.V1':          { engine: 'reasoner', operation: 'proof-tree acyclicity (Gish-gallop = never composes)', tier: 'A' },
  'CTEST.CHAIN.PROB.V1':             { engine: 'reasoner', operation: 'marginal of multi-hop causal path (product of edge weights)', tier: 'B' },
  'CTEST.EVIDENCE-LR.V1':            { engine: 'reasoner', operation: 'likelihood ratio = exp(Δ weighted-log-prob)', tier: 'B' },
}

/** Where does a counter-test run? Table lookup, defaulting anything not listed to the standalone
 *  Counter-Test Runner classifier (§6 Rule CT-1: "remaining CTEST.* run as-is"). */
export function routeCtest(ctestId: string): CtestRoute {
  return CTEST_ROUTING[ctestId] ?? { engine: 'classifier', operation: 'standalone counter-test runner', tier: 'B' }
}

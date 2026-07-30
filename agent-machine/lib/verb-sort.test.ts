import { test } from 'node:test'
import assert from 'node:assert'
import { sortVerb, spanningCheck, adjointClosure, type Verb } from './verb-sort.js'

const TAU = 0.6

// The 10 seed fixtures from the brief (probe fields authored to lock the pipeline logic).
const FIXTURES: { v: Verb; expect: string }[] = [
  { v: { id: 'create', label: 'create', operandType: 'topic', decomposition: null, independence: 1, historyDependent: false }, expect: 'PRIMITIVE' },
  { v: { id: 'retrieve', label: 'retrieve', operandType: 'topic', decomposition: null, independence: 1, historyDependent: false }, expect: 'PRIMITIVE' },
  { v: { id: 'transform', label: 'transform', operandType: 'topic', decomposition: null, independence: 1, historyDependent: false }, expect: 'PRIMITIVE' },
  { v: { id: 'evaluate', label: 'evaluate', operandType: 'topic', decomposition: null, independence: 1, historyDependent: false }, expect: 'PRIMITIVE' },
  { v: { id: 'execute', label: 'execute', operandType: 'topic', decomposition: null, independence: 1, historyDependent: false }, expect: 'PRIMITIVE' },
  { v: { id: 'explain', label: 'explain', operandType: 'topic', decomposition: { mediator: 'identity', constituents: ['transform'], slotBinding: { output_form: 'communicative' } }, independence: 1, historyDependent: false }, expect: 'REDUCIBLE' },
  { v: { id: 'compare', label: 'compare', operandType: 'topic', decomposition: { mediator: 'combine', constituents: ['retrieve', 'retrieve', 'evaluate'] }, independence: 0.92, historyDependent: false }, expect: 'REDUCIBLE' },
  { v: { id: 'monitor', label: 'monitor', operandType: 'topic', decomposition: { mediator: 'entangle', constituents: ['retrieve', 'evaluate'] }, independence: 0.18, historyDependent: true }, expect: 'ENTANGLEMENT' },
  { v: { id: 'govern', label: 'govern', operandType: 'action', decomposition: null, independence: 1, historyDependent: false }, expect: 'META' },
  { v: { id: 'plan', label: 'plan', operandType: 'action', decomposition: { mediator: 'entangle', constituents: ['evaluate', 'execute'] }, independence: 0.3, historyDependent: true }, expect: 'META' },
]

test('CI-1: all 10 seed fixtures green', () => {
  const basis: string[] = []
  for (const { v, expect } of FIXTURES) {
    const vd = sortVerb(v, TAU)
    assert.equal(vd.verdict, expect, `${v.id}: got ${vd.verdict}, expected ${expect}`)
    if (vd.verdict === 'PRIMITIVE') basis.push(v.id)
  }
  assert.deepEqual(basis, ['create', 'retrieve', 'transform', 'evaluate', 'execute'])
  assert.equal(basis.length, 5)
})

test('CI-3: ORDER fires before FACTORIZATION (plan is META despite an entangling decomposition)', () => {
  const plan = FIXTURES.find((f) => f.v.id === 'plan')!.v
  const vd = sortVerb(plan, TAU)
  assert.equal(vd.verdict, 'META')
  assert.equal(vd.testFired, 'ORDER') // not FACTORIZATION, even though it would entangle
  assert.equal(vd.placement, 'embedding')
})

test('placements + bars: monitor entangles with PERSISTENCE; reducibles place nowhere', () => {
  const monitor = sortVerb(FIXTURES.find((f) => f.v.id === 'monitor')!.v, TAU)
  assert.equal(monitor.placement, 'embedding')
  assert.deepEqual(monitor.extraFidelityBar, ['PERSISTENCE'])
  assert.equal(sortVerb(FIXTURES.find((f) => f.v.id === 'explain')!.v, TAU).placement, 'none')
})

test('CI-4: spanning count is a pure function of basis length; never padded toward 10', () => {
  const r5 = spanningCheck(['create', 'retrieve', 'transform', 'evaluate', 'execute'], [], () => true)
  assert.equal(r5.count, 5)
  assert.equal(r5.tenHypothesis, 'REFUTED_LOW') // honest: 5, not forced to 10
  const r10 = spanningCheck(Array.from({ length: 10 }, (_, i) => `p${i}`), [], () => true)
  assert.equal(r10.tenHypothesis, 'CONFIRMED')
})

test('adjoint closure: the 5 close at 6 = 3×2 when sense is added — NOT 10', () => {
  const six = ['create', 'retrieve', 'transform', 'evaluate', 'execute', 'sense']
  const c = adjointClosure(six)
  assert.equal(c.count, 6)
  assert.equal(c.factorization, '3 substrates × 2 polarities')
  assert.equal(c.closed, true)                  // every (substrate × polarity) cell filled exactly once
  assert.equal(c.tenHypothesis, 'REFUTED_LOW')  // 6, with a factorization — not padded to 10
})

test('axis guards: evaluate ⊥ sense (polarity) AND substrate-complete (no 4th substrate)', () => {
  const c = adjointClosure(['create', 'retrieve', 'transform', 'evaluate', 'execute', 'sense'])
  // The two refutations 6 must survive: read-held ≠ read-world, and exactly 3 substrates.
  assert.equal(c.tests.evaluate_perp_sense, true)  // held ≠ world — the basis doesn't collapse to 5
  assert.equal(c.tests.substrate_complete, true)   // {store, held, world}, no social/4th → not 8
})

test('closure is minimal: the raw 5 (no sense) is NOT closed — execute dangles', () => {
  const c = adjointClosure(['create', 'retrieve', 'transform', 'evaluate', 'execute'])
  assert.equal(c.closed, false) // world:read cell empty → execute unpaired → not yet a clean basis
})

test('CI-5 seam-isolation: a verb with no decomposition is invariant to SEAM-A/B values', () => {
  const base: Verb = { id: 'x', label: 'x', operandType: 'topic', decomposition: null, independence: 1, historyDependent: false }
  const a = sortVerb(base, TAU)
  const b = sortVerb({ ...base, independence: 0.0, historyDependent: true }, TAU) // perturb the seams
  assert.equal(a.verdict, b.verdict) // PRIMITIVE either way — irreducible doesn't read the seams
})

// ── SEAM-A: the estimator, validated against known ground truth ─────────────────
// An estimator is only closed if it has been shown to give the RIGHT answer on data whose
// answer is known independently. These fixtures are constructed so ι is determined by
// construction, not by whatever the code happens to output.

import { independenceEstimate, historyDependenceEstimate, type Episode, type SeamBindings } from './verb-sort.js'

/** Deterministic LCG — a seeded generator, so a failure is reproducible rather than flaky. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000 }
}

const PARENT = 'compare'
const parentVerb = (over: Partial<Verb> = {}): Verb => ({
  id: PARENT, label: 'compare', operandType: 'topic',
  decomposition: { mediator: 'combine', constituents: ['retrieve', 'evaluate'] },
  independence: 0.5, historyDependent: false, ...over,
})

/** n episodes in which the parent fired; `pick` decides which constituents co-fired. */
function episodes(n: number, pick: (r: () => number) => string[], seed = 42): Episode[] {
  const r = lcg(seed)
  return Array.from({ length: n }, () => ({ fired: [PARENT, ...pick(r)] }))
}

test('SEAM-A: independent constituents measure as ι ≈ 1 (a product state)', () => {
  // Ground truth: two fair coins, no coupling. Mutual information is 0 in the limit, so
  // ι → 1. At n=400 the finite-sample bias is ~1/(2n ln2) bits, well inside the margin.
  const log = episodes(400, (r) => {
    const out: string[] = []
    if (r() < 0.5) out.push('retrieve')
    if (r() < 0.5) out.push('evaluate')
    return out
  })
  const e = independenceEstimate(parentVerb(), { log })
  assert.equal(e.source, 'measured')
  assert.equal(e.n, 400)
  assert.ok(e.value > 0.95, `independent constituents must read near 1, got ${e.value}`)
})

test('SEAM-A: perfectly coupled constituents measure as ι ≈ 0 (a bound state)', () => {
  // Ground truth: c2 fires iff c1 fires. Normalised MI is exactly 1, so ι is exactly 0.
  const log = episodes(400, (r) => (r() < 0.5 ? ['retrieve', 'evaluate'] : []))
  const e = independenceEstimate(parentVerb(), { log })
  assert.equal(e.source, 'measured')
  assert.ok(e.value < 0.02, `perfectly coupled constituents must read near 0, got ${e.value}`)
})

test('SEAM-A: ι is monotone in coupling strength — the estimator ORDERS, it does not just classify', () => {
  // A statistic that only separated the two extremes above could be a threshold in
  // disguise. Sweep the coupling and require the readings to decrease.
  const at = (noise: number): number => independenceEstimate(parentVerb(), {
    log: episodes(600, (r) => {
      const c1 = r() < 0.5
      const c2 = r() < noise ? !c1 : c1          // noise=0 ⇒ identical; noise=0.5 ⇒ independent
      return [...(c1 ? ['retrieve'] : []), ...(c2 ? ['evaluate'] : [])]
    }, 7),
  }).value
  const sweep = [0, 0.1, 0.2, 0.35, 0.5].map(at)
  for (let i = 1; i < sweep.length; i++) {
    assert.ok(sweep[i]! > sweep[i - 1]!,
      `ι must rise as coupling weakens: ${sweep.map((x) => x.toFixed(3)).join(' → ')}`)
  }
  assert.ok(sweep[0]! < 0.05 && sweep[4]! > 0.9, 'and span the range end to end')
})

test('SEAM-A: the parent stratum is what conditions the statistic', () => {
  // Episodes where the parent did NOT fire must not contribute. Here the constituents are
  // perfectly coupled inside the parent's stratum and perfectly ANTI-coupled outside it;
  // a statistic that pooled both would wash out to independence and read ι ≈ 1.
  const inside = episodes(200, (r) => (r() < 0.5 ? ['retrieve', 'evaluate'] : []))
  const outside: Episode[] = Array.from({ length: 400 }, (_, i) => ({
    fired: [i % 2 === 0 ? 'retrieve' : 'evaluate'],       // never together, and no parent
  }))
  const e = independenceEstimate(parentVerb(), { log: [...inside, ...outside] })
  assert.equal(e.n, 200, 'only the parent stratum counts')
  assert.ok(e.value < 0.02, 'and it reports the coupling that holds INSIDE that stratum')
})

test('SEAM-A: below the n>=30 floor it declines to measure rather than guessing', () => {
  const log = episodes(29, (r) => (r() < 0.5 ? ['retrieve', 'evaluate'] : []))
  const e = independenceEstimate(parentVerb({ independence: 0.77 }), { log })
  assert.equal(e.source, 'declared', 'a statistic on n<30 is not a statistic')
  assert.equal(e.value, 0.77, 'falls back to the declared field')
  assert.match(e.reason!, /n=29 < 30/)

  // One more observation crosses the floor and it measures.
  const e2 = independenceEstimate(parentVerb({ independence: 0.77 }), {
    log: episodes(30, (r) => (r() < 0.5 ? ['retrieve', 'evaluate'] : [])),
  })
  assert.equal(e2.source, 'measured')
  assert.notEqual(e2.value, 0.77)
})

test('SEAM-A: a degenerate stratum is unobservable, not independent', () => {
  // 'evaluate' fires in every episode. A constant carries no information, so the pair
  // cannot witness dependence either way — reporting ι=1 ("independent") would be a
  // false positive for separability, which promotes a bound state to REDUCIBLE.
  const log = episodes(100, (r) => (r() < 0.5 ? ['retrieve', 'evaluate'] : ['evaluate']))
  const e = independenceEstimate(parentVerb({ independence: 0.31 }), { log })
  assert.equal(e.source, 'declared')
  assert.equal(e.value, 0.31)
  assert.match(e.reason!, /degenerate/)
})

test('SEAM-A: no log, or an irreducible verb, is declared — and says which', () => {
  const noLog = independenceEstimate(parentVerb({ independence: 0.42 }))
  assert.equal(noLog.source, 'declared')
  assert.match(noLog.reason!, /no episode log/)

  const irreducible = independenceEstimate({ ...parentVerb(), decomposition: null, independence: 1 })
  assert.equal(irreducible.source, 'declared')
  assert.match(irreducible.reason!, /irreducible/)
})

test('SEAM-A: a single distinct constituent is vacuously independent — measured without a log', () => {
  // Structural, not statistical: there is no pair that could be dependent.
  const e = independenceEstimate(parentVerb({
    decomposition: { mediator: 'identity', constituents: ['transform'] }, independence: 0,
  }))
  assert.equal(e.source, 'measured', 'establishable from the decomposition alone')
  assert.equal(e.value, 1)
  assert.match(e.reason!, /vacuous/)
})

test('SEAM-B: unbound reads declared; a bound probe reads measured', () => {
  const v = parentVerb({ historyDependent: true })
  assert.deepEqual(historyDependenceEstimate(v), { value: true, source: 'declared', n: 0, reason: 'no ∂O/∂h probe bound' })
  const bound = historyDependenceEstimate(v, { historyProbe: () => false })
  assert.equal(bound.source, 'measured')
  assert.equal(bound.value, false, 'a real probe can and must be able to contradict the declaration')
})

// ── the enforcement: an unmeasured seam cannot yield a T1 verdict ────────────────

test('a FACTORIZATION verdict on unbound seams is T2/ZERO, not T1/POS', () => {
  // The defect this closes. Every such verdict used to be stamped T1 — "instrumented" —
  // while reading a number no instrument produced.
  const vd = sortVerb(parentVerb({ independence: 0.92 }), TAU)
  assert.equal(vd.testFired, 'FACTORIZATION')
  assert.equal(vd.verdict, 'REDUCIBLE', 'the verdict KIND is unchanged — only its tier')
  assert.equal(vd.tier, 'T2')
  assert.equal(vd.ternary, 'ZERO', 'unestablished, matching dispatch-ledger: T2 ⇒ ZERO')
  assert.equal(vd.witness['iotaSource'], 'declared')
  assert.match(String(vd.narrative), /seam declared, not measured/)
})

test('binding both seams with sufficient data earns T1/POS', () => {
  const seams: SeamBindings = {
    log: episodes(400, (r) => {
      const out: string[] = []
      if (r() < 0.5) out.push('retrieve')
      if (r() < 0.5) out.push('evaluate')
      return out
    }),
    historyProbe: () => false,
  }
  const vd = sortVerb(parentVerb(), TAU, seams)
  assert.equal(vd.tier, 'T1', 'both seams measured ⇒ instrumented')
  assert.equal(vd.ternary, 'POS')
  assert.equal(vd.witness['iotaSource'], 'measured')
  assert.equal(vd.witness['iotaN'], 400)
  assert.equal(vd.verdict, 'REDUCIBLE')

  // Half-bound is not bound: one declared seam is enough to keep it T2.
  assert.equal(sortVerb(parentVerb(), TAU, { log: seams.log }).tier, 'T2', 'SEAM-B still declared')
  assert.equal(sortVerb(parentVerb(), TAU, { historyProbe: () => false }).tier, 'T2', 'SEAM-A still declared')
})

test('a measured seam can OVERTURN a declared verdict — the point of measuring', () => {
  // Declared as separable (ι=0.92 ≥ τ). Measurement finds the constituents perfectly
  // coupled, so it is a bound state: ENTANGLEMENT, and it gains the PERSISTENCE bar.
  const v = parentVerb({ independence: 0.92, historyDependent: true })
  assert.equal(sortVerb(v, TAU).verdict, 'ENTANGLEMENT')      // declared route
  const measured = sortVerb(v, TAU, {
    log: episodes(400, (r) => (r() < 0.5 ? ['retrieve', 'evaluate'] : [])),
    historyProbe: () => true,
  })
  assert.equal(measured.tier, 'T1')
  assert.ok((measured.witness['iota'] as number) < 0.02, 'measured ι contradicts the declared 0.92')
  assert.equal(measured.verdict, 'ENTANGLEMENT')
  assert.deepEqual(measured.extraFidelityBar, ['PERSISTENCE'])
})

test('CI-5 holds and is now visible: ORDER and MINIMALITY verdicts are seam-invariant in tier too', () => {
  const seams: SeamBindings = { log: episodes(50, () => ['retrieve', 'evaluate']), historyProbe: () => true }

  // ORDER: operand type is a structural fact, directly inspectable.
  const meta: Verb = { id: 'plan', label: 'plan', operandType: 'action', decomposition: null, independence: 0, historyDependent: true }
  for (const vd of [sortVerb(meta, TAU), sortVerb(meta, TAU, seams)]) {
    assert.equal(vd.testFired, 'ORDER'); assert.equal(vd.tier, 'T1'); assert.equal(vd.ternary, 'POS')
  }

  // MINIMALITY: slot-collapse is likewise structural.
  const collapses: Verb = {
    id: 'explain', label: 'explain', operandType: 'topic',
    decomposition: { mediator: 'identity', constituents: ['transform'], slotBinding: { output_form: 'communicative' } },
    independence: 1, historyDependent: false,
  }
  for (const vd of [sortVerb(collapses, TAU), sortVerb(collapses, TAU, seams)]) {
    assert.equal(vd.testFired, 'MINIMALITY'); assert.equal(vd.tier, 'T1')
  }

  // And a PRIMITIVE (irreducible, no decomposition) never reads a seam at all.
  const prim: Verb = { id: 'create', label: 'create', operandType: 'topic', decomposition: null, independence: 1, historyDependent: false }
  assert.equal(sortVerb(prim, TAU).tier, sortVerb(prim, TAU, seams).tier)
})

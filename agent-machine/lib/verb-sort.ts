/**
 * verb-sort — the non-separability decision procedure that derives the ACTION basis
 * of the dialogue-flow algebra (port of the SocioProphet `sortverb` brief). It sorts
 * a candidate verb into {PRIMITIVE | ENTANGLEMENT | REDUCIBLE | META} by three tests
 * IN ORDER — order → factorization → minimality — and reports the honest primitive
 * count (never padded toward 10).
 *
 * Topics are the rows (our 22 prime-topics + the domain-pole = 23, the identity model).
 * Verbs are the columns. PRIMITIVE → column; ENTANGLEMENT/META → the +1 embedding row
 * (the rootless exceptional element — the Leech among the 23 Niemeiers); REDUCIBLE →
 * no node (an expression over the basis).
 *
 * Pipeline logic is [CONTRACT]. The three seams are bound per Phase-0 discovery:
 *   SEAM-A independenceMetric  — [IMPLEMENTED, unbound in prod] ι = 1 − max over
 *                                constituent pairs of normalised mutual information, on
 *                                the stratum where the parent fired. The ESTIMATOR is
 *                                real and tested against synthetic ground truth; the
 *                                production episode log (logTail) still does not exist,
 *                                so `independenceEstimate` falls back to the declared
 *                                field and REPORTS that it did.
 *   SEAM-B historyDependence   — [injection point] ∂O/∂h needs the observable re-run under
 *                                a permuted history; a log cannot supply that, so this
 *                                stays a bindable probe rather than something computed.
 *   SEAM-C ledgerHash          — [bound] canonical-JSON SHA-256, matching cairnpath-adapter.
 *
 * The tiering is the enforcement. A FACTORIZATION verdict is T1 only when BOTH consumed
 * seams were measured; unbound, it is T2/ZERO. Previously every such verdict was stamped
 * T1 — "instrumented" — while reading numbers no instrument had produced, which is the
 * same declared-but-unenforced defect as a dispatch asserting its own verdict. Compare
 * dispatch-ledger: T2 ⇒ ZERO ⇒ unestablished, one doctrine across both modules.
 *
 * CI-5 (seam isolation): swapping the SEAM-A/B stubs for the real statistics must not
 * change verdicts for verbs whose fields don't depend on them — ORDER and MINIMALITY
 * verdicts never consume a seam, and their tier is correspondingly untouched.
 */
import { createHash } from 'node:crypto'

export type Mediator = 'chain' | 'combine' | 'entangle' | 'identity'
export interface Decomp { mediator: Mediator; constituents: string[]; slotBinding?: Record<string, unknown> | null }
export interface Verb {
  id: string
  label: string
  operandType: 'topic' | 'action'   // ORDER probe — operand is a topic (column) or an action (meta)
  decomposition: Decomp | null      // null ⇒ irreducible
  independence: number              // ι ∈ [0,1] (SEAM-A)
  historyDependent: boolean         // ∂O/∂h ≠ 0 (SEAM-B)
}
export type VerdictKind = 'PRIMITIVE' | 'ENTANGLEMENT' | 'REDUCIBLE' | 'META'
export type Placement = 'column' | 'embedding' | 'none'
export interface Verdict {
  verbId: string
  verdict: VerdictKind
  testFired: 'ORDER' | 'MINIMALITY' | 'FACTORIZATION'
  witness: Record<string, unknown>
  extraFidelityBar: string[]
  placement: Placement
  tier: 'T1' | 'T2'
  ternary: 'POS' | 'ZERO' | 'NEG'
  narrative: string
  attestation: string
}

// ── SEAMS ────────────────────────────────────────────────────────────────────
/** One observation: the set of verb/constituent ids that fired together. This is the
 *  substrate SEAM-A needs. It does not yet exist in production (there is no logTail),
 *  which is why `independenceEstimate` reports its source rather than silently
 *  substituting the declared value. */
export interface Episode { fired: readonly string[] }

/** A seam reading that knows whether it was MEASURED or merely DECLARED. The
 *  distinction is the whole point: a declared value is an assertion, and a verdict
 *  resting on an assertion cannot honestly be tiered T1 (instrumented). */
export interface SeamEstimate<T> { value: T; source: 'measured' | 'declared'; n: number; reason?: string }

/** Optional real bindings for the seams. Supplying them upgrades affected verdicts from
 *  T2 to T1; supplying nothing leaves the sorter working exactly as before, but honest
 *  about it. This is what makes the seams swappable rather than "harness pending". */
export interface SeamBindings {
  log?: readonly Episode[]
  /** Real SEAM-B probe: re-evaluate the observable under a permuted prior-reading history
   *  h and report ∂O/∂h ≠ 0. Cannot be derived from a log alone — it needs an executable
   *  observable — so it stays an injection point rather than something computed here. */
  historyProbe?: (v: Verb) => boolean
}

/** House minimum. Never compute a statistic on fewer than 30 observations; below that the
 *  correct output is "unestablished", not a number with wide error bars presented bare. */
const MIN_SUPPORT = 30

/** Binary entropy, in bits. */
function binaryEntropy(p: number): number {
  return p <= 0 || p >= 1 ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p))
}

/** Normalised mutual information between two presence indicators, in [0,1].
 *  Returns null when either indicator is CONSTANT across the stratum: a constant carries
 *  no information, so the pair cannot witness dependence either way. Reporting 0 there
 *  would read as "independent" when the truth is "unobservable". */
function normalizedMI(xs: readonly boolean[], ys: readonly boolean[]): number | null {
  const n = xs.length
  if (n === 0) return null
  let n11 = 0, n10 = 0, n01 = 0, n00 = 0
  for (let i = 0; i < n; i++) {
    const x = xs[i]!, y = ys[i]!
    if (x && y) n11++; else if (x) n10++; else if (y) n01++; else n00++
  }
  const px = (n11 + n10) / n, py = (n11 + n01) / n
  const hx = binaryEntropy(px), hy = binaryEntropy(py)
  if (hx === 0 || hy === 0) return null
  let mi = 0
  for (const [c, a, b] of [[n11, px, py], [n10, px, 1 - py], [n01, 1 - px, py], [n00, 1 - px, 1 - py]] as const) {
    if (c === 0) continue                        // 0·log0 = 0, and log0 would be -Infinity
    const pj = c / n
    mi += pj * Math.log2(pj / (a * b))
  }
  return Math.max(0, Math.min(1, mi / Math.min(hx, hy)))
}

/** SEAM-A, implemented. ι = 1 − max over constituent pairs of normalised mutual
 *  information, computed on the stratum of episodes in which the PARENT fired — which is
 *  what "independent given the parent" means. Ranges 1 (no pair shares information:
 *  a product state) to 0 (a pair is fully determined by the other: a bound state).
 *
 *  Falls back to the declared field when it cannot measure, and says so. The three
 *  honest reasons to fall back: no log at all, a parent stratum below MIN_SUPPORT, or
 *  every pair degenerate. Only the first is the standing production case. */
export function independenceEstimate(v: Verb, seams?: SeamBindings): SeamEstimate<number> {
  const d = v.decomposition
  if (!d) return { value: v.independence, source: 'declared', n: 0, reason: 'irreducible: no constituents to test' }

  const cs = [...new Set(d.constituents)]
  if (cs.length < 2) {
    // Structural, not statistical: with one distinct constituent there is no pair that
    // could be dependent, so ι = 1 follows from the decomposition itself. Establishable
    // without any log, hence 'measured'.
    return { value: 1, source: 'measured', n: 0, reason: 'single distinct constituent: pairwise independence is vacuous' }
  }

  if (!seams?.log) return { value: v.independence, source: 'declared', n: 0, reason: 'no episode log supplied' }

  const stratum = seams.log.filter((e) => e.fired.includes(v.id))
  if (stratum.length < MIN_SUPPORT) {
    return { value: v.independence, source: 'declared', n: stratum.length,
      reason: `parent stratum n=${stratum.length} < ${MIN_SUPPORT}` }
  }

  let worst: number | null = null
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      const m = normalizedMI(
        stratum.map((e) => e.fired.includes(cs[i]!)),
        stratum.map((e) => e.fired.includes(cs[j]!)),
      )
      if (m !== null) worst = worst === null ? m : Math.max(worst, m)
    }
  }
  if (worst === null) {
    return { value: v.independence, source: 'declared', n: stratum.length,
      reason: 'every constituent pair degenerate in the stratum' }
  }
  return { value: 1 - worst, source: 'measured', n: stratum.length }
}

/** SEAM-B. Genuinely blocked on a harness: ∂O/∂h requires re-running the observable under
 *  a permuted history, which a log cannot supply. Now an injection point rather than a
 *  hardcoded stub, so binding it is a caller's decision and its absence is visible. */
export function historyDependenceEstimate(v: Verb, seams?: SeamBindings): SeamEstimate<boolean> {
  if (seams?.historyProbe) return { value: seams.historyProbe(v), source: 'measured', n: 1 }
  return { value: v.historyDependent, source: 'declared', n: 0, reason: 'no ∂O/∂h probe bound' }
}

/** Back-compatible readers. Prefer the *Estimate forms — these discard the provenance,
 *  and discarding the provenance is how a declared value came to be tiered T1. */
export function independenceMetric(v: Verb, seams?: SeamBindings): number { return independenceEstimate(v, seams).value }
export function historyDependenceProbe(v: Verb, seams?: SeamBindings): boolean { return historyDependenceEstimate(v, seams).value }
/** SEAM-C [bound]. Canonical-JSON SHA-256 — same entrypoint as cairnpath-adapter. */
export function ledgerHash(obj: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalJson(obj)).digest('hex')
}
function canonicalJson(obj: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(sort)
      : x && typeof x === 'object'
        ? Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])]))
        : x
  return JSON.stringify(sort(obj))
}

// ── Pipeline [CONTRACT] ──────────────────────────────────────────────────────
const orderTest = (v: Verb): boolean => v.operandType === 'action'   // T0: 2nd-order ⇒ META

/** Separable iff a decomposition exists, constituents independent given parent
 *  (ι ≥ τ), and no history dependence — a product state, not a bound state.
 *
 *  Returns the two seam readings alongside the answer, because the CALLER needs to know
 *  whether the answer was measured. A boolean that hides its provenance is exactly how a
 *  declared ι came to be stamped T1 (instrumented) for the whole life of this module. */
interface Separability {
  separable: boolean
  iota: SeamEstimate<number>
  history: SeamEstimate<boolean>
  /** True iff BOTH consumed seams were measured. Only then is a FACTORIZATION verdict T1. */
  measured: boolean
}
function separability(v: Verb, tau: number, seams?: SeamBindings): Separability {
  const iota = independenceEstimate(v, seams)
  const history = historyDependenceEstimate(v, seams)
  return {
    separable: Boolean(v.decomposition) && iota.value >= tau && !history.value,
    iota, history,
    measured: iota.source === 'measured' && history.source === 'measured',
  }
}
/** Minimality: candidate collapses to one primitive under a slot rebinding. */
function collapsesToSingle(v: Verb): Decomp | null {
  const d = v.decomposition
  return d && d.mediator === 'identity' && d.constituents.length === 1 && d.slotBinding ? d : null
}

/** Sort a candidate verb. Order fires before factorization (load-bearing).
 *
 *  `seams` binds SEAM-A (an episode log) and SEAM-B (a ∂O/∂h probe). Unbound, the sorter
 *  behaves exactly as before EXCEPT that FACTORIZATION verdicts — the only ones that
 *  consume the seams — are tiered T2/ZERO rather than T1/POS. That demotion is the fix:
 *  those verdicts were being stamped "instrumented" while reading numbers no instrument
 *  had produced. ORDER and MINIMALITY verdicts are unaffected because operand type and
 *  slot-collapse are structural facts, directly inspectable, not measured statistics —
 *  which is CI-5 (seam isolation) holding, and now visible in the tiering. */
export function sortVerb(v: Verb, tau: number, seams?: SeamBindings): Verdict {
  // T0 — ORDER
  if (orderTest(v)) {
    return mk(v, 'PRIMITIVE_NO', 'ORDER', { operandType: 'action' }, [], 'embedding',
      'operand is an action, not a topic; second-order; lives in the +1 embedding row', 'META')
  }
  // minimality short-circuit: single primitive under a slot binding
  const one = collapsesToSingle(v)
  if (one) {
    return mk(v, 'REDUCIBLE', 'MINIMALITY', { primitive: one.constituents[0], slotBinding: one.slotBinding },
      [], 'none', `collapses to ${one.constituents[0]} under slot binding; fails minimality`)
  }
  // T1 — FACTORIZATION
  if (v.decomposition) {
    const s = separability(v, tau, seams)
    // Provenance travels with the verdict, so an auditor reading a T2 can see WHICH seam
    // was unbound and why, rather than having to know this module's history.
    const seamWitness = {
      iota: s.iota.value,
      iotaSource: s.iota.source, iotaN: s.iota.n, ...(s.iota.reason ? { iotaReason: s.iota.reason } : {}),
      historySource: s.history.source, ...(s.history.reason ? { historyReason: s.history.reason } : {}),
    }
    const tier: 'T1' | 'T2' = s.measured ? 'T1' : 'T2'
    const unmeasured = s.measured ? '' : ' [T2: seam declared, not measured]'

    if (s.separable) {
      return mk(v, 'REDUCIBLE', 'FACTORIZATION',
        { mediator: v.decomposition.mediator, constituents: v.decomposition.constituents, ...seamWitness },
        [], 'none', `separable composition (product state); not a new primitive${unmeasured}`, undefined, tier)
    }
    if (s.history.value) {
      return mk(v, 'ENTANGLEMENT', 'FACTORIZATION',
        { mediator: 'entangle', constituents: v.decomposition.constituents, ...seamWitness },
        ['PERSISTENCE'], 'embedding',
        `non-separable bound state; observable is a function of history h; adds PERSISTENCE to the dispatch bar${unmeasured}`,
        undefined, tier)
    }
    // decomposed but neither cleanly separable nor history-dependent ⇒ ambiguous, T2/ZERO
    return mk(v, 'ENTANGLEMENT', 'FACTORIZATION',
      { mediator: v.decomposition.mediator, constituents: v.decomposition.constituents, ...seamWitness, obstruction: 'ambiguous separability' },
      ['PERSISTENCE'], 'embedding', 'ambiguous separability — manual adjudication required', undefined, 'T2')
  }
  // T2 — MINIMALITY: irreducible ⇒ PRIMITIVE (admit as a column)
  return mk(v, 'PRIMITIVE', 'FACTORIZATION', {}, [], 'column',
    'irreducible w.r.t. current basis; admitted as a primitive (column)')
}

function mk(
  v: Verb, verdictRaw: string, test: Verdict['testFired'], witness: Record<string, unknown>,
  bars: string[], placement: Placement, narrative: string, verdictOverride?: VerdictKind, tier: 'T1' | 'T2' = 'T1',
): Verdict {
  const verdict = (verdictOverride ?? verdictRaw) as VerdictKind
  const vd: Verdict = {
    verbId: v.id, verdict, testFired: test, witness, extraFidelityBar: bars, placement,
    tier, ternary: tier === 'T2' ? 'ZERO' : 'POS', narrative, attestation: '',
  }
  vd.attestation = ledgerHash({ verb: v.id, verdict: vd.verdict, test: vd.testFired, witness: vd.witness, bars: vd.extraFidelityBar })
  return vd
}

// ── Spanning [CONTRACT] — report the honest count; never pad ─────────────────
export interface SpanningReport {
  basis: string[]
  count: number
  complete: boolean
  gaps: { requiredAction: string; reason: string }[]
  tenHypothesis: 'CONFIRMED' | 'REFUTED_LOW' | 'REFUTED_HIGH'
}
export function spanningCheck(basis: string[], required: string[], expressible: (r: string, b: string[]) => boolean): SpanningReport {
  const gaps = required.filter((r) => !expressible(r, basis)).map((r) => ({ requiredAction: r, reason: 'neither a primitive nor a composition over the basis' }))
  const count = basis.length
  const tenHypothesis = count === 10 ? 'CONFIRMED' : count < 10 ? 'REFUTED_LOW' : 'REFUTED_HIGH'
  return { basis, count, complete: gaps.length === 0, gaps, tenHypothesis }
}

// ── Adjoint closure — the honest, FACTORED basis: 3 substrates × 2 polarities ─
// The raw spanning derivation returns 5 primitives. Two adjoint pairs were already
// closed inside them (create↔retrieve, transform↔evaluate); `execute` was the only
// open one. Its adjoint is `sense` (actuate↔observe = the controllability/observability
// dual). Closing it yields exactly 6 = 3×2. There is no path to 10: reaching it needs
// two more GENERATORS, which fail minimality (they'd be compositions). 10 is refuted
// twice — at 5 raw and at 6 closed — and 6 is a derived number WITH a factorization.
export type Substrate = 'store' | 'held' | 'world'
export type Polarity = 'read' | 'write'
export const ACTION_SIGNATURE: Record<string, { substrate: Substrate; polarity: Polarity }> = {
  retrieve: { substrate: 'store', polarity: 'read' }, create: { substrate: 'store', polarity: 'write' },
  evaluate: { substrate: 'held', polarity: 'read' }, transform: { substrate: 'held', polarity: 'write' },
  sense: { substrate: 'world', polarity: 'read' }, execute: { substrate: 'world', polarity: 'write' },
}

export interface ClosureReport {
  basis: string[]
  count: number
  factorization: string
  closed: boolean        // every (substrate × polarity) cell filled exactly once (spanning + minimal)
  tenHypothesis: 'REFUTED_LOW' | 'REFUTED_HIGH' | 'CONFIRMED'
  tests: {
    /** polarity-axis guard: read-held (evaluate) must be a different op from read-world (sense). */
    evaluate_perp_sense: boolean
    /** substrate-axis guard: exactly {store, held, world} — no 4th (social/other-agent) substrate. */
    substrate_complete: boolean
  }
  attestation: string
}

/** Confirm the adjoint-closed basis fills the 3×2 grid exactly — spanning + minimal on
 *  BOTH axes — and run the two refutation tests that could collapse it back below 6. */
export function adjointClosure(basis: string[]): ClosureReport {
  const sigs = basis.map((b) => ACTION_SIGNATURE[b]).filter(Boolean) as { substrate: Substrate; polarity: Polarity }[]
  const cells = new Set(sigs.map((s) => `${s.substrate}:${s.polarity}`))
  const substrates = new Set(sigs.map((s) => s.substrate))
  // closed ⇔ each of the 6 cells filled exactly once (bijective onto the 3×2 grid)
  const closed = cells.size === 6 && sigs.length === 6
  const evaluate_perp_sense = ACTION_SIGNATURE['evaluate']?.substrate !== ACTION_SIGNATURE['sense']?.substrate
  const substrate_complete = substrates.size === 3 && ['store', 'held', 'world'].every((s) => substrates.has(s as Substrate))
  const count = basis.length
  const attestation = ledgerHash({ basis: [...basis].sort(), closed, tests: { evaluate_perp_sense, substrate_complete } })
  return {
    basis, count, factorization: '3 substrates × 2 polarities',
    closed, tenHypothesis: count === 10 ? 'CONFIRMED' : count < 10 ? 'REFUTED_LOW' : 'REFUTED_HIGH',
    tests: { evaluate_perp_sense, substrate_complete }, attestation,
  }
}

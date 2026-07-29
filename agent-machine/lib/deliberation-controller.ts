/**
 * deliberation-controller — knowing when more thinking stops paying.
 *
 * The planning-value panel wanted a curve where feedback crosses emergent return. The
 * mechanism is narrower and testable: estimate P(correct | signals the harness ALREADY
 * emits), then spend more tokens only where that estimate says the extra spend buys
 * accuracy. It generalises escalate-only-on-disagreement, which is the same idea with a
 * single hand-picked signal and a hard threshold.
 *
 * Deliberately unglamorous by construction:
 *   - Logistic regression, fit by gradient descent, no dependencies. The estate does not
 *     take an ML runtime for a model with five features and a few hundred rows.
 *   - Calibrated on transcripts we ALREADY OWN — labelled board runs on disk. Building this
 *     costs no tokens; only proving the cost-per-point win on a fresh board does.
 *   - Interpretable: weights are inspectable, and reliability() reports predicted-vs-actual
 *     per bin, so an overconfident controller is visible rather than silently trusted.
 *
 * An L-function functional form for the value curve stays a research gate behind this
 * baseline's numbers, per the Metaphor→Mechanism program.
 */

/** The signals a harness row can carry. All optional — a run may not emit every one. */
export interface DeliberationSignals {
  /** Agreement across self-consistency samples (0..1) — the strongest single predictor. */
  vote_share?: number
  /** Confidence reported by the agreement gate (0..1). */
  gate_conf?: number
  /** Whether the gate's sources agreed (0/1 or boolean). */
  gate_agree?: number | boolean
  /** Gate reliability estimate (0..1). */
  gate_reliability?: number
  /** Retrieval/brain confidence (0..1). */
  brain_conf?: number
  /** Whether the question looked typical for the corpus (0/1 or boolean). */
  gate_typical?: number | boolean
}

export const FEATURES = [
  'vote_share', 'gate_conf', 'gate_agree', 'gate_reliability', 'brain_conf', 'gate_typical',
] as const
export type FeatureName = (typeof FEATURES)[number]

const num = (v: unknown): number | null => {
  if (typeof v === 'boolean') return v ? 1 : 0
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Feature vector + a mask of which features were actually present (never silently zero-filled). */
export function vectorize(s: DeliberationSignals): { x: number[]; present: boolean[] } {
  const x: number[] = []
  const present: boolean[] = []
  for (const f of FEATURES) {
    const v = num((s as Record<string, unknown>)[f])
    present.push(v !== null)
    x.push(v ?? 0)
  }
  return { x, present }
}

export interface TrainingRow { signals: DeliberationSignals; correct: boolean }

export interface Model {
  weights: number[]
  bias: number
  /** Per-feature standardization, so gradient descent is stable and weights are comparable. */
  mean: number[]
  std: number[]
  /** Features that appeared in <25% of rows are zeroed out — too sparse to trust. */
  usable: boolean[]
  n: number
  /** Base rate of `correct` in the training set — the fallback when no features are usable. */
  baseRate: number
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))))

/**
 * Fit P(correct | signals). L2-regularised logistic regression by batch gradient descent.
 * Standardises inputs and drops features that are too sparse to learn from — with a few
 * hundred rows, an unusable feature is worse than a missing one.
 */
export function fit(rows: TrainingRow[], opts: { epochs?: number; lr?: number; l2?: number } = {}): Model {
  const epochs = opts.epochs ?? 400
  const lr = opts.lr ?? 0.1
  const l2 = opts.l2 ?? 0.01
  const d = FEATURES.length
  const n = rows.length
  const baseRate = n ? rows.filter((r) => r.correct).length / n : 0.5

  if (n === 0) {
    return { weights: new Array(d).fill(0), bias: 0, mean: new Array(d).fill(0), std: new Array(d).fill(1), usable: new Array(d).fill(false), n: 0, baseRate }
  }

  const vecs = rows.map((r) => vectorize(r.signals))
  const coverage = new Array(d).fill(0)
  for (const v of vecs) v.present.forEach((p, i) => { if (p) coverage[i]++ })
  const usable = coverage.map((c) => c / n >= 0.25)

  // standardize over PRESENT values only, so absent features don't drag the mean
  const mean = new Array(d).fill(0)
  const std = new Array(d).fill(1)
  for (let i = 0; i < d; i++) {
    if (!usable[i]) continue
    const vals = vecs.filter((v) => v.present[i]).map((v) => v.x[i]!)
    const m = vals.reduce((a, b) => a + b, 0) / vals.length
    const variance = vals.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, vals.length)
    mean[i] = m
    std[i] = Math.sqrt(variance) || 1
  }

  const X = vecs.map((v) => v.x.map((val, i) => (usable[i] && v.present[i] ? (val - mean[i]!) / std[i]! : 0)))
  const y = rows.map((r) => (r.correct ? 1 : 0))

  const weights = new Array(d).fill(0)
  let bias = Math.log(Math.max(1e-6, baseRate) / Math.max(1e-6, 1 - baseRate)) // start at the base rate

  for (let e = 0; e < epochs; e++) {
    const gw = new Array(d).fill(0)
    let gb = 0
    for (let r = 0; r < n; r++) {
      const p = sigmoid(X[r]!.reduce((acc, xv, i) => acc + xv * weights[i]!, bias))
      const err = p - y[r]!
      for (let i = 0; i < d; i++) if (usable[i]) gw[i] += err * X[r]![i]!
      gb += err
    }
    for (let i = 0; i < d; i++) if (usable[i]) weights[i] -= lr * (gw[i]! / n + l2 * weights[i]!)
    bias -= lr * (gb / n)
  }

  return { weights, bias, mean, std, usable, n, baseRate }
}

/** P(correct) for one row. Falls back to the training base rate when nothing usable is present. */
export function predict(model: Model, signals: DeliberationSignals): number {
  const { x, present } = vectorize(signals)
  let anyUsable = false
  let z = model.bias
  for (let i = 0; i < FEATURES.length; i++) {
    if (!model.usable[i] || !present[i]) continue
    anyUsable = true
    z += ((x[i]! - model.mean[i]!) / model.std[i]!) * model.weights[i]!
  }
  return anyUsable ? sigmoid(z) : model.baseRate
}

export type Action = 'stop' | 'continue' | 'escalate'

export interface Policy {
  /** Above this P(correct), stop — more deliberation is unlikely to change the answer. */
  stopAbove: number
  /** Below this, escalate — the cheap path is probably wrong, so spend. */
  escalateBelow: number
}

/**
 * A neutral starting point ONLY. Absolute thresholds are a trap: a well-fit model on a hard
 * corpus may never emit p > 0.8, in which case `stopAbove: 0.9` fires never and everything
 * escalates. Calibration on the owned transcripts showed exactly that — 0 stops, 83%
 * escalation, 4.3× spend. Use `suggestPolicy` to derive thresholds from the model's ACTUAL
 * distribution before deploying one.
 */
export const DEFAULT_POLICY: Policy = { stopAbove: 0.9, escalateBelow: 0.6 }

export function decide(p: number, policy: Policy = DEFAULT_POLICY): Action {
  if (p >= policy.stopAbove) return 'stop'
  if (p <= policy.escalateBelow) return 'escalate'
  return 'continue'
}

const quantile = (sorted: number[], q: number): number => {
  if (!sorted.length) return NaN
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
  return sorted[i]!
}

/**
 * Derive a policy from what the model actually predicts, under a spend budget.
 *
 * `escalateBelow` is set so that ~`targetEscalationRate` of rows fall beneath it — the
 * operator chooses how much extra spend to authorise, and the data decides where that lands.
 * `stopAbove` is set at the top decile of predictions, so "stop" means "confident RELATIVE to
 * this corpus" rather than relative to an arbitrary constant. Thresholds are clamped apart so
 * a degenerate distribution can't invert them.
 */
export function suggestPolicy(
  model: Model, rows: TrainingRow[], opts: { targetEscalationRate?: number; stopQuantile?: number } = {},
): Policy {
  const target = opts.targetEscalationRate ?? 0.25
  const stopQ = opts.stopQuantile ?? 0.9
  const ps = rows.map((r) => predict(model, r.signals)).sort((a, b) => a - b)
  if (!ps.length) return DEFAULT_POLICY
  const escalateBelow = quantile(ps, target)
  const stopAbove = Math.max(quantile(ps, stopQ), escalateBelow + 1e-6)
  return { stopAbove, escalateBelow }
}

// ── honesty instruments ─────────────────────────────────────────────────────────

export interface ReliabilityBin { lo: number; hi: number; n: number; predicted: number; actual: number }

/**
 * Calibration curve: within each probability bin, what the model predicted vs what actually
 * happened. A controller that says 0.9 and is right 0.6 of the time must be VISIBLE, not
 * quietly trusted — this is the instrument that makes that impossible to miss.
 */
export function reliability(model: Model, rows: TrainingRow[], bins = 5): ReliabilityBin[] {
  const out: ReliabilityBin[] = []
  for (let b = 0; b < bins; b++) {
    const lo = b / bins
    const hi = (b + 1) / bins
    const inBin = rows.filter((r) => {
      const p = predict(model, r.signals)
      return p >= lo && (b === bins - 1 ? p <= hi : p < hi)
    })
    if (!inBin.length) { out.push({ lo, hi, n: 0, predicted: NaN, actual: NaN }); continue }
    const predicted = inBin.reduce((a, r) => a + predict(model, r.signals), 0) / inBin.length
    const actual = inBin.filter((r) => r.correct).length / inBin.length
    out.push({ lo, hi, n: inBin.length, predicted, actual })
  }
  return out
}

/** Mean |predicted − actual| weighted by bin population. Lower is better; 0 is perfect. */
export function expectedCalibrationError(bins: ReliabilityBin[]): number {
  const total = bins.reduce((a, b) => a + b.n, 0)
  if (!total) return NaN
  return bins.reduce((a, b) => (b.n ? a + (b.n / total) * Math.abs(b.predicted - b.actual) : a), 0)
}

export interface CostModel {
  /** Relative token cost of the cheap path (baseline single pass). */
  baseCost: number
  /** Extra relative cost when the controller escalates. */
  escalateCost: number
}

export const DEFAULT_COST: CostModel = { baseCost: 1, escalateCost: 4 }

export interface PolicyEvaluation {
  n: number
  /** Share of rows the controller would escalate. */
  escalationRate: number
  /** Accuracy if we always took the cheap path. */
  baselineAccuracy: number
  /**
   * Accuracy assuming escalation fixes a wrong answer with probability `escalateRecovery`.
   * Stated as an assumption rather than a measurement — the true value needs a board run.
   */
  projectedAccuracy: number
  /** Relative spend vs always-cheap (1.0 = same). */
  relativeCost: number
  /** Accuracy points bought per unit of extra spend. THE number this lane exists to move. */
  costPerPoint: number
}

/**
 * Offline evaluation of a policy against labelled rows. `escalateRecovery` is an explicit
 * assumption (default 0.5): escalation is modelled as fixing half the errors it is spent on.
 * The honest read of the output is "cost-per-point UNDER this assumption" — replacing the
 * assumption with a measurement is exactly what the live board run is for.
 */
export function evaluatePolicy(
  model: Model, rows: TrainingRow[],
  policy: Policy = DEFAULT_POLICY, cost: CostModel = DEFAULT_COST,
  escalateRecovery = 0.5,
): PolicyEvaluation {
  const n = rows.length
  if (!n) return { n: 0, escalationRate: 0, baselineAccuracy: NaN, projectedAccuracy: NaN, relativeCost: 1, costPerPoint: NaN }

  let escalated = 0
  let correctBase = 0
  let projected = 0
  for (const r of rows) {
    const p = predict(model, r.signals)
    const action = decide(p, policy)
    const isEsc = action === 'escalate'
    if (isEsc) escalated++
    if (r.correct) correctBase++
    projected += r.correct ? 1 : isEsc ? escalateRecovery : 0
  }

  const baselineAccuracy = correctBase / n
  const projectedAccuracy = projected / n
  const escalationRate = escalated / n
  const relativeCost = (n * cost.baseCost + escalated * cost.escalateCost) / (n * cost.baseCost)
  const gainPoints = (projectedAccuracy - baselineAccuracy) * 100
  const extraCost = relativeCost - 1
  return {
    n, escalationRate, baselineAccuracy, projectedAccuracy, relativeCost,
    costPerPoint: extraCost <= 0 ? 0 : extraCost / (gainPoints || Number.EPSILON),
  }
}

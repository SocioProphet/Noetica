import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  fit, predict, decide, vectorize, reliability, expectedCalibrationError,
  evaluatePolicy, suggestPolicy, FEATURES, DEFAULT_POLICY,
  type TrainingRow, type DeliberationSignals,
} from './deliberation-controller.js'

/** A separable set: high gate_conf ⇒ correct, low ⇒ wrong. */
function separable(n = 200): TrainingRow[] {
  const rows: TrainingRow[] = []
  for (let i = 0; i < n; i++) {
    const good = i % 2 === 0
    rows.push({
      signals: { gate_conf: good ? 0.8 + (i % 10) / 100 : 0.2 + (i % 10) / 100, gate_agree: good },
      correct: good,
    })
  }
  return rows
}

test('vectorize marks absent features rather than silently zero-filling them', () => {
  const { x, present } = vectorize({ gate_conf: 0.7 })
  assert.equal(x.length, FEATURES.length)
  assert.equal(present[FEATURES.indexOf('gate_conf')], true)
  assert.equal(present[FEATURES.indexOf('brain_conf')], false)
  assert.equal(x[FEATURES.indexOf('brain_conf')], 0, 'zero as a placeholder, but flagged absent')
})

test('booleans coerce to 0/1 so gate_agree is usable as a feature', () => {
  const i = FEATURES.indexOf('gate_agree')
  assert.equal(vectorize({ gate_agree: true }).x[i], 1)
  assert.equal(vectorize({ gate_agree: false }).x[i], 0)
  assert.equal(vectorize({ gate_agree: false }).present[i], true, 'false is a VALUE, not an absence')
})

test('fit learns a separable signal and predicts on the right side of the base rate', () => {
  const model = fit(separable())
  const hi = predict(model, { gate_conf: 0.9, gate_agree: true })
  const lo = predict(model, { gate_conf: 0.2, gate_agree: false })
  assert.ok(hi > 0.7, `confident case should be high, got ${hi}`)
  assert.ok(lo < 0.3, `doubtful case should be low, got ${lo}`)
  assert.ok(hi > lo)
})

test('features too sparse to learn from are dropped, not fitted on noise', () => {
  const rows = separable(100)
  rows[0]!.signals.brain_conf = 0.9   // present in 1% of rows
  const model = fit(rows)
  assert.equal(model.usable[FEATURES.indexOf('brain_conf')], false)
  assert.equal(model.weights[FEATURES.indexOf('brain_conf')], 0)
})

test('with no usable signal the model returns the base rate — never a confident guess', () => {
  const rows: TrainingRow[] = Array.from({ length: 50 }, (_, i) => ({ signals: {}, correct: i < 20 }))
  const model = fit(rows)
  const p = predict(model, {})
  assert.ok(Math.abs(p - 0.4) < 0.001, `expected the 40% base rate, got ${p}`)
})

test('an empty training set degrades to 0.5 rather than throwing', () => {
  assert.equal(predict(fit([]), { gate_conf: 0.9 }), 0.5)
})

test('decide maps probability to action at the policy thresholds', () => {
  assert.equal(decide(0.95, DEFAULT_POLICY), 'stop')
  assert.equal(decide(0.5, DEFAULT_POLICY), 'escalate')
  assert.equal(decide(0.75, DEFAULT_POLICY), 'continue')
})

test('reliability exposes overconfidence instead of hiding it', () => {
  // a model that is right only half the time on rows it calls confident
  const rows: TrainingRow[] = Array.from({ length: 100 }, (_, i) => ({
    signals: { gate_conf: 0.9, gate_agree: true }, correct: i % 2 === 0,
  }))
  const model = fit(rows)
  const bins = reliability(model, rows)
  const populated = bins.filter((b) => b.n > 0)
  assert.ok(populated.length > 0)
  assert.ok(Number.isFinite(expectedCalibrationError(bins)))
  for (const b of populated) assert.ok(Math.abs(b.actual - 0.5) < 0.2, 'actual accuracy is reported truthfully')
})

test('suggestPolicy derives thresholds from the model’s OWN distribution', () => {
  // Calibration on real transcripts showed absolute thresholds failing: p never exceeded 0.8,
  // so stopAbove=0.9 fired never and 83% of rows escalated. Derived thresholds must adapt.
  const rows = separable(200)
  const model = fit(rows)
  const policy = suggestPolicy(model, rows, { targetEscalationRate: 0.25 })
  assert.ok(policy.stopAbove > policy.escalateBelow, 'thresholds must not invert')
  const ev = evaluatePolicy(model, rows, policy)
  assert.ok(ev.escalationRate <= 0.45, `escalation should respect the budget, got ${ev.escalationRate}`)
})

test('a derived policy escalates less than the naive absolute default on the same data', () => {
  const rows = separable(200)
  const model = fit(rows)
  const naive = evaluatePolicy(model, rows, DEFAULT_POLICY)
  const derived = evaluatePolicy(model, rows, suggestPolicy(model, rows, { targetEscalationRate: 0.25 }))
  assert.ok(derived.escalationRate <= naive.escalationRate)
  assert.ok(derived.relativeCost <= naive.relativeCost, 'and therefore spends no more')
})

test('evaluatePolicy reports spend and cost-per-point, never a free lunch', () => {
  const rows = separable(120)
  const model = fit(rows)
  const ev = evaluatePolicy(model, rows, { stopAbove: 0.99, escalateBelow: 0.9 })
  assert.equal(ev.n, 120)
  assert.ok(ev.relativeCost >= 1, 'escalation always costs more than not escalating')
  assert.ok(ev.costPerPoint >= 0)
  assert.ok(ev.projectedAccuracy >= ev.baselineAccuracy, 'escalation cannot lower accuracy in this model')
})

test('a degenerate distribution cannot produce inverted thresholds', () => {
  const rows: TrainingRow[] = Array.from({ length: 30 }, () => ({ signals: {}, correct: true }))
  const model = fit(rows)
  const p = suggestPolicy(model, rows)
  assert.ok(p.stopAbove > p.escalateBelow)
})

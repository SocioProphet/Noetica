#!/usr/bin/env -S node --import tsx
/**
 * calibrate-deliberation — fit and honestly grade the DeliberationController on board
 * transcripts we ALREADY OWN. Costs nothing: no model is called, only labelled rows on disk.
 *
 *   npx tsx scripts/calibrate-deliberation.ts [--glob ~/.noetica/mmlu-brain-*.jsonl]
 *
 * Reports a held-out split (never train-on-test), the calibration curve, ECE, and the
 * projected cost-per-point under an explicitly stated escalation-recovery assumption.
 * Replacing that assumption with a measurement is what a live board run is for — which is
 * exactly why this script stops short of claiming the lane is `measured`.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  fit, predict, reliability, expectedCalibrationError, evaluatePolicy, decide,
  DEFAULT_POLICY, suggestPolicy, FEATURES, type TrainingRow, type DeliberationSignals,
} from '../lib/deliberation-controller.js'

const HOME = path.join(os.homedir(), '.noetica')

function loadRows(dir = HOME): TrainingRow[] {
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /^(mmlu-brain|board).*\.jsonl$/.test(f)).map((f) => path.join(dir, f))
    : []
  const rows: TrainingRow[] = []
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let d: Record<string, unknown>
      try { d = JSON.parse(line) } catch { continue }
      // Label preference: the gate arm's outcome, else the brain's, else baseline. A row with
      // no outcome is unlabelled and must not be invented.
      const label = ['gate_ok', 'brain_ok', 'baseline_ok'].map((k) => d[k]).find((v) => typeof v === 'boolean')
      if (typeof label !== 'boolean') continue
      const signals: DeliberationSignals = {}
      for (const f of FEATURES) if (d[f] !== undefined) (signals as Record<string, unknown>)[f] = d[f]
      if (!Object.keys(signals).length) continue
      rows.push({ signals, correct: label })
    }
  }
  return rows
}

function splitDeterministic(rows: TrainingRow[], holdout = 0.3): [TrainingRow[], TrainingRow[]] {
  // deterministic interleave — reproducible without a seeded RNG
  const train: TrainingRow[] = []; const test: TrainingRow[] = []
  const every = Math.max(2, Math.round(1 / holdout))
  rows.forEach((r, i) => ((i % every === 0) ? test : train).push(r))
  return [train, test]
}

const pct = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a')

function main(): void {
  const rows = loadRows()
  console.log(`\nDELIBERATION CONTROLLER — calibration on owned transcripts`)
  console.log(`${'='.repeat(64)}`)
  console.log(`labelled rows with at least one signal: ${rows.length}`)
  if (rows.length < 40) {
    console.log(`\n⚠ too few labelled rows to calibrate honestly (need ≥40).`)
    console.log(`  The controller ships unfitted; run a board to generate transcripts.`)
    return
  }

  const [train, test] = splitDeterministic(rows)
  const model = fit(train)
  console.log(`train ${train.length} / held-out ${test.length} · base rate ${pct(model.baseRate)}`)

  console.log(`\nlearned weights (standardised; only features with ≥25% coverage are used):`)
  FEATURES.forEach((f, i) => {
    console.log(`  ${f.padEnd(18)} ${model.usable[i] ? model.weights[i]!.toFixed(3).padStart(7) : '   (sparse — dropped)'}`)
  })

  const bins = reliability(model, test)
  console.log(`\ncalibration on HELD-OUT rows (predicted vs actual):`)
  for (const b of bins) {
    if (!b.n) { console.log(`  [${b.lo.toFixed(1)}–${b.hi.toFixed(1)})  empty`); continue }
    console.log(`  [${b.lo.toFixed(1)}–${b.hi.toFixed(1)})  n=${String(b.n).padStart(3)}  predicted ${pct(b.predicted)}  actual ${pct(b.actual)}`)
  }
  console.log(`  expected calibration error: ${pct(expectedCalibrationError(bins))}  (lower is better)`)

  const report = (label: string, policy: typeof DEFAULT_POLICY): void => {
    const ev = evaluatePolicy(model, test, policy)
    const counts = { stop: 0, continue: 0, escalate: 0 } as Record<string, number>
    for (const r of test) counts[decide(predict(model, r.signals), policy)]!++
    console.log(`\n${label} (stop ≥ ${policy.stopAbove.toFixed(3)}, escalate ≤ ${policy.escalateBelow.toFixed(3)}):`)
    console.log(`  escalation rate     ${pct(ev.escalationRate)}`)
    console.log(`  baseline accuracy   ${pct(ev.baselineAccuracy)}`)
    console.log(`  projected accuracy  ${pct(ev.projectedAccuracy)}   [ASSUMES escalation fixes 50% of errors]`)
    console.log(`  relative spend      ${ev.relativeCost.toFixed(2)}×`)
    console.log(`  cost per point      ${Number.isFinite(ev.costPerPoint) ? ev.costPerPoint.toFixed(3) : 'n/a'}`)
    console.log(`  action split        stop ${counts['stop']} · continue ${counts['continue']} · escalate ${counts['escalate']}`)
  }

  report('FIXED default policy — absolute thresholds', DEFAULT_POLICY)
  const suggested = suggestPolicy(model, train, { targetEscalationRate: 0.25 })
  report('DERIVED policy — thresholds from the model\'s own distribution (25% budget)', suggested)
  console.log(`\nNOTE: projected accuracy rests on a STATED assumption, not a measurement.`)
  console.log(`Promoting this lane to \`measured\` requires a live board emitting real cost-per-point.\n`)
}

main()

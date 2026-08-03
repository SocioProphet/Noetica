/** Teeth for detector-id-map.ts — the boundary that makes a Noetica detector firing emit the STANDARD id.
 *  Both directions: every shipped detector reconciles to a governed standard id; a drifted id is REJECTED. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectorIds, runDetectors } from './debate-detectors.js'
import {
  toStandardId,
  isGoverned,
  succeedsInto,
  reconcileHit,
  emittedIds,
  GOVERNED_STANDARD_IDS,
} from './detector-id-map.js'

test('every shipped detector id reconciles to a governed standard id (round-trip)', () => {
  for (const id of detectorIds()) {
    const std = toStandardId(id)
    assert.ok(isGoverned(std), `${id} -> ${std} must be governed`)
  }
})

test('coverage is complete both ways: emitted map set === detectorIds() set', () => {
  assert.deepEqual(new Set(emittedIds()), new Set(detectorIds()))
  assert.equal(GOVERNED_STANDARD_IDS.size, detectorIds().length)
})

test('a drifted / unmapped id is REJECTED', () => {
  assert.throws(() => toStandardId('LOGFALL.NOTREAL.V9'), /not in the governed id map/)
  assert.throws(() => toStandardId('LOGFALL.ADHOMINEM.V2'), /REJECTED/)
})

test('reconcileHit rewrites a real hit to its standard id and rejects drift', () => {
  const hits = runDetectors("So you're saying we should never have any regulations at all?")
  assert.ok(hits.length > 0)
  for (const h of hits) {
    const rc = reconcileHit(h)
    assert.ok(isGoverned(rc.ruleId))
    assert.equal(rc.span, h.span) // only the id is reconciled; the evidence is untouched
  }
  assert.throws(() => reconcileHit({ ruleId: 'COGBIAS.MADEUP.V1', score: 1, span: 'x', rationale: 'y' }))
})

test('succeedsInto reports the migration target without substituting it', () => {
  assert.equal(succeedsInto('LOGFALL.ADHOMINEM.V1'), 'LOGFALL.ADHOM.V2')
  assert.equal(succeedsInto('COGBIAS.CONFIRM.V1'), null)
  // the emitted detection keeps the shipped id — the V2 successor is never emitted in its place
  assert.equal(toStandardId('LOGFALL.ADHOMINEM.V1'), 'LOGFALL.ADHOMINEM.V1')
})

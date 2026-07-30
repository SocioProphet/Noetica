/**
 * nli-availability.test — the fix for the /api/grounding/verify-answer defect.
 *
 * Pre-fix, the generate callback caught every error and returned 'NEUTRAL'; a
 * user without qwen2.5:7b installed saw a fabricated "X/Y sentences supported"
 * count. This module distinguishes:
 *   - available:true, NEUTRAL result — the NLI ran and neither entailed nor
 *     contradicted the claim (a real judgment).
 *   - available:false — the NLI didn't run at all (model missing, ollama down,
 *     runtime error) — the endpoint MUST NOT report a support count.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeTrackingEntail } from './nli-availability.js'

test('makeTrackingEntail — wasAvailable stays true when generate succeeds', async () => {
  const tracker = makeTrackingEntail(async () => 'ENTAILED')
  const out = await tracker.entail('anything')
  assert.equal(out, 'ENTAILED')
  assert.equal(tracker.wasAvailable(), true)
  assert.equal(tracker.lastError(), undefined)
})

test('makeTrackingEntail — a runtime error flips wasAvailable to false', async () => {
  // Discriminating case: generate throws (model pulled mid-run, ollama restarted,
  // 5xx from local runner). Pre-fix, the caller's own catch turned this into
  // 'NEUTRAL' and downstream verifyGroundingNLI happily produced a support count.
  const tracker = makeTrackingEntail(async () => { throw new Error('ollama 500: model not found') })
  const out = await tracker.entail('anything')
  // The wrapper STILL returns 'NEUTRAL' so downstream verifiers keep producing
  // a shape-valid result — but the caller is now REQUIRED to check wasAvailable
  // and surface {available:false} instead.
  assert.equal(out, 'NEUTRAL')
  assert.equal(tracker.wasAvailable(), false)
  assert.match(tracker.lastError()!, /model not found/)
})

test('makeTrackingEntail — a single failure taints the whole run', async () => {
  // Half-succeed, half-fail: we conservatively report unavailable, because a
  // partial NLI run is not a trustworthy "X/Y supported" count.
  let call = 0
  const tracker = makeTrackingEntail(async () => {
    call++
    if (call === 2) throw new Error('transient')
    return 'ENTAILED'
  })
  await tracker.entail('p1')
  await tracker.entail('p2')
  await tracker.entail('p3')
  assert.equal(tracker.wasAvailable(), false, 'ANY error in the run must taint availability')
})

test('makeTrackingEntail — the "NLI ran, answered NEUTRAL" state is NOT unavailable', async () => {
  // The critical distinction: a genuine NEUTRAL answer from the judge is not
  // an unavailability signal. Pre-fix this state was indistinguishable from a
  // silent error-swallow.
  const tracker = makeTrackingEntail(async () => 'NEUTRAL')
  await tracker.entail('anything')
  assert.equal(tracker.wasAvailable(), true, 'a real NEUTRAL is a valid answer, not an outage')
})

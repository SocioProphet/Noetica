/**
 * bon-coverage.test — the fix for the best-of-N `verified` gate that Copilot
 * flagged in PR #396.
 *
 * Pre-fix: `verified: ctxTokens.size > 0 && coverage >= 0.05` counted response
 * tokens `w.length > 3` that appeared in context tokens `w.length > 3`. Common
 * English words trivially flipped verified=true, and selectBestOfN sorts
 * verified-first — so an ungrounded fluent answer beat a genuinely-grounded
 * terse one.
 *
 * The discriminating test below reproduces that failure mode with the OLD gate
 * (embedded as `verifiedLegacy` for reference) and shows the NEW gate distinguishes
 * them correctly. A regression to the old inline gate would flip the assertion.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bonCoverage, contentTokens } from './bon-coverage.js'
import { selectBestOfN } from './best-of-n.js'

// The exact shape of the pre-fix inline gate, for reference — DO NOT export.
function verifiedLegacy(response: string, context: string): { coverage: number; verified: boolean } {
  const ctxTokens = new Set(context.toLowerCase().split(/\W+/).filter((w) => w.length > 3))
  const respTokens = response.toLowerCase().split(/\W+/).filter((w) => w.length > 3)
  const coverage = ctxTokens.size === 0 ? 0 : respTokens.filter((t) => ctxTokens.has(t)).length / Math.max(respTokens.length, 1)
  return { coverage, verified: ctxTokens.size > 0 && coverage >= 0.05 }
}

test('content-bearing tokens exclude stopwords and short words', () => {
  const toks = contentTokens('These would could should have been simply about training')
  // 'these','would','could','should','have','been','about' are all stopped.
  // 'simply','training' are the content words.
  assert.deepEqual(toks.sort(), ['simply', 'training'])
})

test('DISCRIMINATING CASE #1: a stopword-only fluent answer that WAS legacy-verified is now REJECTED', () => {
  // ctx is realistic English prose — as it is in production — so it carries stopwords
  // like 'they','their','because','they','need' throughout. The fluent junk rebounds
  // those same stopwords back but never touches the actual topic (kubernetes, helm,
  // charts, deployed). Legacy (length-only filter) sees the stopword overlap as
  // coverage, verifies it, and — because selectBestOfN sorts verified-first — the
  // junk beats any un-verified grounded answer. That's the exact defect.
  const ctx = 'They deployed their kubernetes clusters through helm charts because their engineering team preferred those tools when they need consistency.'
  const fluentJunk = 'They have their views because they need results and their thoughts about that.'

  const legacyF = verifiedLegacy(fluentJunk, ctx)
  const newF = bonCoverage(fluentJunk, ctx)

  // Reproduce the defect: legacy gate verifies pure-stopword fluency.
  assert.equal(legacyF.verified, true, 'legacy: fluent junk was verified — the exact defect')
  assert.ok(legacyF.coverage >= 0.05, `legacy: fluent junk cleared 0.05 (got ${legacyF.coverage})`)

  // The FIX: with stopwords stripped, the fluent junk has zero content-token
  // overlap and drops to verified=false. selectBestOfN can no longer be fooled.
  assert.equal(newF.verified, false, 'FIX: fluent junk is no longer verified')
  assert.ok(newF.coverage < 0.05, `FIX: content-token coverage dropped below 0.05 (got ${newF.coverage})`)
})

test('DISCRIMINATING CASE #2: a lexically-grounded terse answer stays the winner', () => {
  // Complement to case #1: when the grounded answer DOES share content-bearing
  // tokens with ctx (Warden ⇢ warden, enforces ⇢ enforces), both the legacy and
  // the new gate verify it — but the FIX has never made a genuinely grounded
  // answer LOSE to a fluent ungrounded one. Guards against the fix over-rejecting.
  const ctx = 'The Warden component enforces retention doctrine on sealed governance receipts stored in the sovereign registry.'
  const grounded = 'Warden enforces retention.'
  const fluent   = 'These would have generally been things that people would expect from such a system.'

  const g = bonCoverage(grounded, ctx)
  const f = bonCoverage(fluent, ctx)
  assert.equal(g.verified, true, 'grounded (lexical) stays verified')
  assert.equal(f.verified, false, 'pure stopword-fluent stays rejected')

  const { best } = selectBestOfN([
    { text: grounded, verified: g.verified, coverage: g.coverage },
    { text: fluent, verified: f.verified, coverage: f.coverage },
  ])
  assert.equal(best!.text, grounded)
})

test('empty context or empty response cannot be verified', () => {
  assert.deepEqual(bonCoverage('anything at all', ''), { coverage: 0, verified: false })
  assert.deepEqual(bonCoverage('', 'some context'), { coverage: 0, verified: false })
  // A response of pure stopwords collapses to zero content tokens ⇒ unverifiable.
  assert.deepEqual(bonCoverage('these would have been about that', 'some real context here'), { coverage: 0, verified: false })
})

test('grounded answer with high content-token overlap clears the 0.05 threshold', () => {
  const ctx = 'The sovereign registry pattern replaces GHCR with zot and MinIO for OCI blob storage.'
  const grounded = 'Sovereign registry replaces GHCR with zot and MinIO for blob storage.'
  const r = bonCoverage(grounded, ctx)
  assert.ok(r.verified, `expected verified=true, got ${JSON.stringify(r)}`)
  assert.ok(r.coverage >= 0.5, `expected substantial coverage, got ${r.coverage}`)
})

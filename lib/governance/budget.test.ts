/**
 * budget.test — a spend ceiling that has never refused anything is not a ceiling.
 *
 * `budget_ref` was declared on the request and the decision, copied between them, and
 * read by nothing: a caller could set a ceiling, see it echoed back, and reasonably
 * conclude it was enforced. `limit-receipt.schema.json` described the artifact such
 * enforcement should emit and had zero code references. Half a mechanism twice over.
 *
 * Most of these are refusals, because the property under test is a refusal.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  consultBudget, declareBudget, recordSpend, getBudget, resetBudgets,
  wireDefaultHostedBudget, DEFAULT_HOSTED_BUDGET_REF,
} from './budget.js'

function fresh(limit: number, observed = 0) {
  resetBudgets()
  declareBudget({
    ref: 'budget:daily-egress',
    limitType: 'daily-external-egress-usd',
    limitValue: limit,
    observedValue: observed,
    windowStartedAt: '2026-07-29T00:00:00Z',
  })
}

test('spend under the ceiling is allowed and emits no receipt', () => {
  fresh(10, 4)
  const r = consultBudget('budget:daily-egress', 2)
  assert.equal(r.allowed, true)
  assert.equal(r.receipt, undefined, 'a limit receipt records a refusal; there was none')
})

test('spend that would cross the ceiling is refused, with a conforming receipt', () => {
  fresh(10, 9.5)
  const r = consultBudget('budget:daily-egress', 1, { engagementRef: 'req-1' })
  assert.equal(r.allowed, false)
  const rc = r.receipt!
  assert.ok(rc, 'a refusal must carry the receipt that records it')
  assert.equal(rc.schemaVersion, '0.1.0')
  assert.match(rc.receiptId, /^limit-receipt:[a-z0-9-]+$/, 'must satisfy the schema id pattern')
  assert.equal(rc.limitType, 'daily-external-egress-usd')
  assert.equal(rc.limitValue, 10)
  assert.equal(rc.observedValue, 10.5)
  assert.equal(rc.executionPerformed, false, 'pinned false: the receipt attests something did NOT run')
  assert.equal(rc.rollbackTaken, false, 'nothing ran, so there is nothing to roll back')
  assert.equal(rc.engagementRef, 'req-1')
  assert.ok(rc.agentRef.length > 0)
  assert.ok(!Number.isNaN(Date.parse(rc.enforcedAt)))
})

test('exactly at the ceiling is allowed; one unit past is not', () => {
  fresh(10, 8)
  assert.equal(consultBudget('budget:daily-egress', 2).allowed, true, 'boundary is inclusive')
  assert.equal(consultBudget('budget:daily-egress', 2.01).allowed, false)
})

test('an unresolvable budget_ref is REFUSED, not treated as unlimited', () => {
  // The defect being prevented: a reference that resolves to nothing, where the caller
  // believes a ceiling applies. Allowing it would reproduce the original bug with extra
  // steps — silently unlimited spend behind a field that looks like governance.
  fresh(10)
  const r = consultBudget('budget:does-not-exist', 5)
  assert.equal(r.allowed, false)
  assert.match(r.reason!, /does not resolve/)
  assert.equal(r.receipt, undefined, 'no declared limit means no limitValue to attest against')
})

test('no budget_ref at all is allowed and says so', () => {
  // Distinct from an unresolvable ref: nothing was claimed, so nothing is enforced.
  fresh(10)
  const r = consultBudget(undefined, 100)
  assert.equal(r.allowed, true)
  assert.match(r.reason!, /no budget declared/)
})

test('recorded spend accumulates and eventually refuses', () => {
  fresh(10)
  for (let i = 0; i < 4; i++) {
    assert.equal(consultBudget('budget:daily-egress', 2).allowed, true, `call ${i} should fit`)
    recordSpend('budget:daily-egress', 2)
  }
  assert.equal(getBudget('budget:daily-egress')!.observedValue, 8)
  assert.equal(consultBudget('budget:daily-egress', 2).allowed, true, '8+2 = 10, still at the ceiling')
  recordSpend('budget:daily-egress', 2)
  assert.equal(consultBudget('budget:daily-egress', 0.01).allowed, false, 'exhausted')
})

test('negative projections cannot be used to buy headroom', () => {
  fresh(10, 9)
  const r = consultBudget('budget:daily-egress', -100)
  assert.equal(r.allowed, true)
  assert.equal(getBudget('budget:daily-egress')!.observedValue, 9, 'consult must not mutate')
  recordSpend('budget:daily-egress', -50)
  assert.equal(getBudget('budget:daily-egress')!.observedValue, 9, 'negative spend must not credit the budget')
})

test('recordSpend against an unknown ref is a no-op, not a silent new budget', () => {
  fresh(10)
  recordSpend('budget:not-declared', 5)
  assert.equal(getBudget('budget:not-declared'), undefined)
  assert.equal(getBudget('budget:daily-egress')!.observedValue, 0)
})

test('getBudget returns a copy — callers cannot edit the ceiling', () => {
  fresh(10, 3)
  const snapshot = getBudget('budget:daily-egress')!
  snapshot.limitValue = 1_000_000
  assert.equal(getBudget('budget:daily-egress')!.limitValue, 10, 'the ceiling must not be mutable through a read')
})

// ── wireDefaultHostedBudget — the caller wiring that made the module active ─────

test('wireDefaultHostedBudget is a no-op when the env var is unset', () => {
  resetBudgets()
  const prev = process.env.NOETICA_DAILY_HOSTED_USD_CEILING
  delete process.env.NOETICA_DAILY_HOSTED_USD_CEILING
  try {
    const ref = wireDefaultHostedBudget()
    assert.equal(ref, undefined, 'no env → no ref → chat/route.ts sends undefined and consultBudget skips')
    assert.equal(getBudget(DEFAULT_HOSTED_BUDGET_REF), undefined)
  } finally {
    if (prev !== undefined) process.env.NOETICA_DAILY_HOSTED_USD_CEILING = prev
  }
})

test('wireDefaultHostedBudget declares a budget when the env var is set', () => {
  resetBudgets()
  const prev = process.env.NOETICA_DAILY_HOSTED_USD_CEILING
  process.env.NOETICA_DAILY_HOSTED_USD_CEILING = '2.50'
  try {
    const ref = wireDefaultHostedBudget()
    assert.equal(ref, DEFAULT_HOSTED_BUDGET_REF)
    const b = getBudget(DEFAULT_HOSTED_BUDGET_REF)!
    assert.equal(b.limitValue, 2.5)
    assert.equal(b.limitType, 'daily-external-egress-usd')
    assert.equal(b.observedValue, 0)
  } finally {
    if (prev === undefined) delete process.env.NOETICA_DAILY_HOSTED_USD_CEILING
    else process.env.NOETICA_DAILY_HOSTED_USD_CEILING = prev
  }
})

test('wireDefaultHostedBudget rejects non-positive / malformed ceilings', () => {
  resetBudgets()
  const prev = process.env.NOETICA_DAILY_HOSTED_USD_CEILING
  try {
    for (const bad of ['', '0', '-5', 'not-a-number', 'NaN']) {
      process.env.NOETICA_DAILY_HOSTED_USD_CEILING = bad
      resetBudgets()
      assert.equal(wireDefaultHostedBudget(), undefined, `bad env ${JSON.stringify(bad)} must not wire a budget`)
      assert.equal(getBudget(DEFAULT_HOSTED_BUDGET_REF), undefined)
    }
  } finally {
    if (prev === undefined) delete process.env.NOETICA_DAILY_HOSTED_USD_CEILING
    else process.env.NOETICA_DAILY_HOSTED_USD_CEILING = prev
  }
})

test('wireDefaultHostedBudget is idempotent — a second call does NOT reset observed spend', () => {
  resetBudgets()
  const prev = process.env.NOETICA_DAILY_HOSTED_USD_CEILING
  process.env.NOETICA_DAILY_HOSTED_USD_CEILING = '10'
  try {
    wireDefaultHostedBudget()
    recordSpend(DEFAULT_HOSTED_BUDGET_REF, 3)
    assert.equal(getBudget(DEFAULT_HOSTED_BUDGET_REF)!.observedValue, 3)
    // A re-import of chat/route.ts (or a hot-reload) must not wipe the running total,
    // or a caller could game a ceiling by triggering a reload every N turns.
    wireDefaultHostedBudget()
    assert.equal(getBudget(DEFAULT_HOSTED_BUDGET_REF)!.observedValue, 3, 'idempotent init must not reset spend')
  } finally {
    if (prev === undefined) delete process.env.NOETICA_DAILY_HOSTED_USD_CEILING
    else process.env.NOETICA_DAILY_HOSTED_USD_CEILING = prev
  }
})

test('END-TO-END: a request WITH budget_ref=missing returns REFUSED not PASS', () => {
  // The discriminating case named in the finding: pre-fix, consultBudget was never
  // reached because no caller ever set request.budget_ref. Wire is proven by passing
  // an UNDECLARED ref through the same consultBudget path chat/route.ts uses and
  // asserting it's refused with a LimitReceipt-shaped-null (unresolvable ref → no
  // limitValue → refusal without a receipt), NOT silently allowed.
  resetBudgets()
  const r = consultBudget('noetica:hosted-daily-usd', 1, { engagementRef: 'req-x' })
  assert.equal(r.allowed, false, 'unresolvable ref must be refused; pre-fix this line was never reached')
  assert.match(r.reason!, /does not resolve/)
})

test('END-TO-END: declare→consult→recordSpend→consult reproduces the wired flow', () => {
  // Mirrors what chat/route.ts now does end-to-end: wire at module load, consult
  // before route, record after response. Nothing was ever called before this PR.
  resetBudgets()
  const prev = process.env.NOETICA_DAILY_HOSTED_USD_CEILING
  process.env.NOETICA_DAILY_HOSTED_USD_CEILING = '0.05'
  try {
    const ref = wireDefaultHostedBudget()!
    // First turn — fits.
    assert.equal(consultBudget(ref, 0.01).allowed, true)
    recordSpend(ref, 0.02)                                   // realised spend, tokens > estimate
    // Second turn — fits.
    assert.equal(consultBudget(ref, 0.01).allowed, true)
    recordSpend(ref, 0.02)
    // Third turn — projected spend now exceeds the ceiling; consultBudget refuses.
    const refused = consultBudget(ref, 0.02, { engagementRef: 'req-3' })
    assert.equal(refused.allowed, false)
    assert.ok(refused.receipt, 'a refusal at the ceiling carries the LimitReceipt')
    assert.equal(refused.receipt!.executionPerformed, false)
  } finally {
    if (prev === undefined) delete process.env.NOETICA_DAILY_HOSTED_USD_CEILING
    else process.env.NOETICA_DAILY_HOSTED_USD_CEILING = prev
  }
})

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

import { consultBudget, declareBudget, recordSpend, getBudget, resetBudgets } from './budget.js'

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

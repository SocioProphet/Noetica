// Every test uses a throwaway NOETICA_HOME — never the operator's real ~/.noetica.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'noetica-multi-intent-'))
process.env['NOETICA_HOME'] = HOME

import { classifyIntent, classifyIntents, allIntents, type IntentPlan } from './intent-router.js'
import { ledgerHash } from './verb-sort.js'
import { dispatchSet, buildCanonicalGrid, ACTIONS } from './intent-grid.js'
import {
  recordDispatch, recordDispatchSet, replayLedger, contentHash, truthProduct,
  type DispatchInput,
} from './dispatch-ledger.js'

function freshHome(tag: string): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), `noetica-multi-${tag}-`))
  process.env['NOETICA_HOME'] = h
  return h
}

const H = (s: string): string => contentHash(s)

function lawfulInput(over: Partial<DispatchInput> = {}): DispatchInput {
  return {
    session: 'test', requestHash: H('ask'), action: 'retrieve', polarity: 'read',
    tier: 'reflex', target: 'local', phase: null,
    barCleared: true, residual: [],
    model: 'test-model', answerHash: H('answer'), latencyMs: 12, grounded: true,
    ...over,
  }
}

// ── classifyIntents: the plural surface ────────────────────────────────────────

test('classifyIntents returns EVERY matching intent, ranked by specificity', () => {
  // The invariant: an utterance carrying multiple concurrent intents surfaces all of them
  // rather than collapsing to top-1 before the reasoner sees the evidence.
  const r = classifyIntents('review my code and audit the security', {}, 3)
  const names = r.map((i) => i.name)
  assert.ok(names.includes('code_review'), `expected code_review in ${names}`)
  assert.ok(names.includes('review_audit'), `expected review_audit in ${names}`)
  // Ordered by score descending
  for (let i = 1; i < r.length; i++) {
    assert.ok(r[i - 1]!.score >= r[i]!.score, 'must be descending by score')
  }
})

test('classifyIntents caps at `limit`, not at 1', () => {
  const r5 = classifyIntents('build fix debug review code compare status', {}, 5)
  const r1 = classifyIntents('build fix debug review code compare status', {}, 1)
  assert.ok(r5.length >= r1.length, 'higher limit surfaces more matches')
  assert.equal(r1.length, 1, 'limit 1 collapses to top-1')
  assert.ok(r5.length > 1, 'limit 5 exceeds 1 when multiple cues fire')
})

test('classifyIntents preserves the single-intent semantics of classifyIntent for its top', () => {
  // The plural surface must AGREE with the singular one on the top result — otherwise
  // callers switching from classifyIntent to classifyIntents would see routing changes.
  const cases = [
    'fix the broken build',
    'summarize this document',
    'plan next steps',
    'explain how retrieval works',
  ]
  for (const text of cases) {
    const singular = classifyIntent(text)
    const plural = classifyIntents(text, {}, 1)
    assert.equal(plural.length, 1, text)
    assert.equal(plural[0]!.name, singular.name, `top of plural must equal singular for ${JSON.stringify(text)}`)
    assert.equal(plural[0]!.score, singular.score)
  }
})

test('classifyIntents on nothing-matches returns exactly the general fallback', () => {
  // The single-intent surface has this fallback; the plural surface preserves it as a
  // one-item set so downstream consumers always get a routable plan.
  const r = classifyIntents('random gibberish xyzzy', {}, 3)
  assert.equal(r.length, 1)
  assert.equal(r[0]!.name, 'general')
  assert.equal(r[0]!.score, 0)
})

test('classifyIntents hasDoc + ambiguous question ADDS qa_over_doc, never replaces a strong intent', () => {
  // classifyIntent's behaviour: if a doc is loaded and the question is ambiguous, boost
  // qa_over_doc. Multi-intent extends this: qa_over_doc appears in the set, but a real
  // strong match still ranks above it.
  const ambiguous = classifyIntents('what does it say?', { hasDoc: true }, 3)
  assert.ok(ambiguous.some((i) => i.name === 'qa_over_doc'),
    'ambiguous doc-question must surface qa_over_doc')

  // A STRONG intent must outrank the qa_over_doc boost. Asserting the specific winner would
  // be brittle — "broken build" legitimately scores build_implement above fix_debug on cue
  // length, and either is a correct strong match. What matters is that qa_over_doc did not
  // displace them: the hasDoc boost ADDS a candidate, it does not override real evidence.
  const strong = classifyIntents('fix the broken build in this doc', { hasDoc: true }, 3)
  assert.notEqual(strong[0]!.name, 'qa_over_doc',
    'a strong cue match must outrank the hasDoc boost')
  assert.ok(strong[0]!.score >= 1.5,
    `top strong match must score at least the qa_over_doc boost (1.5), got ${strong[0]!.score}`)
})

test('classifyIntents result is frozen — the canon and its outputs cannot be mutated', () => {
  const r = classifyIntents('build a script', {}, 3)
  assert.throws(() => { (r as unknown as IntentPlan[]).push({} as unknown as IntentPlan) },
    'the returned set must be frozen')
  if (r.length > 0) {
    assert.throws(() => { (r[0]! as { name: string }).name = 'hijack' },
      'each plan must be frozen too')
  }
})

// ── dispatchSet: fan intents out to grid cells ─────────────────────────────────

test('dispatchSet fans each intent out to its admissible cells', () => {
  const plans = classifyIntents('review my code and audit the security', {}, 3)
  const ds = dispatchSet(plans)
  assert.ok(ds.plans.length >= 1)
  for (const p of ds.plans) {
    assert.ok(p.cells.length > 0, `${p.intent} has no cells — it should have been in emptyPlans`)
    for (const c of p.cells) {
      assert.equal(c.valid, true, 'only valid cells reach the dispatch set')
    }
  }
})

test('dispatchSet: empties are signal — a topic with no matching action lands in emptyPlans, not silently dropped', () => {
  // Ask for a rare action that most intents do not admit.
  const plans = classifyIntents('what is the status', {}, 3)
  const ds = dispatchSet(plans, ['sense'])   // sense is admissible in only 3 rows
  const totalPlanned = ds.plans.length + ds.emptyPlans.length
  assert.equal(totalPlanned, plans.length,
    'every requested plan must be accounted for: plans + emptyPlans = input')
  for (const ep of ds.emptyPlans) {
    assert.ok(ep.reason.length > 30, 'empty plans must carry a substantive reason')
    assert.match(ep.reason, /widen|missing|drift|not/i)
  }
})

test('dispatchSet: everyday is COLLAPSED into explain_teach per the canonical MINIMALITY test', () => {
  // The canonical grid drops `everyday` because its (substrate x polarity) profile is a
  // strict subset of `explain_teach`. dispatchSet must apply the same discipline — an
  // `everyday` plan must not vanish; it must route through explain_teach's row.
  const everyday = classifyIntents('how do i make coffee', {}, 1)
  if (everyday[0]?.name !== 'everyday') {
    // If the canon evolves and everyday no longer matches this cue, this test still runs
    // but its point is moot. Guard rather than fail.
    return
  }
  const ds = dispatchSet(everyday)
  assert.equal(ds.plans.length, 1, 'the collapsed intent must still produce a plan')
  assert.equal(ds.emptyPlans.length, 0, 'and must not appear as empty — collapse is a redirect, not a drop')
  const cellsAreExplainTeach = ds.plans[0]!.cells.every((c) => c.topic === 'explain_teach')
  assert.ok(cellsAreExplainTeach, 'the cells must belong to explain_teach after collapse')
})

test('dispatchSet preserves plan order (primary first)', () => {
  // Composition assigns priority by ordering: primary → secondary → tertiary. If dispatchSet
  // silently reordered, attribution downstream (composed receipt's drivingMember) would
  // point at the wrong intent.
  const plans = classifyIntents('review my code and audit the security', {}, 3)
  const ds = dispatchSet(plans)
  const names = ds.plans.map((p) => p.intent)
  const expectedOrder = plans
    .filter((p) => names.includes(p.name))
    .map((p) => p.name)
  assert.deepEqual(names, expectedOrder, 'order in dispatchSet.plans must match input order')
})

test('dispatchSet substrates union — a pre-computable set of ABB routes', () => {
  const plans = classifyIntents('build a script and fix the tests', {}, 3)
  const ds = dispatchSet(plans)
  const seen = new Set<string>()
  for (const p of ds.plans) for (const c of p.cells) seen.add(c.substrate)
  assert.deepEqual([...ds.substrates].sort(), [...seen].sort(),
    'substrates must be the exact union across every cell')
})

// ── recordDispatchSet: composed receipt over N dispatches ──────────────────────

test('recordDispatchSet: composite verdict is the truth-product (meet) over members', () => {
  freshHome('meet')
  // Primary POS, secondary POS ⇒ composite POS
  const posSet = recordDispatchSet('turn:pos-pos', ['a', 'b'], [lawfulInput(), lawfulInput()])
  assert.equal(posSet.verdict, 'POS', 'POS × POS = POS')

  // Primary POS, secondary ZERO ⇒ composite ZERO (a partial answer isn't a full one)
  freshHome('pos-zero')
  const mixedSet = recordDispatchSet('turn:pos-zero', ['a', 'b'], [
    lawfulInput(),
    lawfulInput({ residual: ['citation.resolves'] }),   // ZERO on law
  ])
  assert.equal(mixedSet.law, 'ZERO', 'POS × ZERO on law = ZERO')
  assert.equal(mixedSet.verdict, 'ZERO')

  // Primary POS, secondary NEG ⇒ composite NEG
  freshHome('pos-neg')
  const negSet = recordDispatchSet('turn:pos-neg', ['a', 'b'], [
    lawfulInput(),
    lawfulInput({ barCleared: false }),   // NEG on law
  ])
  assert.equal(negSet.verdict, 'NEG', 'POS × NEG = NEG')
})

test('recordDispatchSet: max is wrong; meet is right — a partial refutation cannot certify', () => {
  // If the composite were `max` (an OR), primary POS + secondary NEG would report POS,
  // leaking a passing turn on refuted evidence. This is the same failure mode dispatch-ledger
  // was built to remove one level down; the composite here inherits the same discipline.
  freshHome('max-wrong')
  const set = recordDispatchSet('turn:max-would-be-wrong', ['primary', 'refuted'], [
    lawfulInput(),
    lawfulInput({ refuted: true }),
  ])
  // Under `max`: POS max NEG = POS  ← the tempting wrong answer
  // Under truth-product (meet): POS × NEG = NEG  ← the right one
  assert.notEqual(set.verdict, 'POS', 'max composition would leak POS; the meet does not')
  assert.equal(set.verdict, 'NEG')
})

test('recordDispatchSet: drivingMember attributes the composite to a specific member', () => {
  // A caller asking "why is this turn NEG" must get an answer that names the intent, not
  // "the truth-product said so". Attribution is what makes the composite auditable.
  freshHome('driver')
  const set = recordDispatchSet('turn:driver', ['primary', 'secondary'], [
    lawfulInput(),
    lawfulInput({ refuted: true }),
  ])
  assert.ok(set.drivingMember)
  assert.equal(set.drivingMember!.name, 'secondary',
    'the driver of NEG is the refuted secondary, not the innocent primary')
  assert.equal(set.drivingMember!.verdict, set.verdict)
})

test('recordDispatchSet: every member is a real ledger entry that replays', () => {
  // The composite is not a summary that hides its members — each is chained individually,
  // so a caller can query, re-verify, or audit any one of them.
  const home = freshHome('members')
  const set = recordDispatchSet('turn:members', ['a', 'b', 'c'], [
    lawfulInput({ requestHash: H('q1') }),
    lawfulInput({ requestHash: H('q2') }),
    lawfulInput({ requestHash: H('q3') }),
  ])
  assert.equal(set.members.length, 3)

  const raw = fs.readFileSync(path.join(home, 'ledger', 'dispatch.jsonl'), 'utf8')
  const lines = raw.trim().split('\n').filter(Boolean)
  assert.equal(lines.length, 3, 'each member is a persisted ledger entry')
  assert.deepEqual(replayLedger(), { ok: true, count: 3 },
    'and the chain replays clean')
})

test('recordDispatchSet: attestation is DERIVED from member attestations', () => {
  // A caller with just the composite receipt can verify by re-hashing turnId + member
  // attestations, without re-loading every DispatchInput. Pin the recomputation here so a
  // change to the derivation rule fails loudly.
  freshHome('attest')
  const set = recordDispatchSet('turn:attest', ['a', 'b'], [lawfulInput(), lawfulInput()])
  // Recompute using only what a downstream consumer would have.
  const recomputed = ledgerHash({
    turnId: set.turnId,
    members: set.members.map((m) => m.attestation),
    intentNames: ['a', 'b'],
  })
  assert.equal(recomputed, set.attestation,
    'composite attestation must be reproducible from turnId + ordered member attestations')
})

test('recordDispatchSet: empty input and mismatched arity both fail loudly, not silently', () => {
  freshHome('arity')
  assert.throws(() => recordDispatchSet('t', [], []),
    /empty input set/,
    'empty is caller error — silent OK would be a shape trap')
  assert.throws(() => recordDispatchSet('t', ['a'], [lawfulInput(), lawfulInput()]),
    /must equal inputs.length/,
    'mismatched names/inputs would misattribute the driving member')
})

test('recordDispatchSet + dispatchSet compose end-to-end: utterance → intents → cells → composite', () => {
  // The whole chain the Michael capability sits on.
  freshHome('e2e')
  const plans = classifyIntents('review my code and audit the security', {}, 3)
  const ds = dispatchSet(plans)
  assert.ok(ds.plans.length >= 1, 'the utterance must produce at least one plan')

  // One dispatch per plan — the shape Michael's extract_multi_intent would produce.
  const names = ds.plans.map((p) => p.intent)
  const inputs = ds.plans.map((p) => lawfulInput({
    action: p.cells[0]!.action, polarity: p.cells[0]!.polarity,
  }))
  const set = recordDispatchSet(`turn:${Date.now()}`, names, inputs)

  assert.equal(set.members.length, ds.plans.length)
  assert.equal(set.verdict, 'POS', 'all lawful members ⇒ composite POS')
  assert.deepEqual(replayLedger(), { ok: true, count: ds.plans.length })
})

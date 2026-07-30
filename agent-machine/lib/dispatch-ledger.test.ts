// Every test runs against a throwaway NOETICA_HOME — never the operator's real ~/.noetica.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// dispatch-ledger resolves NOETICA_HOME lazily (per call), so setting it here governs
// every test regardless of import order. That is not incidental: the module used to
// resolve its path once at import time from os.homedir(), which made this convention
// silently ineffective for the EVIDENCE ledger specifically — every other module honoured
// an override while dispatches kept appending to the real ~/.noetica. This file could not
// have been written against that version, which is the sharpest available argument that
// the lazy resolution is load-bearing rather than cosmetic.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'noetica-ledger-'))
process.env['NOETICA_HOME'] = HOME

import {
  recordDispatch, replayLedger, contentHash, readDispatches,
  truthProduct, lawVerdict, evidenceVerdict, type Verdict, type DispatchEntry,
} from './dispatch-ledger.js'
import { ledgerHash } from './verb-sort.js'
import { createHash } from 'node:crypto'

const logPath = (home = process.env['NOETICA_HOME']!): string =>
  path.join(home, 'ledger', 'dispatch.jsonl')

/** A fresh ledger, by moving NOETICA_HOME. Because the in-memory head is keyed on WHICH
 *  log it hydrated from, relocating the home forces a re-hydrate — the same mechanism
 *  that makes a seat switch safe in production. */
function freshHome(tag: string): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), `noetica-ledger-${tag}-`))
  process.env['NOETICA_HOME'] = h
  return h
}

const entries = (home: string): DispatchEntry[] =>
  fs.readFileSync(logPath(home), 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as DispatchEntry)

/** Re-seal an entry exactly as recordDispatch does, mirroring the module's version-aware
 *  body rule: v2 seals include evidenceTier, v1 excluded it. A forger with this function can
 *  rewrite history so the hash chain still verifies — which is the point of using it below,
 *  since it forces the product and tier checks to earn their place independently. */
function bodyForTest(e: DispatchEntry): unknown {
  const { attestation: _a, evidenceTier, sealVersion, ...rest } = e
  return sealVersion === undefined ? rest : { ...rest, evidenceTier, sealVersion }
}
function reseal(e: DispatchEntry): DispatchEntry {
  return { ...e, attestation: ledgerHash(bodyForTest(e)) }
}

const H = (s: string): string => contentHash(s)

function lawful(over: Partial<Parameters<typeof recordDispatch>[0]> = {}) {
  return recordDispatch({
    session: 'test', requestHash: H('ask'), action: 'retrieve', polarity: 'read',
    tier: 'reflex', target: 'local', phase: null,
    barCleared: true, residual: [],
    model: 'test-model', answerHash: H('answer'), latencyMs: 12, grounded: true,
    ...over,
  })
}

// ── Truth = Law × Evidence: the algebra ─────────────────────────────────────────
// The equation is only worth writing down if `×` has a definite meaning. It does:
// the meet in the chain NEG < ZERO < POS, which is the categorical product in that
// chain viewed as a category. These tests pin the whole 3×3 table, because the two
// plausible-but-wrong readings both differ from it on specific cells.

test('truthProduct: the full 3×3 table is the lattice meet (min under NEG < ZERO < POS)', () => {
  const V: Verdict[] = ['NEG', 'ZERO', 'POS']
  const expected: Record<string, Verdict> = {
    'NEG,NEG': 'NEG', 'NEG,ZERO': 'NEG', 'NEG,POS': 'NEG',
    'ZERO,NEG': 'NEG', 'ZERO,ZERO': 'ZERO', 'ZERO,POS': 'ZERO',
    'POS,NEG': 'NEG', 'POS,ZERO': 'ZERO', 'POS,POS': 'POS',
  }
  for (const law of V) {
    for (const ev of V) {
      assert.equal(truthProduct(law, ev), expected[`${law},${ev}`],
        `${law} × ${ev} must be ${expected[`${law},${ev}`]}`)
    }
  }
})

test('truthProduct is NOT sign multiplication in {-1,0,+1} — NEG × NEG must not certify', () => {
  // The tempting implementation. Under it, a dispatch whose gate REFUSED and whose
  // outcome was REFUTED multiplies to POS: two independent failures certifying as
  // truth. This is the single cell that distinguishes a defensible product from a
  // catastrophic one, so it gets its own named test.
  const sign: Record<Verdict, number> = { NEG: -1, ZERO: 0, POS: 1 }
  assert.equal(sign['NEG'] * sign['NEG'], 1, 'sign arithmetic would say +1 (POS)')
  assert.equal(truthProduct('NEG', 'NEG'), 'NEG', 'the lattice meet says NEG — the only sound answer')
})

test('truthProduct is commutative, associative, and ZERO/NEG absorb correctly', () => {
  const V: Verdict[] = ['NEG', 'ZERO', 'POS']
  for (const a of V) {
    assert.equal(truthProduct(a, 'POS'), a, 'POS is the identity — evidence alone adds nothing')
    assert.equal(truthProduct(a, 'NEG'), 'NEG', 'NEG is absorbing — one refutation is enough')
    for (const b of V) {
      assert.equal(truthProduct(a, b), truthProduct(b, a), 'commutative')
      for (const c of V) {
        assert.equal(truthProduct(truthProduct(a, b), c), truthProduct(a, truthProduct(b, c)),
          'associative — so a chain of factors has an order-independent verdict')
      }
    }
  }
})

// ── the factors are derived from the record, never asserted ─────────────────────

test('lawVerdict: a refusal is NEG; undischarged residual is ZERO, not POS', () => {
  assert.equal(lawVerdict({ barCleared: true, residual: [] }), 'POS')
  assert.equal(lawVerdict({ barCleared: false, residual: [] }), 'NEG', 'gate refused')
  assert.equal(lawVerdict({ barCleared: true, residual: ['citation.resolves'] }), 'ZERO',
    'a bar that cleared while carrying constraints it could not discharge has deferred, not established')
})

test('evidenceVerdict: absent evidence is ZERO; only a refutation is NEG', () => {
  const base = { requestHash: H('q'), answerHash: H('a'), grounded: true }
  assert.equal(evidenceVerdict(base), 'POS')
  assert.equal(evidenceVerdict({ ...base, grounded: false }), 'ZERO', 'ungrounded is unevidenced, not false')
  assert.equal(evidenceVerdict({ ...base, answerHash: '' }), 'ZERO', 'no answer hash = nothing captured')
  assert.equal(evidenceVerdict({ ...base, answerHash: 'deadbeef' }), 'ZERO',
    'a malformed digest is not evidence — it must be sha256:<64 hex> or it proves nothing')
  assert.equal(evidenceVerdict({ ...base, refuted: true }), 'NEG', 'a verifier contradicted the outcome')
})

test('recordDispatch derives the verdict from its factors; a caller cannot assert one', () => {
  freshHome('derive')
  assert.equal(lawful().verdict, 'POS', 'lawful + evidenced')

  const residual = lawful({ residual: ['citation.resolves'] })
  assert.equal(residual.law, 'ZERO')
  assert.equal(residual.verdict, 'ZERO', 'POS × ZERO = ZERO — lawful but a claim we decline to make')

  const refused = lawful({ barCleared: false, residual: ['consent.granted'] })
  assert.equal(refused.law, 'NEG')
  assert.equal(refused.verdict, 'NEG', 'a refusal stands on its own')

  const unevidenced = lawful({ answerHash: '', grounded: false })
  assert.equal(unevidenced.evidence, 'ZERO')
  assert.equal(unevidenced.verdict, 'ZERO')

  const wrong = lawful({ refuted: true })
  assert.equal(wrong.verdict, 'NEG', 'lawful route, refuted outcome — POS × NEG = NEG')

  // The regression this file exists to prevent: the sole production caller used to pass
  // `verdict: 'POS'` literally on every dispatch, so 100% of recorded history read as
  // true by construction. Every verdict above is now a consequence of the record.
  for (const e of readDispatches()) {
    // The guard is not ceremony: readDispatches is typed to admit legacy rows with no
    // factors, and tsc rejected this line without it. That is the honest type earning its
    // keep — the previous signature let the same call compile while multiplying undefined.
    assert.ok(e.law !== undefined && e.evidence !== undefined, `seq ${e.seq} is a v2 entry`)
    assert.equal(e.verdict, truthProduct(e.law, e.evidence), `seq ${e.seq} verdict must follow`)
  }
})

// ── the chain: tamper-evidence ──────────────────────────────────────────────────

test('the ledger writes under NOETICA_HOME and replays clean', () => {
  const home = freshHome('clean')
  for (let i = 0; i < 5; i++) lawful({ requestHash: H(`q${i}`), answerHash: H(`a${i}`) })

  assert.ok(fs.existsSync(logPath(home)), 'appended under the override, not the real ~/.noetica')
  const es = entries(home)
  assert.equal(es.length, 5)
  assert.equal(es[0]!.prev, 'genesis')
  assert.equal(es[0]!.evidenceTier, 'T1')
  for (let i = 1; i < es.length; i++) {
    assert.equal(es[i]!.prev, es[i - 1]!.attestation, 'each entry links to its predecessor')
    assert.equal(es[i]!.seq, es[i - 1]!.seq + 1, 'sequence is dense')
  }
  assert.deepEqual(replayLedger(), { ok: true, count: 5 })
})

test('tampering with an upstream entry diverges every downstream attestation', () => {
  // The negative control the module docstring claims. A constraint never observed
  // refusing is indistinguishable from no constraint.
  const home = freshHome('tamper')
  for (let i = 0; i < 4; i++) lawful({ requestHash: H(`q${i}`), answerHash: H(`a${i}`) })
  assert.equal(replayLedger().ok, true, 'clean before tampering')

  const es = entries(home)
  const before = es.map((e) => e.attestation)

  // Alter the *content* of entry 1 and re-seal it, the strongest form of the attack:
  // the forged entry's own hash is internally consistent.
  es[1] = reseal({ ...es[1]!, model: 'exfiltrating-model' })
  assert.notEqual(es[1]!.attestation, before[1], 'the forgery changed entry 1\'s seal')
  fs.writeFileSync(logPath(home), es.map((e) => JSON.stringify(e)).join('\n') + '\n')

  const r = replayLedger()
  assert.equal(r.ok, false, 'tampering must be detected')
  assert.equal(r.brokenAt, 2, 'detected at the first entry whose prev-link no longer matches')
  assert.match(r.reason!, /prev-link/)

  // Be precise about WHAT diverges. The module docstring says "tamper anywhere upstream
  // diverges every downstream attestation", and the loose reading of that — every
  // individual prev-link breaks — is false, as an earlier version of this assertion
  // discovered: entries 2→3 still chain to each other, because the forger touched
  // neither. The true property is reachability. Entry 2 is the seam, and no entry from
  // the seam onward can be validated from genesis, so the whole suffix is worthless
  // regardless of its internal consistency.
  assert.notEqual(es[2]!.prev, es[1]!.attestation, 'the seam: entry 2 no longer chains to the forged entry 1')
  assert.equal(es[2]!.prev, before[1], 'because it still points at the pre-forgery seal')
  assert.equal(es[3]!.prev, es[2]!.attestation, 'entries past the seam remain internally linked…')
  assert.equal(r.count, 2, '…but replay validates only the 2 entries before the seam, of 4')
})

test('a re-sealed entry whose verdict does not follow from its factors is still rejected', () => {
  // This is the test that proves the product check earns its place. The forger here is
  // maximally capable: they edit the verdict, re-seal so the hash verifies, and place the
  // entry last so no prev-link is disturbed. The hash chain passes completely. Only
  // re-deriving Law × Evidence catches it. Without this check, "Truth = Law × Evidence"
  // would be a field an attacker — or an over-eager caller — simply writes down.
  const home = freshHome('forge')
  const real = lawful({ residual: ['citation.resolves'] })
  assert.equal(real.verdict, 'ZERO', 'honestly ZERO: undischarged residual')

  const forged = reseal({ ...real, verdict: 'POS' })
  fs.writeFileSync(logPath(home), JSON.stringify(forged) + '\n')

  // Confirm the forgery defeats the hash chain, so the next assertion is not vacuous.
  assert.equal(ledgerHash(bodyForTest(forged)), forged.attestation, 'the forged seal is self-consistent')
  assert.equal(forged.prev, 'genesis', 'and no prev-link is disturbed')

  const r = replayLedger()
  assert.equal(r.ok, false, 'a verdict that does not follow from its factors is not evidence')
  assert.equal(r.brokenAt, 0)
  assert.match(r.reason!, /does not follow from ZERO × POS = ZERO/)
})

test('entries predating the derived verdict are skipped, not failed', () => {
  // Honesty about history: a legacy entry carries no law/evidence fields, so its verdict
  // is unverifiable. Unverifiable is not the same as tampered, and reporting it as
  // tampered would make the checker cry wolf on every pre-existing ledger.
  const home = freshHome('legacy')
  const e = lawful()
  const { law: _l, evidence: _e, ...legacy } = e
  fs.writeFileSync(logPath(home), JSON.stringify(reseal(legacy as unknown as DispatchEntry)) + '\n')
  assert.deepEqual(replayLedger(), { ok: true, count: 1 })
})

test('a truncated or corrupt tail does not crash replay or poison the next append', () => {
  const home = freshHome('corrupt')
  lawful()
  fs.appendFileSync(logPath(home), '{"seq":1,"not-json\n')
  const r = replayLedger()
  assert.equal(r.ok, false, 'a corrupt line is reported, not swallowed')

  // And the writer recovers: rehydration tolerates the bad tail rather than throwing.
  freshHome('corrupt-2')
  assert.equal(lawful().prev, 'genesis')
})

test('the chain continues across a restart, and re-hydrates when the home moves', () => {
  const a = freshHome('restart-a')
  lawful(); lawful()
  const lastA = entries(a).at(-1)!

  // Move to a different home: a seat switch. The head must re-hydrate rather than
  // continue one ledger's chain onto another's head, which would write a prev-link
  // that replay cannot satisfy and would read as tampering.
  const b = freshHome('restart-b')
  const firstB = lawful()
  assert.equal(firstB.seq, 0, 'new home starts its own sequence')
  assert.equal(firstB.prev, 'genesis', 'and does NOT inherit the other ledger\'s head')
  assert.notEqual(firstB.prev, lastA.attestation)
  assert.deepEqual(replayLedger(), { ok: true, count: 1 })

  // Move back: the original chain resumes from its own persisted tail.
  process.env['NOETICA_HOME'] = a
  const resumed = lawful()
  assert.equal(resumed.seq, lastA.seq + 1, 'sequence resumes from disk')
  assert.equal(resumed.prev, lastA.attestation, 'and links to the persisted tail')
  assert.deepEqual(replayLedger(), { ok: true, count: 3 })
})

test('seq, ts and prev are inside the seal — an entry cannot be re-ordered or re-dated', () => {
  const home = freshHome('reorder')
  lawful()
  const e = entries(home)[0]!
  for (const mutation of [{ seq: 99 }, { ts: '1999-01-01T00:00:00.000Z' }, { prev: 'genesis-x' }]) {
    const { attestation: _a, evidenceTier: _t, ...body } = { ...e, ...mutation }
    assert.notEqual(ledgerHash(body), e.attestation,
      `mutating ${Object.keys(mutation)[0]} must break the seal`)
  }
})

test('contentHash is a SEAM-C digest: deterministic, sensitive, canonically prefixed', () => {
  assert.equal(contentHash('abc'), contentHash('abc'), 'deterministic')
  assert.notEqual(contentHash('abc'), contentHash('abd'), 'sensitive')
  assert.match(contentHash('abc'), /^sha256:[0-9a-f]{64}$/, 'and shaped so evidenceVerdict accepts it')
})

// ── cross-language conformance against the estate's shared vectors ──────────────
// The vectors live in sourceos-spec and are consumed by BOTH implementations: this one and
// prophet-platform's libs/python/lawful-verdict. Two implementations that each pass their
// own unit tests can still disagree with each other; only a shared vector set makes that
// detectable. Truth = Law × Evidence is estate governance, not a Noetica feature — Noetica
// is one conformant emitter, and this file is where it proves it.
//
// If sourceos-spec is not checked out these tests are SKIPPED WITH A LOUD REASON. They must
// never silently pass: a conformance suite reporting green when it never loaded the vectors
// converts an unknown into a false assurance, which is the defect class this whole change
// is about.

const VECTOR_CANDIDATES = [
  path.join(os.homedir(), 'dev', 'sourceos-spec', 'conformance', 'lawful-verdict-vectors.json'),
  path.resolve(process.cwd(), '..', '..', 'sourceos-spec', 'conformance', 'lawful-verdict-vectors.json'),
]

interface Vectors {
  product: { table: { law: Verdict; evidence: Verdict; verdict: Verdict }[]
             mustNotHold: { law: Verdict; evidence: Verdict; verdict: Verdict; why: string }[] }
  lawFactor: { barCleared: boolean; residual: string[]; expect: Verdict; why: string }[]
  evidenceFactor: { requestHash: string; answerHash: string; grounded: boolean; refuted?: boolean; expect: Verdict; why: string }[]
  tier: { lawSource: string; evidenceSource: string; expect: 'T1' | 'T2'; why: string }[]
}

function loadVectors(t: { skip: (m?: string) => void }): Vectors | null {
  for (const p of VECTOR_CANDIDATES) if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) as Vectors
  t.skip(`sourceos-spec conformance vectors not found — cross-language agreement is UNVERIFIED in this run. Looked in: ${VECTOR_CANDIDATES.join(', ')}`)
  return null
}

test('conformance: the product table matches the shared vectors exactly', (t) => {
  const v = loadVectors(t); if (!v) return
  assert.equal(v.product.table.length, 9, 'the product is total on a 3-element chain')
  for (const row of v.product.table) {
    assert.equal(truthProduct(row.law, row.evidence), row.verdict,
      `${row.law} × ${row.evidence} must be ${row.verdict}`)
  }
})

test('conformance: the sign-multiplication trap is pinned by the shared vectors', (t) => {
  const v = loadVectors(t); if (!v) return
  assert.ok(v.product.mustNotHold.length > 0, 'the vectors must carry the NEG × NEG counter-case')
  for (const bad of v.product.mustNotHold) {
    assert.notEqual(truthProduct(bad.law, bad.evidence), bad.verdict, bad.why)
  }
})

test('conformance: the Law factor matches the shared vectors', (t) => {
  const v = loadVectors(t); if (!v) return
  for (const row of v.lawFactor) {
    assert.equal(lawVerdict({ barCleared: row.barCleared, residual: row.residual }), row.expect, row.why)
  }
})

test('conformance: the Evidence factor matches the shared vectors', (t) => {
  const v = loadVectors(t); if (!v) return
  for (const row of v.evidenceFactor) {
    assert.equal(evidenceVerdict({
      requestHash: row.requestHash, answerHash: row.answerHash,
      grounded: row.grounded, ...(row.refuted === undefined ? {} : { refuted: row.refuted }),
    }), row.expect, row.why)
  }
})

test('conformance: the estate\'s sealed example receipt verifies under THIS canonicaliser', (t) => {
  // The cross-language seal test. sourceos-spec's example was sealed in one language and is
  // re-verified here; if canonical JSON disagreed by key order or whitespace this fails,
  // which is exactly what must be caught, since a receipt sealed by prophet-workspace has
  // to verify inside Noetica and vice versa.
  const candidates = VECTOR_CANDIDATES.map((p) =>
    path.join(path.dirname(path.dirname(p)), 'examples', 'lawful-dispatch-receipt.example.json'))
  const found = candidates.find((p) => fs.existsSync(p))
  if (!found) { t.skip('sourceos-spec example receipt not found — seal agreement UNVERIFIED'); return }

  const receipt = JSON.parse(fs.readFileSync(found, 'utf8')) as Record<string, unknown>
  const sealObj = receipt['seal'] as Record<string, unknown>
  const recorded = sealObj['attestation'] as string
  delete sealObj['attestation']
  assert.equal(ledgerHash(receipt), recorded, 'canonical-JSON seal must agree across languages')
})

// ── the tier is derived and sealed ──────────────────────────────────────────────

test('evidenceTier is DERIVED, not the literal T1 it used to be', () => {
  freshHome('tier')
  assert.equal(lawful().evidenceTier, 'T1', 'well-formed digests ⇒ instrumented')
  assert.equal(lawful({ answerHash: '' }).evidenceTier, 'T2', 'nothing captured is not instrumented')
  assert.equal(lawful({ requestHash: 'deadbeef' }).evidenceTier, 'T2', 'a malformed digest instruments nothing')
})

test('a forged tier upgrade is rejected even when the seal is recomputed', () => {
  // evidenceTier is inside the v2 seal, so editing it breaks the attestation; and even a
  // re-sealed forgery is caught by re-deriving the tier from the digests.
  const home = freshHome('tier-forge')
  const real = lawful({ answerHash: '' })
  assert.equal(real.evidenceTier, 'T2')

  const forged = reseal({ ...real, evidenceTier: 'T1' })
  fs.writeFileSync(logPath(home), JSON.stringify(forged) + '\n')
  const { attestation: _a, ...b } = forged
  assert.equal(ledgerHash(bodyForTest(forged)), forged.attestation, 'the forged seal is self-consistent')
  void b

  const r = replayLedger()
  assert.equal(r.ok, false, 'T1 without digests to instrument must be rejected')
  assert.match(r.reason!, /claims T1 without well-formed/)
})

test('v1 entries stay verifiable: the seal version selects the hashed body', () => {
  // Without the version branch, every pre-existing entry would recompute WITH evidenceTier
  // and report as tampered — a checker crying wolf on all of history.
  const home = freshHome('v1')
  const e = lawful()
  const { sealVersion: _sv, attestation: _a2, ...v1rest } = e
  const v1 = { ...v1rest, evidenceTier: 'T1' as const }
  const { evidenceTier: _et, ...v1body } = v1
  const legacy = { ...v1, attestation: ledgerHash(v1body) }   // v1 rule: tier outside the seal
  fs.writeFileSync(logPath(home), JSON.stringify(legacy) + '\n')
  assert.deepEqual(replayLedger(), { ok: true, count: 1 })
})

// ── adversarial: the primitive must fail loudly, and the read type must not lie ──

test('truthProduct throws on a non-verdict instead of returning undefined', () => {
  // A legacy JSONL row carries no `law`. The previous version silently produced `undefined`:
  // an unverdict that compares unequal to everything, and could be written back into a
  // ledger. TypeScript cannot prevent it reaching here through a cast or an untyped read, so
  // the primitive guards itself.
  for (const [l, e] of [[undefined, 'POS'], ['POS', undefined], [undefined, undefined], ['MAYBE', 'POS']]) {
    assert.throws(() => truthProduct(l as Verdict, e as Verdict), /not a verdict/,
      `truthProduct(${JSON.stringify(l)}, ${JSON.stringify(e)}) must throw`)
  }
  assert.equal(truthProduct('POS', 'POS'), 'POS', 'and still works on real input')
})

test('readDispatches types legacy rows honestly, and replay skips them', () => {
  // The type used to claim law/evidence were always present. They are not, and a consumer
  // trusting that claim would multiply undefined — which now throws, so the type has to be
  // right or the code cannot compile against it.
  const home = freshHome('stored')
  const modern = lawful()                       // v2: carries factors and a sealed tier
  const { law: _l, evidence: _ev, sealVersion: _sv, attestation: _a, ...rest } = modern
  // A correctly chained v1 successor: seq 1, prev = the v2 entry's attestation, and sealed
  // under the v1 rule (evidenceTier OUTSIDE the body). Chaining it properly matters — an
  // unchained row would fail on the prev-link and the legacy path would never be reached,
  // making this test pass for the wrong reason.
  const legacyBody = { ...rest, seq: 1, prev: modern.attestation, evidenceTier: 'T1' as const }
  const { evidenceTier: _et, ...v1Sealed } = legacyBody
  fs.appendFileSync(logPath(home),
    JSON.stringify({ ...legacyBody, attestation: ledgerHash(v1Sealed) }) + '\n')

  const rows = readDispatches()
  assert.equal(rows.length, 2, 'a real ledger is MIXED: v2 entries and legacy ones')
  assert.notEqual(rows[0]!.law, undefined, 'the v2 row has factors')
  assert.equal(rows[1]!.law, undefined, 'the legacy row genuinely has none')

  // The honest type forces this guard; without it truthProduct throws on the legacy row.
  const verdicts = rows.map((r) => (r.law !== undefined && r.evidence !== undefined)
    ? truthProduct(r.law, r.evidence) : null)
  assert.deepEqual(verdicts, ['POS', null], 'derived where derivable, null where not — never guessed')
  assert.deepEqual(replayLedger(), { ok: true, count: 2 },
    'replay verifies BOTH seals across the version boundary, checking the product only where it exists')
})

// ── the SEAL functions, pinned by the shared vectors ────────────────────────────
// Added after review found TWO cross-language divergences that every receipt-shaped test
// missed. The schema only checks that a digest is WELL-FORMED, and a wrong digest is still
// well-formed, so nothing above could detect that the digest function itself disagreed.

interface SealVectors {
  canonicalJson: { cases: { input: unknown; expected: string; why?: string }[] }
  contentHash: { cases: { input: string; expected: string; why?: string }[] }
}

test('conformance: canonicalJson matches the shared vectors, including non-ASCII', (t) => {
  const v = loadVectors(t) as unknown as SealVectors | null; if (!v) return
  const cases = v.canonicalJson.cases
  assert.ok(cases.some((c) => /[^\x00-\x7F]/.test(JSON.stringify(c.input))),
    'vectors must include a non-ASCII case or this cannot catch the ensure_ascii trap')
  for (const c of cases) {
    // ledgerHash canonicalises then hashes; compare the canonical FORM by re-deriving the
    // digest of the expected string, which is the only externally visible handle on it.
    assert.equal(ledgerHash(c.input), 'sha256:' + createHash('sha256').update(c.expected).digest('hex'),
      `${c.why ?? ''}: canonical form must be ${c.expected}`)
  }
})

test('conformance: contentHash matches the shared vectors', (t) => {
  const v = loadVectors(t) as unknown as SealVectors | null; if (!v) return
  for (const c of v.contentHash.cases) {
    assert.equal(contentHash(c.input), c.expected,
      `${c.why ?? ''}: contentHash(${JSON.stringify(c.input)})`)
  }
})

test('a dispatch carrying non-ASCII content seals reproducibly', () => {
  // The divergence's real consequence: a receipt that would not verify in another language
  // the moment it carried an accented character, CJK text or an emoji.
  const home = freshHome('non-ascii')
  const e = lawful({ requestHash: H('qué es la capital de España?'), answerHash: H('Madrid — 中文 🔒') })
  assert.equal(e.verdict, 'POS')
  assert.deepEqual(replayLedger(), { ok: true, count: 1 }, 'and it replays')
  assert.ok(!JSON.stringify(entries(home)[0]).includes('\\u00'),
    'the persisted form carries raw non-ASCII, not \\uXXXX escapes')
})

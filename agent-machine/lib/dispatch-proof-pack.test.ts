/**
 * Ledger-convergence (#35, migration 5/5): a DispatchEntry maps to the CANONICAL estate ProofPack.
 * Noetica has no ajv, so this does a compact structural conformance check against the vendored
 * canonical schema (required fields + enum membership + head pattern) — the fields the schema
 * load-bears on.
 */
import * as fs from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dispatchEntryToCanonicalProofPack } from './dispatch-proof-pack.js'
import type { DispatchEntry } from './dispatch-ledger.js'

// canonical schema vendored from prophet-core-contracts (commit 6e8a1647, sha256 bb581529…);
// `npm test` runs with cwd = agent-machine, so resolve relative to it (no import.meta).
const SCHEMA = JSON.parse(fs.readFileSync(join(process.cwd(), 'lib/fixtures/proof-pack.schema.json'), 'utf8'))

function structuralErrors(doc: Record<string, unknown>): string[] {
  const problems: string[] = []
  const props = SCHEMA.properties as Record<string, any>
  for (const key of SCHEMA.required as string[]) if (!(key in doc)) problems.push(`missing ${key}`)
  if (SCHEMA.additionalProperties === false) {
    for (const key of Object.keys(doc)) if (!(key in props)) problems.push(`unexpected ${key}`)
  }
  for (const p of ['claim_mode', 'epistemic_level']) {
    const e = props[p]?.enum as string[] | undefined
    if (e && !e.includes(doc[p] as string)) problems.push(`${p}=${doc[p]} not in enum`)
  }
  const ledger = doc.ledger as any
  if (!['blake3', 'blake2b', 'sha256'].includes(ledger?.algo)) problems.push('ledger.algo invalid')
  if (!/^[a-f0-9]{16,128}$/.test(ledger?.head ?? '')) problems.push('ledger.head not hex')
  if (!Array.isArray(doc.signatures) || (doc.signatures as unknown[]).length < 1) problems.push('signatures required')
  return problems
}

function entry(over: Partial<DispatchEntry> = {}): DispatchEntry {
  return {
    session: 'sess-1', requestHash: 'sha256:' + 'a'.repeat(64),
    action: 'answer', polarity: 'POS', tier: 'T1', target: 'local', phase: null,
    barCleared: true, residual: [],
    model: 'noetica-local', answerHash: 'sha256:' + 'b'.repeat(64), latencyMs: 42, grounded: true,
    law: 'POS', evidence: 'POS', verdict: 'POS',
    seq: 1, ts: '2026-08-03T00:00:00.000Z', prev: 'sha256:' + 'c'.repeat(64),
    attestation: 'sha256:' + 'd'.repeat(64), evidenceTier: 'T1',
    ...over,
  } as DispatchEntry
}

const opts = { signatures: ['did:key:z6Mk'] }

test('a POS dispatch maps to a schema-conformant bounded ProofPack', () => {
  const pack = dispatchEntryToCanonicalProofPack(entry(), opts)
  assert.deepEqual(structuralErrors(pack as unknown as Record<string, unknown>), [])
  assert.equal(pack.epistemic_level, 'bounded')
  assert.equal(pack.ledger.head, 'd'.repeat(64))
  assert.equal(pack.ledger.prior, 'c'.repeat(64))
  assert.ok(pack.proof_pack_id.startsWith('proofpack_'))
})

test('verdict maps onto the epistemic lattice (POS/ZERO/NEG)', () => {
  assert.equal(dispatchEntryToCanonicalProofPack(entry({ verdict: 'ZERO' }), opts).epistemic_level, 'speculative')
  assert.equal(dispatchEntryToCanonicalProofPack(entry({ verdict: 'NEG' }), opts).epistemic_level, 'rejected')
})

test('genesis prev is omitted (no prior link)', () => {
  const pack = dispatchEntryToCanonicalProofPack(entry({ prev: 'GENESIS' }), opts)
  assert.equal(pack.ledger.prior, undefined)
  assert.deepEqual(structuralErrors(pack as unknown as Record<string, unknown>), [])
})

test('law/evidence/grounded become checks', () => {
  const pack = dispatchEntryToCanonicalProofPack(entry({ law: 'NEG', evidence: 'ZERO', grounded: false }), opts)
  const byName = Object.fromEntries(pack.checks.map((c) => [c.name, c.passed]))
  assert.equal(byName.law, false)
  assert.equal(byName.evidence, false)
  assert.equal(byName.grounded, false)
})

test('an unsigned pack is unrepresentable', () => {
  assert.throws(() => dispatchEntryToCanonicalProofPack(entry(), { signatures: [] }), /signature/)
})

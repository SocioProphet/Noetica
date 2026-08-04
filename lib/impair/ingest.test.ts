/**
 * Ingestion is tested against REAL rig output — an actual CANNABIS dose sweep on
 * Qwen2.5-0.5B-Instruct, produced by noetica-impair on real trained weights. A
 * hand-written fixture would only prove the parser matches my assumptions about the
 * format, which is the assumption most likely to be wrong.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  ingestRunsJsonl, parseRunsJsonl, soberControl, toTrailEntries, verifyChain,
} from './ingest'

const FIXTURE = path.join(process.cwd(), 'tests/fixtures/impair/real-run-qwen25-0.5b.jsonl')
const raw = fs.readFileSync(FIXTURE, 'utf8')

test('parses real rig output', () => {
  const recs = parseRunsJsonl(raw)
  assert.equal(recs.length, 3, 'the fixture is a 3-point dose sweep')
  assert.equal(recs[0].model_key, 'qwen25-0.5b')
  assert.equal(recs[0].substance_preset, 'CANNABIS')
})

test('the real receipt chain verifies', () => {
  const v = verifyChain(parseRunsJsonl(raw))
  assert.ok(v.ok, v.reason)
  assert.equal(v.verified, 3)
})

test('a reordered chain is REJECTED', () => {
  // Tampering after the fact is exactly what the chain exists to catch.
  const recs = parseRunsJsonl(raw)
  const swapped = [recs[0], recs[2], recs[1]]
  const v = verifyChain(swapped)
  assert.equal(v.ok, false)
  assert.match(v.reason, /reordered|removed/)
})

test('a removed record is REJECTED', () => {
  const recs = parseRunsJsonl(raw)
  const v = verifyChain([recs[0], recs[2]])
  assert.equal(v.ok, false)
})

test('a record without a receipt is REJECTED', () => {
  const recs = parseRunsJsonl(raw)
  delete (recs[1] as { receipt?: unknown }).receipt
  assert.equal(verifyChain(recs).ok, false)
})

test('the sober control is the dose=0 run', () => {
  const s = soberControl(parseRunsJsonl(raw))
  assert.ok(s)
  assert.equal(s!.dose, 0)
  assert.equal(s!.faculty_vector?.competence, 1)
})

test('unverified evidence is surfaced as blocked, not hidden', () => {
  // Dropping tampered records would lose the single most important fact the trail
  // could show: that tampered evidence exists.
  const recs = parseRunsJsonl(raw)
  const { entries, chain } = toTrailEntries([recs[0], recs[2]])
  assert.equal(chain.ok, false)
  assert.ok(entries.length > 0, 'entries must still be produced')
  assert.ok(entries.every((e) => e.status === 'blocked'))
  assert.ok(entries.every((e) => e.content.startsWith('EVIDENCE NOT VERIFIED')))
})

test('trail entries carry the contract shape and the real receipt', () => {
  const { entries, chain } = ingestRunsJsonl(raw)
  assert.ok(chain.ok)
  const e = entries[0]
  assert.equal(e.schema_version, 'noetica.task.v0.1')
  assert.equal(e.status, 'success')
  assert.ok(e.evidence_ref?.startsWith('sha256:'), 'anchored to the rig receipt')
  assert.equal(e.chain_verified, true)
})

test('rendering evidence never upgrades policy_admitted', () => {
  // Noetica renders the trail; it does not admit anything. The tier-2 doctrine
  // declares no_public_claim_promotion, and a viewer is not a promoter.
  const { entries } = ingestRunsJsonl(raw)
  assert.ok(entries.every((e) => e.policy_admitted === false))
  assert.ok(entries.every((e) => e.memory_written === false))
  assert.ok(entries.every((e) => e.model_overridden === false))
})

test('the real run is reported as a COARSE LESION, not a dissociation', () => {
  // The measured result: on 0.5B weights, CANNABIS dropped fluency FASTER than
  // competence (gap -0.058 at d=0.8) — the opposite of the intoxicant signature. The
  // trail must say that rather than dress it up.
  const { entries } = ingestRunsJsonl(raw)
  const highest = entries[entries.length - 1]
  assert.match(highest.content, /coarse lesion, not a dissociation/)
})

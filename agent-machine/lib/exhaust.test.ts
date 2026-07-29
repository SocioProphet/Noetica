import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'noetica-exhaust-'))
process.env['NOETICA_HOME'] = HOME

import {
  hashOf, exhaustFromSelection, mineDiscards, recordExhaust, noteNeeded, exhaustReport, resetExhaust,
  type ExhaustRecord,
} from './exhaust.js'

const T0 = 1_800_000_000_000

test('a selection yields exactly the rejected items, by hash only', () => {
  const all = ['a', 'b', 'c', 'd']
  const rec = exhaustFromSelection(all, ['a', 'c'], (s) => s, { source: 'retrieval', now: T0 })
  assert.equal(rec.items!.length, 2)
  assert.deepEqual(rec.items!.map((i) => i.sha256).sort(), [hashOf('b'), hashOf('d')].sort())
  assert.equal(rec.counts.candidatesRejected, 2)
  assert.equal(rec.type, 'ExhaustRecord')
})

test('EX-I2: no payload ever appears in the record — only hashes and sizes', () => {
  const rec = exhaustFromSelection(['SECRET-PAYLOAD', 'kept'], ['kept'], (s) => s, { source: 'retrieval' })
  const serialized = JSON.stringify(rec)
  assert.ok(!serialized.includes('SECRET-PAYLOAD'), 'exhaust must not become an exfiltration channel')
  assert.ok(serialized.includes(hashOf('SECRET-PAYLOAD')), 'but the discard is still identifiable by hash')
})

test('bytes accounting gives the compression ratio', () => {
  const rec = exhaustFromSelection(['aaaa', 'bbbb'], ['aaaa'], (s) => s, { source: 'compaction' })
  assert.equal(rec.bytesIn, 8)
  assert.equal(rec.bytesOut, 4)
  assert.equal(mineDiscards([rec], []).compressionRatio, 0.5)
})

test('keeping everything discards nothing', () => {
  const all = ['x', 'y']
  const rec = exhaustFromSelection(all, all, (s) => s, { source: 'retrieval' })
  assert.equal(rec.items!.length, 0)
  assert.equal(rec.bytesIn, rec.bytesOut)
})

// ── the loop: exhaust → intake ──────────────────────────────────────────────────
test('an item discarded then LATER needed is a discard miss — the retrieval cut was wrong', () => {
  const rec = exhaustFromSelection(['keep', 'tossed'], ['keep'], (s) => s, { source: 'retrieval', now: T0 })
  const report = mineDiscards([rec], [{ sha256: hashOf('tossed'), at: T0 + 1000 }])
  assert.equal(report.discardMisses.length, 1)
  assert.equal(report.discardMisses[0]!.sha256, hashOf('tossed'))
  assert.equal(report.discardMissRate, 1, '1 of 1 discards was a mistake')
})

test('needing something BEFORE it was discarded is not a miss', () => {
  const rec = exhaustFromSelection(['keep', 'tossed'], ['keep'], (s) => s, { source: 'retrieval', now: T0 })
  const report = mineDiscards([rec], [{ sha256: hashOf('tossed'), at: T0 - 1000 }])
  assert.equal(report.discardMisses.length, 0, 'having it earlier is not evidence of a bad cut')
})

test('repeat misses rank first — which bad cut to fix is decided by how often it bites', () => {
  const rec = exhaustFromSelection(['a', 'b', 'keep'], ['keep'], (s) => s, { source: 'retrieval', now: T0 })
  const report = mineDiscards([rec], [
    { sha256: hashOf('a'), at: T0 + 10 },
    { sha256: hashOf('a'), at: T0 + 20 },
    { sha256: hashOf('a'), at: T0 + 30 },
    { sha256: hashOf('b'), at: T0 + 40 },
  ])
  assert.equal(report.discardMisses[0]!.sha256, hashOf('a'))
  assert.equal(report.discardMisses[0]!.repeats, 3)
  assert.equal(report.discardMisses[1]!.repeats, 1)
})

test('the earliest discard time is the one that counts', () => {
  const early: ExhaustRecord = exhaustFromSelection(['x', 'k'], ['k'], (s) => s, { source: 'retrieval', now: T0 })
  const late: ExhaustRecord = exhaustFromSelection(['x', 'k'], ['k'], (s) => s, { source: 'retrieval', now: T0 + 5000 })
  const report = mineDiscards([late, early], [{ sha256: hashOf('x'), at: T0 + 1000 }])
  assert.equal(report.discardMisses.length, 1, 'measured against the FIRST time we threw it away')
  assert.equal(report.discardMisses[0]!.discardedAt, T0)
})

test('no needs observed ⇒ no misses claimed, not zero-divided', () => {
  const rec = exhaustFromSelection(['a'], [], (s) => s, { source: 'retrieval' })
  const report = mineDiscards([rec], [])
  assert.equal(report.discardMisses.length, 0)
  assert.ok(Number.isFinite(report.discardMissRate))
})

test('an empty ledger reports honestly rather than dividing by zero', () => {
  const report = mineDiscards([], [])
  assert.equal(report.compressionRatio, 1)
  assert.equal(report.discardMissRate, 0)
  assert.equal(report.records, 0)
})

// ── persistence ─────────────────────────────────────────────────────────────────
test('the ledgers round-trip through disk and mine end-to-end', () => {
  resetExhaust()
  recordExhaust(exhaustFromSelection(['gone', 'stay'], ['stay'], (s) => s, { source: 'retrieval', now: T0 }))
  noteNeeded(['gone'], T0 + 1)
  const report = exhaustReport()
  assert.equal(report.records, 1)
  assert.equal(report.needsObserved, 1)
  assert.equal(report.discardMisses.length, 1, 'the loop closes across process boundaries')
})

test('recording never throws even when the home is unwritable — observability cannot fail a request', () => {
  const prev = process.env['NOETICA_HOME']
  process.env['NOETICA_HOME'] = '/proc/nonexistent-and-unwritable'
  try {
    recordExhaust(exhaustFromSelection(['a'], [], (s) => s, { source: 'retrieval' }))
    noteNeeded(['a'])
  } finally { process.env['NOETICA_HOME'] = prev }
})

test('a torn JSONL line is skipped, not fatal', () => {
  resetExhaust()
  recordExhaust(exhaustFromSelection(['gone', 'stay'], ['stay'], (s) => s, { source: 'retrieval', now: T0 }))
  fs.appendFileSync(path.join(HOME, 'exhaust.jsonl'), '{not json\n')
  assert.equal(exhaustReport().records, 1, 'the good line still counts')
})

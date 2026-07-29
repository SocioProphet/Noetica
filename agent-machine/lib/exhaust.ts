/**
 * exhaust — learning from what the system THREW AWAY.
 *
 * The gateway already seals what a compute consumed and produced (bytes_in/bytes_out,
 * exhaust_sha). This is the other half, and the half the design actually cared about: a
 * ledger of DISCARDED context, and a loop that mines it.
 *
 * The loop, concretely:
 *   1. Retrieval/compaction selects a few candidates from many. The rejected ones are exhaust.
 *   2. We record them by HASH only — never payloads (spec EX-I2). Exhaust must not become a
 *      second copy of the corpus, or a data-exfiltration channel.
 *   3. Later, something we DID use gets noted as "needed".
 *   4. Mining crosses the two: an item discarded at T and needed after T is a DISCARD MISS —
 *      direct evidence that the retrieval cut was wrong, with a repeat count that ranks which
 *      cuts to fix first.
 *
 * That is exhaust→intake: the waste stream becomes the tuning signal. Without step 4 the
 * ledger is just accounting; with it, throwing something away teaches the system where its
 * boundary is drawn badly.
 *
 * Storage is append-only JSONL under ~/.noetica, capped by line count — an observability
 * ledger must never become the thing that fills the disk.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { noeticaHome } from './local-state.js'

export type ExhaustSource = 'compute' | 'compaction' | 'retrieval' | 'deliberation'
export type ExhaustKind = 'chunk' | 'candidate' | 'tool_call' | 'context'

export interface ExhaustItem { kind: ExhaustKind; sha256: string; size?: number }

/** Conforms to sourceos-spec ExhaustRecord.json. */
export interface ExhaustRecord {
  type: 'ExhaustRecord'
  specVersion: string
  source: ExhaustSource
  counts: { chunksDropped?: number; candidatesRejected?: number; toolCallsRejected?: number; tokensDropped?: number }
  bytesIn: number
  bytesOut: number
  items?: ExhaustItem[]
  ts: number
}

export const SPEC_VERSION = '2.0'
const MAX_LINES = Number(process.env['NOETICA_EXHAUST_MAX_LINES'] || 5000)

export const hashOf = (s: string): string => createHash('sha256').update(s).digest('hex')

const exhaustPath = (): string => path.join(noeticaHome(), 'exhaust.jsonl')
const needsPath = (): string => path.join(noeticaHome(), 'exhaust-needs.jsonl')

function appendCapped(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, line + '\n')
  // cheap cap: rewrite only when we drift meaningfully past the limit
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  if (lines.length > MAX_LINES * 1.2) {
    fs.writeFileSync(file, lines.slice(-MAX_LINES).join('\n') + '\n')
  }
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return []
  const out: T[] = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line) as T) } catch { /* a torn line is not a reason to fail a request */ }
  }
  return out
}

/**
 * Build a record from a selection: everything in `all` that is not in `kept` was discarded.
 * `identify` maps an item to the stable string that gets hashed — retrieval ids, chunk text,
 * whatever the caller considers identity — so a later "needed" note can match it.
 */
export function exhaustFromSelection<T>(
  all: readonly T[], kept: readonly T[], identify: (t: T) => string,
  opts: { source: ExhaustSource; kind?: ExhaustKind; bytesIn?: number; bytesOut?: number; now?: number } ,
): ExhaustRecord {
  const keptIds = new Set(kept.map(identify))
  const dropped = all.filter((t) => !keptIds.has(identify(t)))
  const kind = opts.kind ?? 'candidate'
  const items: ExhaustItem[] = dropped.map((t) => {
    const id = identify(t)
    return { kind, sha256: hashOf(id), size: Buffer.byteLength(id) }
  })
  const bytesIn = opts.bytesIn ?? all.reduce((a, t) => a + Buffer.byteLength(identify(t)), 0)
  const bytesOut = opts.bytesOut ?? kept.reduce((a, t) => a + Buffer.byteLength(identify(t)), 0)
  const counts: ExhaustRecord['counts'] = kind === 'chunk'
    ? { chunksDropped: items.length }
    : kind === 'tool_call' ? { toolCallsRejected: items.length } : { candidatesRejected: items.length }
  return { type: 'ExhaustRecord', specVersion: SPEC_VERSION, source: opts.source, counts, bytesIn, bytesOut, items, ts: opts.now ?? Date.now() }
}

/** Persist a record. Never throws — observability must not be able to fail a request. */
export function recordExhaust(rec: ExhaustRecord): void {
  try { appendCapped(exhaustPath(), JSON.stringify(rec)) } catch { /* ignore */ }
}

/** Note that an identity was actually NEEDED. This is what makes mining possible. */
export function noteNeeded(identities: readonly string[], now = Date.now()): void {
  try {
    for (const id of identities) appendCapped(needsPath(), JSON.stringify({ sha256: hashOf(id), at: now }))
  } catch { /* ignore */ }
}

export interface DiscardMiss { sha256: string; discardedAt: number; neededAt: number; repeats: number }

export interface ExhaustReport {
  records: number
  bytesIn: number
  bytesOut: number
  /** bytesOut/bytesIn — the v1 entropy proxy. Lower = more aggressive compression. */
  compressionRatio: number
  itemsDiscarded: number
  needsObserved: number
  /** Items thrown away and later needed. The retrieval cut was wrong here. */
  discardMisses: DiscardMiss[]
  /** misses / itemsDiscarded — how often discarding was a mistake. THE tuning number. */
  discardMissRate: number
}

/**
 * Cross the two ledgers. A miss requires the need to come strictly AFTER the discard —
 * needing something we already had is not evidence of a bad cut.
 */
export function mineDiscards(
  records: readonly ExhaustRecord[],
  needs: ReadonlyArray<{ sha256: string; at: number }>,
): ExhaustReport {
  const discardedAt = new Map<string, number>()
  let itemsDiscarded = 0
  let bytesIn = 0
  let bytesOut = 0
  for (const r of records) {
    bytesIn += r.bytesIn
    bytesOut += r.bytesOut
    for (const it of r.items ?? []) {
      itemsDiscarded++
      const prev = discardedAt.get(it.sha256)
      if (prev === undefined || r.ts < prev) discardedAt.set(it.sha256, r.ts)
    }
  }

  const missBy = new Map<string, DiscardMiss>()
  for (const n of needs) {
    const dAt = discardedAt.get(n.sha256)
    if (dAt === undefined || n.at <= dAt) continue
    const ex = missBy.get(n.sha256)
    if (ex) { ex.repeats++; ex.neededAt = Math.min(ex.neededAt, n.at) }
    else missBy.set(n.sha256, { sha256: n.sha256, discardedAt: dAt, neededAt: n.at, repeats: 1 })
  }

  const discardMisses = [...missBy.values()].sort((a, b) => b.repeats - a.repeats)
  return {
    records: records.length, bytesIn, bytesOut,
    compressionRatio: bytesIn > 0 ? bytesOut / bytesIn : 1,
    itemsDiscarded, needsObserved: needs.length,
    discardMisses,
    discardMissRate: itemsDiscarded > 0 ? discardMisses.length / itemsDiscarded : 0,
  }
}

/** Mine the persisted ledgers — what GET /api/exhaust and the dream cycle consume. */
export function exhaustReport(): ExhaustReport {
  return mineDiscards(readJsonl<ExhaustRecord>(exhaustPath()), readJsonl<{ sha256: string; at: number }>(needsPath()))
}

/** Test/maintenance hook: drop both ledgers. */
export function resetExhaust(): void {
  for (const f of [exhaustPath(), needsPath()]) { try { fs.rmSync(f, { force: true }) } catch { /* ignore */ } }
}

/**
 * memory-bands — memory with TIME-SCALE structure instead of one flat store.
 *
 * This is orthogonal to memory-layers.ts, and the two compose:
 *   memory-layers → WHAT granularity a memory is (index pointer / topic doc / transcript)
 *   memory-bands  → HOW LONG it has earned the right to stay, and what it takes to survive
 *
 * Four bands by timescale, each with a survival window:
 *   session (L0) → daily (L1) → weekly (L2) → permanent (L3)
 *
 * A memory is not kept because it is recent, and not dropped because it is old. It is kept
 * because it keeps being NEEDED: recall reinforces it, and enough reinforcement inside its
 * window promotes it to a longer-lived band. Silence inside the window demotes it, and a
 * session-band memory that nothing ever recalled is pruned. That gives autoDream's Phase 4
 * ("prune (entropy control)") a principled basis — its default was a crude `score <= 0`,
 * which cannot distinguish "never mattered" from "not scored yet".
 *
 * The mechanism is deliberately the same shape as spaced repetition, because it is the same
 * problem: what deserves to be carried forward, and how often must something prove itself.
 *
 * Everything here is a pure function of (doc, now) so band decisions are testable and
 * explainable — no hidden clocks, no ambient state.
 */
import type { TopicDoc } from './memory-layers.js'

export type Band = 'session' | 'daily' | 'weekly' | 'permanent'

export const BANDS: Band[] = ['session', 'daily', 'weekly', 'permanent']

const HOUR = 3_600_000
const DAY = 24 * HOUR

/**
 * How long a memory may sit in a band without proving itself again.
 * Windows widen as bands lengthen: the longer something has survived, the more slack it earns.
 * `permanent` has no window — it has already paid for its place.
 */
export const BAND_WINDOW_MS: Record<Band, number> = {
  session: 12 * HOUR,
  daily: 7 * DAY,
  weekly: 30 * DAY,
  permanent: Number.POSITIVE_INFINITY,
}

/** Reinforcements required inside the window to earn the next band up. */
export const PROMOTION_THRESHOLD: Record<Band, number> = {
  session: 2,      // recalled twice in a session's life → it is not incidental
  daily: 3,
  weekly: 5,       // five separate weeks of use → permanent
  permanent: Number.POSITIVE_INFINITY,
}

/** Band bookkeeping, carried on the doc. All optional so existing docs stay valid. */
export interface BandedFields {
  band?: Band
  /** When the doc entered its current band (ms). Defaults to updatedAt. */
  bandSince?: number
  /** Recalls since entering the current band; reset on promotion/demotion. */
  reinforcements?: number
  /** Operator pin — exempt from decay entirely. A human said this matters. */
  pinned?: boolean
}

export type BandedDoc = TopicDoc & BandedFields

export const bandOf = (doc: BandedDoc): Band => doc.band ?? 'session'
const sinceOf = (doc: BandedDoc): number => doc.bandSince ?? doc.updatedAt
const reinforcementsOf = (doc: BandedDoc): number => doc.reinforcements ?? 0

const nextBand = (b: Band): Band => BANDS[Math.min(BANDS.indexOf(b) + 1, BANDS.length - 1)]!
const prevBand = (b: Band): Band => BANDS[Math.max(BANDS.indexOf(b) - 1, 0)]!

/** Record a recall. This is what makes the band system real rather than decorative — every
 *  read path that surfaces a memory should call it, so survival tracks actual usefulness. */
export function reinforce(doc: BandedDoc, now = Date.now()): BandedDoc {
  return {
    ...doc,
    band: bandOf(doc),
    bandSince: sinceOf(doc),
    reinforcements: reinforcementsOf(doc) + 1,
    updatedAt: now,
  }
}

export type BandVerdict =
  | { action: 'promote'; from: Band; to: Band; why: string }
  | { action: 'demote'; from: Band; to: Band; why: string }
  | { action: 'prune'; from: Band; why: string }
  | { action: 'hold'; band: Band; why: string }

/**
 * Decide a doc's fate. Pure: same (doc, now) always yields the same verdict, and every
 * verdict carries its reason — a memory should never vanish without an explainable cause.
 */
export function verdict(doc: BandedDoc, now = Date.now()): BandVerdict {
  const band = bandOf(doc)
  const reps = reinforcementsOf(doc)
  const age = now - sinceOf(doc)
  const window = BAND_WINDOW_MS[band]
  const need = PROMOTION_THRESHOLD[band]

  if (doc.pinned) return { action: 'hold', band, why: 'pinned by an operator — exempt from decay' }
  if (band === 'permanent') return { action: 'hold', band, why: 'permanent band has no window' }

  // Earned its way up: enough proven need, regardless of how much of the window is left.
  if (reps >= need) {
    return { action: 'promote', from: band, to: nextBand(band), why: `${reps} reinforcements ≥ ${need}` }
  }
  // Still inside its window — it has time left to prove itself.
  if (age <= window) {
    return { action: 'hold', band, why: `within ${band} window (${Math.round(age / HOUR)}h of ${Math.round(window / HOUR)}h)` }
  }
  // Window elapsed without enough use. Session-band memories that nothing ever recalled
  // are dropped; anything that once earned a longer band falls back one step instead of
  // being destroyed — demotion is a second chance, and only session-band failure is fatal.
  if (band === 'session' && reps === 0) {
    return { action: 'prune', from: band, why: 'session window elapsed with zero recalls' }
  }
  return { action: 'demote', from: band, to: prevBand(band), why: `window elapsed with ${reps}/${need} reinforcements` }
}

/** Apply a verdict, resetting band bookkeeping on any move. Returns null when pruned. */
export function applyVerdict(doc: BandedDoc, v: BandVerdict, now = Date.now()): BandedDoc | null {
  if (v.action === 'prune') return null
  if (v.action === 'hold') return doc
  return { ...doc, band: v.to, bandSince: now, reinforcements: 0 }
}

export interface BandSweepReport {
  promoted: number
  demoted: number
  pruned: number
  held: number
  /** Population per band AFTER the sweep — what /api/memory/bands reports. */
  counts: Record<Band, number>
  /** Every non-hold decision, with its reason. Consolidation must be auditable. */
  moves: Array<{ name: string; action: BandVerdict['action']; from: Band; to?: Band; why: string }>
}

/**
 * Sweep a working set: the band half of a consolidation pass. Returns survivors plus a
 * report. Designed to slot into autoDream Phase 4 (see bandPrune / bandSweepDeps).
 */
export function sweepBands(docs: BandedDoc[], now = Date.now()): { survivors: BandedDoc[]; report: BandSweepReport } {
  const counts: Record<Band, number> = { session: 0, daily: 0, weekly: 0, permanent: 0 }
  const report: BandSweepReport = { promoted: 0, demoted: 0, pruned: 0, held: 0, counts, moves: [] }
  const survivors: BandedDoc[] = []

  for (const doc of docs) {
    const v = verdict(doc, now)
    if (v.action !== 'hold') {
      report.moves.push({
        name: doc.name, action: v.action,
        from: v.action === 'prune' ? v.from : v.from,
        ...(v.action === 'promote' || v.action === 'demote' ? { to: v.to } : {}),
        why: v.why,
      })
    }
    if (v.action === 'promote') report.promoted++
    else if (v.action === 'demote') report.demoted++
    else if (v.action === 'prune') report.pruned++
    else report.held++

    const next = applyVerdict(doc, v, now)
    if (next) { survivors.push(next); counts[bandOf(next)]++ }
  }
  return { survivors, report }
}

/** Population by band without mutating anything — the read model for the API/Govern card. */
export function bandCounts(docs: BandedDoc[]): Record<Band, number> {
  const counts: Record<Band, number> = { session: 0, daily: 0, weekly: 0, permanent: 0 }
  for (const d of docs) counts[bandOf(d)]++
  return counts
}

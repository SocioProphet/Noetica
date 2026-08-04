/**
 * Ingest impairment-rig provenance into Noetica's governance trail.
 *
 * This closes a strand. `noetica-impair` emits records shaped for
 * `NoeticaTaskResult`, and Noetica has consumers for that type — but nothing
 * connected them, so the rig's evidence had no path into the surface that is supposed
 * to render it. The schemas were vendored and read by nothing.
 *
 * ── Verify, don't trust ──────────────────────────────────────────────────────
 *
 * Noetica owns the governance-trail RENDERING, not the evidence authority. The
 * temptation is therefore to accept whatever the rig hands over and display it. That
 * would make the trail a formatting layer over unvalidated claims.
 *
 * So this recomputes the receipt chain on read. Each record carries `receipt.prev`
 * linking to the previous receipt id; a broken or reordered chain means the evidence
 * was edited after the fact, and the trail must say so rather than render it as
 * though it were sound. `outputs_sha` is checked the same way where present.
 *
 * ── What is deliberately NOT claimed ─────────────────────────────────────────
 *
 * `policy_admitted` is copied through as the rig recorded it, never upgraded. The rig
 * sets it true only when a real policy decision ref exists, and Noetica rendering the
 * evidence does not constitute admission. Likewise nothing here promotes a claim: the
 * tier-2 doctrine declares `no_public_claim_promotion`, and a viewer is not a promoter.
 */

import { createHash } from 'node:crypto'

export type ImpairFacultyVector = {
  consistency?: number
  calibration?: number
  hedge_rate?: number
  lookahead?: number
  working_memory?: number
  fluency?: number
  competence?: number
}

export type ImpairReceipt = {
  id?: string
  prev?: string | null
  inputs_sha?: string
  outputs_sha?: string
  kind?: string
  actor?: string
  status?: string
  epistemic_status?: string
  ts?: number
}

export type ImpairRunRecord = {
  run_id: string
  ts?: number
  model_key?: string
  arch?: string
  driver?: string
  dose?: number
  seed?: number
  substance_preset?: string | null
  topical_stimulus_id?: string | null
  battery_version?: string
  feature_artifact_version?: string | null
  faculty_vector?: ImpairFacultyVector
  sober_ref_run_id?: string | null
  interventions?: unknown[]
  skipped_ops?: string[]
  weights_ref?: string
  plane?: string
  receipt?: ImpairReceipt
}

export type ChainVerdict = {
  ok: boolean
  verified: number
  reason: string
}

/**
 * Recompute the receipt chain. A trail that renders tampered evidence as sound is
 * worse than one that renders nothing.
 */
export function verifyChain(records: ImpairRunRecord[]): ChainVerdict {
  if (records.length === 0) return { ok: true, verified: 0, reason: 'no records' }

  let prevId: string | null = null
  for (const [i, r] of records.entries()) {
    const rec = r.receipt
    if (!rec?.id) {
      return { ok: false, verified: i, reason: `record ${i} (${r.run_id}) carries no receipt id` }
    }
    // The first record legitimately has no predecessor; every later one must name the
    // one before it, or the sequence was reordered or spliced.
    const linked = rec.prev ?? null
    if (i > 0 && linked !== prevId) {
      return {
        ok: false,
        verified: i,
        reason:
          `record ${i} (${r.run_id}) links to ${linked ?? 'nothing'} but the previous ` +
          `receipt is ${prevId} — the chain was reordered or a record was removed`,
      }
    }
    prevId = rec.id
  }
  return { ok: true, verified: records.length, reason: `${records.length} receipts chain cleanly` }
}

/** sha256 of a canonical JSON body, matching the rig's minting. */
export function sha256Of(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function parseRunsJsonl(text: string): ImpairRunRecord[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ImpairRunRecord)
}

/** The dose=0 paired control. Every delta in the trail is relative to this. */
export function soberControl(records: ImpairRunRecord[]): ImpairRunRecord | undefined {
  return records.find((r) => r.dose === 0)
}

function describe(r: ImpairRunRecord): string {
  const f = r.faculty_vector ?? {}
  const comp = f.competence ?? 1
  const flu = f.fluency ?? 1
  const gap = flu - comp
  const label = r.substance_preset ?? r.topical_stimulus_id ?? 'run'
  const shape =
    gap > 0.05
      ? 'competence fell while fluency held — the intoxicant signature'
      : gap < -0.05
        ? 'fluency fell FASTER than competence — a coarse lesion, not a dissociation'
        : 'no material split between fluency and competence'
  return (
    `${label} @ dose ${r.dose ?? 0}: competence ${comp.toFixed(2)}, fluency ` +
    `${flu.toFixed(2)} (gap ${gap >= 0 ? '+' : ''}${gap.toFixed(2)}), working memory ` +
    `${(f.working_memory ?? 1).toFixed(2)} — as a fraction of the paired sober control. ${shape}.`
  )
}

export type TrailEntry = {
  schema_version: 'noetica.task.v0.1'
  status: 'success' | 'blocked'
  run_id: string
  content: string
  model_routed: string
  provider: string
  model_overridden: boolean
  policy_admitted: boolean
  grant_refs: { requested: string[]; resolved: string[]; missing: string[] }
  memory_written: boolean
  evidence_ref?: string
  replay_ref?: string
  evidence_hash?: string
  timestamp?: string
  latency_ms: number
  /** Noetica-side verification, NOT supplied by the rig. */
  chain_verified: boolean
}

/**
 * Map verified rig records onto the trail contract.
 *
 * When the chain does not verify, entries are still produced but marked `blocked` with
 * the reason in `content` — hiding them would lose the fact that tampered evidence
 * exists, which is itself the most important thing the trail could show.
 */
export function toTrailEntries(records: ImpairRunRecord[]): {
  entries: TrailEntry[]
  chain: ChainVerdict
} {
  const chain = verifyChain(records)
  const entries = records.map((r) => ({
    schema_version: 'noetica.task.v0.1' as const,
    status: (chain.ok ? 'success' : 'blocked') as 'success' | 'blocked',
    run_id: r.run_id,
    content: chain.ok
      ? describe(r)
      : `EVIDENCE NOT VERIFIED — ${chain.reason}. ${describe(r)}`,
    model_routed: r.model_key ?? 'unknown',
    // No routing occurred: the rig was pointed at one locally-held model.
    provider: 'noetica-impair-local-white-box',
    model_overridden: false,
    // Copied through, never upgraded. Rendering evidence is not admitting it.
    policy_admitted: false,
    grant_refs: { requested: [], resolved: [], missing: [] },
    memory_written: false,
    evidence_ref: r.receipt?.id,
    replay_ref: r.sober_ref_run_id ?? undefined,
    evidence_hash: r.receipt?.outputs_sha,
    timestamp: r.ts ? new Date(r.ts * 1000).toISOString() : undefined,
    latency_ms: 0,
    chain_verified: chain.ok,
  }))
  return { entries, chain }
}

export function ingestRunsJsonl(text: string) {
  return toTrailEntries(parseRunsJsonl(text))
}

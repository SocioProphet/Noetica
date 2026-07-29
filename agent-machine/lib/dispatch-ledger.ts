/**
 * dispatch-ledger — §10.3 Evidence. The deterministic spine: every dispatch is a
 * content-addressed, hash-chained entry that REPLAYS. Truth = Law × Evidence — a
 * dispatch is lawful (POS@T1) iff its ledger entry recomputes to its recorded hash
 * and links to its predecessor. Tamper anywhere upstream diverges every downstream
 * attestation. Local-first: appends to ~/.noetica/ledger/dispatch.jsonl, no network.
 *
 * Records the Law side (the action/cell + the gate decision: did the fidelity bar
 * clear, with what residual) and the Evidence side (request + answer content hashes,
 * model, outcome), so the whole decision replays even though the generated text does
 * not — determinism of the DECISION, integrity of the record (§1.8, carried).
 */
import { ledgerHash } from './verb-sort.js'
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { readJsonl } from './jsonl.js'
import { noeticaHome } from './local-state.js'
import { join } from 'node:path'

// Resolved LAZILY through noeticaHome(), the single source of truth for local state
// (local-state.ts). This module previously computed its path once at import time from
// os.homedir() directly, which meant an operator running under a NOETICA_HOME override
// — sandbox, multi-seat, a rotated ledger — had every other module honour the override
// while the EVIDENCE ledger silently kept appending to the real ~/.noetica. Evidence
// written to the wrong ledger is worse than no evidence: it reads as a clean chain for
// a seat whose dispatches are elsewhere.
const ledgerDir = (): string => join(noeticaHome(), 'ledger')
const ledgerLog = (): string => join(ledgerDir(), 'dispatch.jsonl')
const GENESIS = 'genesis'

export type Verdict = 'NEG' | 'ZERO' | 'POS'

/**
 * Truth = Law × Evidence, with `×` given its precise meaning: the PRODUCT IN THE
 * VERDICT LATTICE. Order the verdicts by truth, NEG < ZERO < POS, and `×` is the
 * meet — equivalently strong-Kleene conjunction, equivalently `min`. Because a
 * three-element chain is a category, that meet *is* the categorical product, so the
 * equation is an identity rather than a slogan: Truth is the terminal cone over
 * {Law, Evidence}.
 *
 * It is NOT multiplication of signs in {-1, 0, +1}, which is the tempting reading and
 * is unsound: it makes NEG × NEG = POS, i.e. "the gate refused AND the outcome was
 * refuted" would certify as true. The lattice meet gives NEG, which is the only
 * defensible answer. `truthProductIsNotSignProduct` in the test suite pins this.
 *
 * The three cells that carry the product's whole value:
 *   POS × ZERO = ZERO   lawful but unevidenced — a claim we decline to make
 *   ZERO × POS = ZERO   evidenced but carrying undischarged constraints
 *   NEG × ZERO = NEG    a refusal stands without needing evidence to corroborate it
 */
const RANK: Record<Verdict, 0 | 1 | 2> = { NEG: 0, ZERO: 1, POS: 2 }
const BY_RANK: readonly Verdict[] = ['NEG', 'ZERO', 'POS']

export function truthProduct(law: Verdict, evidence: Verdict): Verdict {
  return BY_RANK[Math.min(RANK[law], RANK[evidence])]!
}

const SEALED = /^sha256:[0-9a-f]{64}$/

/** The Law factor, DERIVED from the gate decision — never asserted by the caller.
 *  Undischarged residual yields ZERO, not POS: a bar that "cleared" while carrying
 *  constraints it could not discharge has not established lawfulness, it has deferred. */
export function lawVerdict(i: { barCleared: boolean; residual: string[] }): Verdict {
  if (!i.barCleared) return 'NEG'
  return i.residual.length === 0 ? 'POS' : 'ZERO'
}

/** The Evidence factor, DERIVED from what the record actually contains. Absent or
 *  malformed content hashes are ZERO (no evidence), not NEG — nothing was refuted,
 *  nothing was shown. NEG requires an actual refutation, which only an external
 *  verifier can supply, hence `refuted` is the one factor input a caller may set. */
export function evidenceVerdict(i: {
  requestHash: string; answerHash: string; grounded: boolean; refuted?: boolean
}): Verdict {
  if (i.refuted) return 'NEG'
  if (!SEALED.test(i.requestHash) || !SEALED.test(i.answerHash)) return 'ZERO'
  return i.grounded ? 'POS' : 'ZERO'
}

export interface DispatchInput {
  session: string
  requestHash: string                       // SEAM-C hash of (user content + context snapshot)
  action: string; polarity: string          // the tangent vector
  tier: string; target: string; phase: string | null // route + MeshRush phase
  barCleared: boolean; residual: string[]   // the gate decision (Law)
  model: string; answerHash: string; latencyMs: number; grounded: boolean // outcome (Evidence)
  refuted?: boolean                         // set only by a verifier that CONTRADICTED the outcome
}
export interface DispatchEntry extends DispatchInput {
  // law/evidence are recorded, not just their product, so an auditor can re-derive the
  // verdict and see WHICH factor failed. A bare verdict is unfalsifiable; the factors
  // make it checkable, and replayLedger() checks them.
  law: Verdict; evidence: Verdict; verdict: Verdict
  seq: number; ts: string; prev: string; attestation: string; evidenceTier: 'T1'
}

// In-memory chain head, rehydrated from disk so the chain continues across restarts.
// `loadedFrom` records WHICH log the head was hydrated from, not merely that it was:
// the path is now resolved lazily, so it can legitimately change within one process
// (a seat switch, a sandbox, a rotated ledger). Keying on the path makes the head
// self-healing — it re-hydrates when the target moves, instead of continuing to append
// one ledger's chain onto another's head, which would produce a prev-link that replay
// cannot satisfy and would read as tampering.
let head: { seq: number; hash: string; loadedFrom: string | null } =
  { seq: 0, hash: GENESIS, loadedFrom: null }

function rehydrate(): void {
  const log = ledgerLog()
  if (head.loadedFrom === log) return
  head = { seq: 0, hash: GENESIS, loadedFrom: log }
  try {
    if (!existsSync(log)) return
    const lines = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    if (lines.length === 0) return
    const last = JSON.parse(lines[lines.length - 1]!) as DispatchEntry
    head = { seq: last.seq + 1, hash: last.attestation, loadedFrom: log }
  } catch { /* start fresh on a corrupt tail */ }
}

/** The hashed body = every field that defines the decision, INCLUDING seq/ts/prev, and
 *  excluding only the attestation itself and the evidence tier. Sequence and timestamp
 *  are inside the seal deliberately: an entry that could be re-ordered or re-dated
 *  without breaking its own hash would let a chain be silently rewritten in place. */
function bodyOf(e: Omit<DispatchEntry, 'attestation' | 'evidenceTier'>): unknown {
  const { attestation: _a, evidenceTier: _t, ...body } = e as DispatchEntry
  return body
}

/** Record a dispatch, chained to the predecessor. Returns the attested entry.
 *
 *  The verdict is DERIVED here, from the two factors, and is deliberately not an input.
 *  It used to be: `DispatchInput.verdict` was a caller-supplied field, and the only
 *  production caller passed the literal `'POS'` on every dispatch. Truth = Law × Evidence
 *  was stated in this file's own docstring and computed nowhere — the framework's central
 *  claim was the estate's own declared-but-unenforced pattern, sitting at dead centre.
 *  Removing the field is the fix: there is now no way to assert a verdict, only to earn
 *  one, and `replayLedger` recomputes the product to catch a hand-edited entry. */
export function recordDispatch(input: DispatchInput): DispatchEntry {
  rehydrate()
  const law = lawVerdict(input)
  const evidence = evidenceVerdict(input)
  const base = {
    ...input, law, evidence, verdict: truthProduct(law, evidence),
    seq: head.seq, ts: new Date().toISOString(), prev: head.hash,
  }
  const attestation = ledgerHash(bodyOf(base as unknown as DispatchEntry))
  const entry: DispatchEntry = { ...base, attestation, evidenceTier: 'T1' }
  try {
    mkdirSync(ledgerDir(), { recursive: true })
    appendFileSync(ledgerLog(), JSON.stringify(entry) + '\n')
  } catch { /* best-effort persistence */ }
  head = { seq: head.seq + 1, hash: attestation, loadedFrom: ledgerLog() }
  return entry
}

export interface ReplayResult { ok: boolean; count: number; brokenAt?: number; reason?: string }

/** Replay the chain: recompute each attestation from its body + prev, and verify the
 *  prev-link. ok ⇒ the whole ledger is POS@T1 (deterministic + tamper-evident). */
export function replayLedger(): ReplayResult {
  const log = ledgerLog()
  if (!existsSync(log)) return { ok: true, count: 0 }
  let prev = GENESIS, count = 0
  try {
    const lines = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    for (const line of lines) {
      const e = JSON.parse(line) as DispatchEntry
      if (e.prev !== prev) return { ok: false, count, brokenAt: e.seq, reason: 'prev-link mismatch' }
      const recomputed = ledgerHash(bodyOf(e))
      if (recomputed !== e.attestation) return { ok: false, count, brokenAt: e.seq, reason: 'attestation mismatch (tampered)' }
      // Re-derive Truth = Law × Evidence. The hash chain proves the record was not
      // altered after the fact; it cannot prove the verdict followed from its factors
      // at write time. Entries predating the derived verdict carry no `law` field and
      // are skipped rather than failed — they are unverifiable, which is honest, not
      // broken. Anything claiming both factors must satisfy the product.
      if (e.law !== undefined && e.evidence !== undefined) {
        const derived = truthProduct(e.law, e.evidence)
        if (e.verdict !== derived) {
          return { ok: false, count, brokenAt: e.seq,
            reason: `verdict ${e.verdict} does not follow from ${e.law} × ${e.evidence} = ${derived}` }
        }
      }
      prev = e.attestation
      count++
    }
    return { ok: true, count }
  } catch (err) {
    return { ok: false, count, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** SEAM-C convenience: content hash of a string (request/answer bodies). */
export function contentHash(s: string): string { return ledgerHash(s) }

/** Read recorded dispatch entries (most-recent `limit`) — e.g. for energy accounting. */
export function readDispatches(limit = 10_000): DispatchEntry[] {
  return readJsonl<DispatchEntry>(ledgerLog(), { limit })
}

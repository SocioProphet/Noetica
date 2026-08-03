/**
 * dispatch-proof-pack — map a DispatchEntry onto the CANONICAL estate ProofPack
 * (prophet-core-contracts proof-pack.schema.json) — ledger-convergence migration (#35, 5/5).
 *
 * The dispatch attestation hash becomes ledger.head (prev → ledger.prior when it is a real
 * hash, not genesis); the Truth = Law × Evidence verdict maps onto the sp-core epistemic lattice
 * (POS → bounded, ZERO → speculative, NEG → rejected); law/evidence/grounded become checks. The
 * caller supplies signatures (>=1) — an unsigned canonical pack is unrepresentable.
 */
import type { DispatchEntry, Verdict } from './dispatch-ledger.js'

const SEALED = /^sha256:([0-9a-f]{64})$/

const VERDICT_TO_EPISTEMIC: Record<Verdict, string> = {
  POS: 'bounded',
  ZERO: 'speculative',
  NEG: 'rejected',
}

export interface CanonicalProofPack {
  schema_version: '0.1.0'
  proof_pack_id: string
  subject_ref: { ref_type: string; ref_id: string; uri?: string }
  claim_mode: string
  epistemic_level: string
  ledger: { algo: 'sha256'; head: string; prior?: string }
  checks: { name: string; passed: boolean }[]
  evidence_refs: string[]
  signatures: string[]
  provenance: Record<string, unknown>
  created_at: string
}

function hex(sealed: string): string {
  const m = SEALED.exec(sealed)
  return m ? m[1] : sealed
}

export function dispatchEntryToCanonicalProofPack(
  entry: DispatchEntry,
  opts: { signatures: string[]; createdAt?: string; claimMode?: string },
): CanonicalProofPack {
  if (!opts.signatures.length || opts.signatures.some((s) => !s)) {
    throw new Error('a canonical ProofPack requires >=1 non-empty signature')
  }
  const head = hex(entry.attestation)
  const pack: CanonicalProofPack = {
    schema_version: '0.1.0',
    proof_pack_id: 'proofpack_' + head,
    subject_ref: { ref_type: 'dispatch', ref_id: entry.action },
    claim_mode: opts.claimMode ?? 'experimental',
    epistemic_level: VERDICT_TO_EPISTEMIC[entry.verdict] ?? 'speculative',
    ledger: { algo: 'sha256', head },
    checks: [
      { name: 'law', passed: entry.law === 'POS' },
      { name: 'evidence', passed: entry.evidence === 'POS' },
      { name: 'grounded', passed: !!entry.grounded },
    ],
    evidence_refs: [entry.requestHash, entry.answerHash].filter(Boolean),
    signatures: [...opts.signatures],
    provenance: { producer: 'noetica.agent-machine.dispatch-ledger', model: entry.model, verdict: entry.verdict },
    created_at: opts.createdAt ?? entry.ts,
  }
  if (SEALED.test(entry.prev)) pack.ledger.prior = hex(entry.prev)
  return pack
}

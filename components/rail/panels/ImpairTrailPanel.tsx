'use client'

import { useEffect, useState } from 'react'

/**
 * The impairment rig's evidence, rendered in the governance trail.
 *
 * Design constraint carried over from the ingester: this surface RENDERS evidence, it
 * does not vouch for it. So the chain verdict is shown first and unverified runs are
 * marked rather than hidden — a trail that quietly drops tampered records would lose
 * the single most important thing it could tell you.
 *
 * Tufte-wise this is deliberately plain: hairline rules rather than boxes-in-boxes,
 * one colour used only where it signals (an unverified chain, or a run whose fluency
 * fell faster than competence), and the retained fractions printed unscaled so the
 * numbers are honest.
 */

type TrailEntry = {
  run_id: string
  content: string
  model_routed: string
  status: string
  evidence_ref?: string
  chain_verified: boolean
}

type Payload = {
  entries: TrailEntry[]
  chain: { ok: boolean; verified: number; reason: string }
  source: string | null
  error?: string
}

export function ImpairTrailPanel() {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/impair/runs')
      .then(async (r) => {
        const body = (await r.json()) as Payload
        if (cancelled) return
        // 409 means the chain did not verify — that is DATA, not a failure to show.
        if (!r.ok && r.status !== 409) throw new Error(body.error || `HTTP ${r.status}`)
        setData(body)
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [])

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--color-border-secondary)] px-4 py-3">
        <div className="text-xs font-semibold text-[#1d4ed8]">Impairment evidence</div>
        <div className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
          Dose-response runs from noetica-impair
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loading && (
          <div className="text-xs text-[var(--color-text-tertiary)]">Reading provenance…</div>
        )}

        {error && (
          <div className="text-xs text-[#a03c28]">Could not read the trail: {error}</div>
        )}

        {data && (
          <>
            {/* The verdict comes first: you should not read a run before knowing
                whether its evidence verified. */}
            <div
              className={`rounded-xl border px-3 py-2.5 text-xs ${
                data.chain.ok
                  ? 'border-[var(--color-border-secondary)] bg-[var(--color-background-secondary)] text-[var(--color-text-secondary)]'
                  : 'border-[#a03c28] text-[#a03c28]'
              }`}
            >
              <span className="font-semibold">
                {data.chain.ok ? 'Receipt chain verified' : 'EVIDENCE NOT VERIFIED'}
              </span>
              <div className="mt-0.5 text-[var(--color-text-tertiary)]">{data.chain.reason}</div>
            </div>

            {data.entries.length === 0 && (
              <div className="pt-2 text-xs text-[var(--color-text-tertiary)] text-center">
                No runs recorded yet. Evidence appears here once the rig writes a
                runs.jsonl.
              </div>
            )}

            {data.entries.map((e) => {
              // Colour only where it signals: a run the rig itself called a coarse
              // lesion is the one worth noticing.
              const coarse = /coarse lesion/.test(e.content)
              return (
                <div
                  key={e.run_id}
                  className="border-t border-[var(--color-border-secondary)] pt-2.5 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[10px] text-[var(--color-text-tertiary)]">
                      {e.run_id}
                    </span>
                    <span className="text-[10px] text-[var(--color-text-tertiary)]">
                      {e.model_routed}
                    </span>
                  </div>
                  <div
                    className={`mt-1 leading-relaxed ${
                      coarse ? 'text-[#8a5a2b]' : 'text-[var(--color-text-secondary)]'
                    }`}
                  >
                    {e.content}
                  </div>
                  {e.evidence_ref && (
                    <div className="mt-1 font-mono text-[10px] text-[var(--color-text-tertiary)]">
                      {e.evidence_ref.slice(0, 26)}…
                    </div>
                  )}
                </div>
              )
            })}

            {data.source && (
              <div className="pt-2 font-mono text-[10px] text-[var(--color-text-tertiary)]">
                source: ~/{data.source}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

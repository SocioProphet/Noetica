'use client'

import { useEffect, useState } from 'react'

interface MeshArmResult { arm: string; pass: number; total: number; avgLatencyMs: number }
interface MeshProofArtifact { results?: MeshArmResult[]; artifactFile?: string; artifactAt?: number; error?: string }

/**
 * Cloud Mesh Proof — head-to-head evidence that the local mesh matches frontier models.
 *
 * PARKED: self-contained card evicted from GovernSurface. Rendered nowhere yet, but
 * compiles as an exported component. Owns its own mesh-proof state, mount-fetch, and
 * run handler. The agent-machine URL helper is injected via the `amUrl` prop so the
 * card stays decoupled from any particular bridge implementation.
 */
export function MeshProofCard({ amUrl }: { amUrl: (path: string) => string }) {
  const [meshProof, setMeshProof] = useState<MeshProofArtifact | null>(null)
  const [meshRunning, setMeshRunning] = useState(false)

  useEffect(() => {
    // Cloud mesh proof — latest benchmark artifact (mesh-vs-frontier)
    fetch(amUrl('/api/benchmark/mesh'), { signal: AbortSignal.timeout(5000) })
      .then(r => r.ok ? r.json() : null)
      .then((d: MeshProofArtifact | null) => { if (d && !d.error) setMeshProof(d) })
      .catch(() => { /* not running — skip */ })
  }, [amUrl])

  async function runMeshProof(n: number) {
    setMeshRunning(true)
    try {
      await fetch(amUrl('/api/benchmark/mesh'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ n }),
      })
      // Poll for completion — harness takes ~n*0.6s; cap at 3 polls of 8s each
      for (let i = 0; i < 3; i++) {
        await new Promise<void>(r => setTimeout(r, 8000))
        const poll = await fetch(amUrl('/api/benchmark/mesh'), { signal: AbortSignal.timeout(4000) })
        if (poll.ok) {
          const d = await poll.json() as MeshProofArtifact
          if (d && !d.error) { setMeshProof(d); break }
        }
      }
    } catch { /* best-effort */ }
    finally { setMeshRunning(false) }
  }

  return (
    <div className="rounded-2xl border border-[var(--color-border-tertiary)] bg-[var(--color-background-primary)] p-5 shadow-sm">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold text-[#7c3aed]">Cloud Mesh Proof</div>
          <div className="mt-0.5 text-[11px] text-[var(--color-text-tertiary)] leading-relaxed">
            Head-to-head coding benchmark — mesh vs GPT / Claude on 25 real problems. Run it in front of a client.
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button
            onClick={() => void runMeshProof(20)}
            disabled={meshRunning}
            className="rounded-lg border border-[#ddd6fe] bg-[#f5f3ff] px-2.5 py-1 text-[11px] font-semibold text-[#6d28d9] transition hover:bg-[#ede9fe] disabled:opacity-50"
          >
            {meshRunning ? 'Running…' : 'Run 20-q'}
          </button>
          <button
            onClick={() => void runMeshProof(25)}
            disabled={meshRunning}
            className="rounded-lg border border-[#ddd6fe] bg-[#f5f3ff] px-2.5 py-1 text-[11px] font-semibold text-[#6d28d9] transition hover:bg-[#ede9fe] disabled:opacity-50"
          >
            {meshRunning ? '…' : 'Full 25-q'}
          </button>
        </div>
      </div>
      {meshProof && meshProof.results && meshProof.results.length > 0 ? (
        <div>
          <div className="mb-2 space-y-1.5">
            {meshProof.results.map(arm => (
              <div key={arm.arm} className="flex items-center gap-3">
                <span className="w-32 shrink-0 truncate text-[11px] font-medium text-[var(--color-text-secondary)]">{arm.arm}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-background-tertiary)]">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${arm.total > 0 ? (arm.pass / arm.total) * 100 : 0}%`,
                      background: arm.arm.startsWith('mesh') ? '#7c3aed' : '#94a3b8',
                    }}
                  />
                </div>
                <span className="w-16 shrink-0 text-right font-mono text-[11px] font-semibold tabular-nums text-[var(--color-text-primary)]">
                  {arm.pass}/{arm.total}
                </span>
                <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
                  {arm.avgLatencyMs > 0 ? `${(arm.avgLatencyMs / 1000).toFixed(1)}s` : '—'}
                </span>
              </div>
            ))}
          </div>
          {meshProof.artifactFile && (
            <div className="mt-2 text-[11px] text-[var(--color-text-tertiary)]">
              {meshProof.artifactFile}{meshProof.artifactAt ? ` · ${new Date(meshProof.artifactAt).toLocaleString()}` : ''}
            </div>
          )}
        </div>
      ) : (
        <div className="text-[11px] text-[var(--color-text-tertiary)]">
          {meshRunning
            ? 'Harness running — results appear here when done (poll every 8s).'
            : 'No artifact yet — click Run to execute the benchmark suite. Results persist to disk.'}
        </div>
      )}
    </div>
  )
}

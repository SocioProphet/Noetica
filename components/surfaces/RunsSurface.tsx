'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * BACKGROUND TASKS — a calm list of recent async agent runs.
 *
 * HONEST data source: the agent-machine governance ring (`/api/governance/recent`
 * + the `/api/governance/stream` SSE `run` events). Every completed turn and every
 * dispatched sub-agent closes a GovernanceRun with model, latency, tokens, and a
 * pass/fail signal — that IS the "background agent runs" substrate. We do NOT invent
 * a jobs table or reuse the hardwired Intelligence demo dataset.
 *
 * Runs land here at CLOSE, so there is no live "running…" spinner to fake — each row
 * is a finished run with a real outcome (done · failed · blocked). Tufte-calm:
 * blue (--color-accent) = done, pink (--color-attention) = failed/blocked, grey = meta.
 */

interface AgentRun {
  run_id: string
  model_routed: string
  provider: string
  policy_admitted: boolean
  memory_written: boolean
  timestamp: string
  latency_ms: number
  input_tokens?: number
  output_tokens?: number
  cost_usd?: number
  tokens_egressed?: number
  task?: string
  session_id?: string
  error?: string
}

type RunStatus = 'done' | 'failed' | 'blocked'
type StatusFilter = 'all' | RunStatus

function amUrl(path: string): string {
  const isTauri = typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  return isTauri ? `http://127.0.0.1:8080${path}` : path
}

function statusOf(r: AgentRun): RunStatus {
  if (r.error) return 'failed'
  if (!r.policy_admitted) return 'blocked'
  return 'done'
}

// Runs are labelled by their opener: `turn:<intent>`, `subagent:<role>: <task>`,
// `tool:<name>`. Split that into a kind chip + a human label.
function kindOf(task: string | undefined): { kind: string; label: string } {
  const t = (task ?? '').trim()
  if (!t) return { kind: 'Run', label: 'chat turn' }
  if (t.startsWith('subagent:')) return { kind: 'Sub-agent', label: t.slice('subagent:'.length).trim() || 'dispatched' }
  if (t.startsWith('turn:')) return { kind: 'Turn', label: t.slice('turn:'.length).trim() || 'chat turn' }
  if (t.startsWith('tool:')) return { kind: 'Tool', label: t.slice('tool:'.length).trim() || 'tool call' }
  return { kind: 'Run', label: t }
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${Math.max(0, s)}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const STATUS_STYLE: Record<RunStatus, { dot: string; text: string; label: string }> = {
  done:    { dot: 'var(--color-accent)',    text: 'text-[var(--color-accent)]',    label: 'Done' },
  failed:  { dot: 'var(--color-attention)', text: 'text-[var(--color-attention)]', label: 'Failed' },
  blocked: { dot: 'var(--color-text-tertiary)', text: 'text-[var(--color-text-tertiary)]', label: 'Blocked' },
}

export function RunsSurface() {
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [loaded, setLoaded] = useState(false)
  const [live, setLive] = useState(false)
  const [filter, setFilter] = useState<StatusFilter>('all')
  // Re-render every 30s so the relative timestamps stay honest without refetching.
  const [, setTick] = useState(0)
  const seen = useRef<Set<string>>(new Set())

  function ingest(list: AgentRun[]) {
    setRuns((prev) => {
      const map = new Map(prev.map((r) => [r.run_id, r]))
      for (const r of list) map.set(r.run_id, r)
      for (const r of list) seen.current.add(r.run_id)
      return [...map.values()].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, 100)
    })
  }

  // Initial history from the ring buffer.
  useEffect(() => {
    let cancelled = false
    fetch(amUrl('/api/governance/recent?limit=100'), { signal: AbortSignal.timeout(4000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { runs?: AgentRun[] } | null) => {
        if (cancelled) return
        if (d?.runs?.length) ingest(d.runs)
      })
      .catch(() => { /* agent-machine not running — empty state handles it */ })
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [])

  // Live tail — the same SSE feed the control-plane audit uses. New runs stream in as they close.
  useEffect(() => {
    let es: EventSource | null = null
    try {
      es = new EventSource(amUrl('/api/governance/stream'))
      es.addEventListener('ready', () => setLive(true))
      es.addEventListener('run', (ev) => {
        try {
          const run = JSON.parse((ev as MessageEvent).data) as AgentRun
          if (run?.run_id) ingest([run])
        } catch { /* skip malformed frame */ }
      })
      es.onerror = () => setLive(false)
    } catch { /* EventSource unavailable — poll-only, still fine */ }
    return () => { es?.close() }
  }, [])

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  const counts = useMemo(() => {
    const c = { all: runs.length, done: 0, failed: 0, blocked: 0 } as Record<StatusFilter, number>
    for (const r of runs) c[statusOf(r)]++
    return c
  }, [runs])

  const avgLatency = useMemo(() => {
    if (runs.length === 0) return 0
    return Math.round(runs.reduce((s, r) => s + (r.latency_ms ?? 0), 0) / runs.length)
  }, [runs])

  const visible = filter === 'all' ? runs : runs.filter((r) => statusOf(r) === filter)

  const FILTERS: { id: StatusFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'done', label: 'Done' },
    { id: 'failed', label: 'Failed' },
    { id: 'blocked', label: 'Blocked' },
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
      <div className="mx-auto w-full max-w-3xl space-y-4">

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-base font-semibold text-[var(--color-text-primary)]">Background tasks</h1>
            <p className="mt-0.5 text-[11px] leading-tight text-[var(--color-text-tertiary)]">
              Recent async agent runs — chat turns, dispatched sub-agents & tool calls, newest first.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 pt-1">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: live ? 'var(--color-accent)' : 'var(--color-text-tertiary)' }}
              aria-hidden
            />
            <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
              {live ? 'Live' : 'Idle'}
            </span>
          </div>
        </div>

        {/* Summary strip */}
        <div className="grid grid-cols-4 gap-2">
          {([
            ['Runs', counts.all, 'var(--color-text-primary)'],
            ['Done', counts.done, 'var(--color-accent)'],
            ['Failed', counts.failed, 'var(--color-attention)'],
            ['Avg latency', avgLatency ? `${avgLatency.toLocaleString()}ms` : '—', 'var(--color-text-primary)'],
          ] as const).map(([label, value, color]) => (
            <div key={label} className="rounded-xl border border-[var(--color-border-tertiary)] bg-[var(--color-background-primary)] px-3 py-2">
              <div className="text-[9px] font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]">{label}</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums" style={{ color }}>{value}</div>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`rounded-full border px-2.5 py-0.5 text-[10px] font-medium transition ${
                filter === f.id
                  ? 'border-[var(--color-border-secondary)] bg-[var(--color-background-secondary)] text-[var(--color-text-primary)]'
                  : 'border-[var(--color-border-tertiary)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
              }`}
            >
              {f.label}
              <span className="ml-1 tabular-nums text-[var(--color-text-tertiary)]">{counts[f.id]}</span>
            </button>
          ))}
        </div>

        {/* List */}
        {!loaded ? (
          <div className="py-16 text-center text-[11px] text-[var(--color-text-tertiary)]">Loading runs…</div>
        ) : runs.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--color-border-tertiary)] py-16 text-center">
            <div className="text-[12px] font-medium text-[var(--color-text-secondary)]">No background runs yet</div>
            <div className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">
              Runs appear here after the first chat turn or dispatched sub-agent. Requires the agent machine to be running.
            </div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-[var(--color-border-tertiary)] bg-[var(--color-background-primary)]">
            <ul className="divide-y divide-[var(--color-border-tertiary)]">
              {visible.map((r) => {
                const st = statusOf(r)
                const style = STATUS_STYLE[st]
                const { kind, label } = kindOf(r.task)
                const tokens = (r.input_tokens ?? 0) + (r.output_tokens ?? 0)
                return (
                  <li key={r.run_id} className="flex items-center gap-3 px-4 py-2.5">
                    {/* Status dot */}
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: style.dot }} aria-hidden />

                    {/* Kind + label */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 rounded-full bg-[var(--color-background-secondary)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)]">
                          {kind}
                        </span>
                        <span className="truncate text-[12px] text-[var(--color-text-primary)]" title={label}>{label}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--color-text-tertiary)]">
                        <span className="truncate font-mono" title={r.model_routed}>{r.model_routed.split('/').pop() ?? r.model_routed}</span>
                        {r.error && (
                          <span className="truncate text-[var(--color-attention)]" title={r.error}>· {r.error}</span>
                        )}
                      </div>
                    </div>

                    {/* Metrics */}
                    <div className="hidden shrink-0 items-center gap-3 text-[10px] tabular-nums text-[var(--color-text-tertiary)] sm:flex">
                      <span className="w-16 text-right" title="latency">{(r.latency_ms ?? 0).toLocaleString()}ms</span>
                      <span className="w-16 text-right" title="tokens (in + out)">{tokens ? `${tokens.toLocaleString()} tok` : '—'}</span>
                    </div>

                    {/* Status + time */}
                    <div className="flex w-20 shrink-0 flex-col items-end">
                      <span className={`text-[10px] font-semibold ${style.text}`}>{style.label}</span>
                      <span className="text-[9px] text-[var(--color-text-tertiary)]">{timeAgo(r.timestamp)}</span>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {loaded && runs.length > 0 && (
          <p className="text-[10px] text-[var(--color-text-tertiary)]">
            Last {runs.length} runs from the on-device governance ring · sovereign, nothing leaves the machine.
          </p>
        )}
      </div>
    </div>
  )
}

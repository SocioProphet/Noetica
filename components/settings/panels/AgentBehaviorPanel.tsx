'use client'

import { useEffect, useState } from 'react'
import { amUrl } from '@/lib/tauri/bridge'

/**
 * Agent behavior — runtime toggles evicted from the Govern surface. These flip live
 * agent-machine behavior: Best-of-N sampling, the uncertainty gate, procedural-memory
 * distillation, plan-mode approvals, and hardened (least-privilege) execution.
 *
 * The first four persist through POST /api/settings; hardened execution binds the
 * containment purpose through POST /api/containment. All are best-effort — an offline
 * agent-machine leaves the toggles in their default (off) state.
 */
export function AgentBehaviorPanel() {
  const [bonEnabled, setBonEnabled]                     = useState(false)
  const [bonToggling, setBonToggling]                   = useState(false)
  const [uncertaintyEnabled, setUncertaintyEnabled]     = useState(false)
  const [uncertaintyToggling, setUncertaintyToggling]   = useState(false)
  const [proceduralEnabled, setProceduralEnabled]       = useState(false)
  const [proceduralToggling, setProceduralToggling]     = useState(false)
  const [planModeEnabled, setPlanModeEnabled]           = useState(false)
  const [planModeToggling, setPlanModeToggling]         = useState(false)
  const [hardenedExec, setHardenedExec]                 = useState(false)
  const [hardenedToggling, setHardenedToggling]         = useState(false)

  useEffect(() => {
    // Runtime settings (Best-of-N / uncertainty / procedural / plan-mode toggle state)
    fetch(amUrl('/api/settings'), { signal: AbortSignal.timeout(3000) })
      .then(r => r.ok ? r.json() : null)
      .then((d: { bonEnabled?: boolean; uncertaintyEnabled?: boolean; proceduralEnabled?: boolean; planModeEnabled?: boolean } | null) => {
        if (d) {
          if (typeof d.bonEnabled === 'boolean') setBonEnabled(d.bonEnabled)
          if (typeof d.uncertaintyEnabled === 'boolean') setUncertaintyEnabled(d.uncertaintyEnabled)
          if (typeof d.proceduralEnabled === 'boolean') setProceduralEnabled(d.proceduralEnabled)
          if (typeof d.planModeEnabled === 'boolean') setPlanModeEnabled(d.planModeEnabled)
        }
      })
      .catch(() => { /* not running — skip */ })
    // Hardened execution — bound containment purpose (research/read-only = hardened)
    fetch(amUrl('/api/containment'), { signal: AbortSignal.timeout(3000) })
      .then((r) => r.ok ? r.json() as Promise<{ purpose?: string }> : null)
      .then((d) => { if (d?.purpose) setHardenedExec(d.purpose === 'research' || d.purpose === 'read-only') })
      .catch(() => { /* best-effort */ })
  }, [])

  async function toggleBon() {
    setBonToggling(true)
    try {
      const r = await fetch(amUrl('/api/settings'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bonEnabled: !bonEnabled }),
      })
      if (r.ok) { const d = await r.json() as { bonEnabled: boolean }; setBonEnabled(d.bonEnabled) }
    } catch { /* best-effort */ }
    finally { setBonToggling(false) }
  }

  async function toggleUncertainty() {
    setUncertaintyToggling(true)
    try {
      const r = await fetch(amUrl('/api/settings'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uncertaintyEnabled: !uncertaintyEnabled }),
      })
      if (r.ok) { const d = await r.json() as { uncertaintyEnabled: boolean }; setUncertaintyEnabled(d.uncertaintyEnabled) }
    } catch { /* best-effort */ }
    finally { setUncertaintyToggling(false) }
  }

  async function toggleProcedural() {
    setProceduralToggling(true)
    try {
      const r = await fetch(amUrl('/api/settings'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proceduralEnabled: !proceduralEnabled }),
      })
      if (r.ok) { const d = await r.json() as { proceduralEnabled: boolean }; setProceduralEnabled(d.proceduralEnabled) }
    } catch { /* best-effort */ }
    finally { setProceduralToggling(false) }
  }

  async function togglePlanMode() {
    setPlanModeToggling(true)
    try {
      const r = await fetch(amUrl('/api/settings'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planModeEnabled: !planModeEnabled }),
      })
      if (r.ok) { const d = await r.json() as { planModeEnabled: boolean }; setPlanModeEnabled(d.planModeEnabled) }
    } catch { /* best-effort */ }
    finally { setPlanModeToggling(false) }
  }

  // Hardened execution — binds the agent's containment purpose to least-privilege 'research' (no shell,
  // no file-writes) so a prompt-injected run_command/code_execute/write_file is denied by the purpose
  // gate. 'full' restores unrestricted local action. Uses the existing /api/containment bind endpoint.
  async function toggleHardenedExec() {
    setHardenedToggling(true)
    try {
      const r = await fetch(amUrl('/api/containment'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'bind', purpose: hardenedExec ? 'full' : 'research' }),
      })
      if (r.ok) { const d = await r.json() as { purpose?: string }; setHardenedExec(d.purpose === 'research' || d.purpose === 'read-only') }
    } catch { /* best-effort */ }
    finally { setHardenedToggling(false) }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-[var(--color-text-secondary)]">
        Runtime behavior toggles applied by the agent-machine. Changes take effect on the next turn.
      </p>

      {/* Best-of-N runtime toggle */}
      <div className="rounded-2xl border border-[var(--color-border-tertiary)] bg-[var(--color-background-primary)] p-5 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-[#1d4ed8]">Best-of-N selection</div>
            <div className="mt-0.5 text-[11px] text-[var(--color-text-tertiary)] leading-relaxed">
              Samples N=3 candidates for low-confidence turns and picks the strongest grounded response.
            </div>
          </div>
          <button
            onClick={() => void toggleBon()}
            disabled={bonToggling}
            className={`shrink-0 rounded-full px-3 py-1 text-[11px] font-semibold transition disabled:opacity-50 ${bonEnabled ? 'bg-[#1d4ed8] text-white hover:bg-[#1e40af]' : 'border border-[var(--color-border-primary)] text-[var(--color-text-secondary)] hover:border-[#1d4ed8] hover:text-[#1d4ed8]'}`}
          >
            {bonToggling ? '…' : bonEnabled ? 'Enabled' : 'Disabled'}
          </button>
        </div>
        <div className="text-[11px] text-[var(--color-text-tertiary)]">
          {bonEnabled ? 'Active — low-confidence turns will sample 3 completions and select the best.' : 'Off — single-sample path. Enable to improve response quality on ambiguous prompts.'}
        </div>
      </div>

      {/* Uncertainty gate runtime toggle */}
      <div className="rounded-2xl border border-[var(--color-border-tertiary)] bg-[var(--color-background-primary)] p-5 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-[#0891b2]">Uncertainty gate</div>
            <div className="mt-0.5 text-[11px] text-[var(--color-text-tertiary)] leading-relaxed">
              Appends a calibrated low-confidence disclaimer when semantic entropy indicates the model is guessing.
            </div>
          </div>
          <button
            onClick={() => void toggleUncertainty()}
            disabled={uncertaintyToggling}
            className={`shrink-0 rounded-full px-3 py-1 text-[11px] font-semibold transition disabled:opacity-50 ${uncertaintyEnabled ? 'bg-[#0891b2] text-white hover:bg-[#0e7490]' : 'border border-[var(--color-border-primary)] text-[var(--color-text-secondary)] hover:border-[#0891b2] hover:text-[#0891b2]'}`}
          >
            {uncertaintyToggling ? '…' : uncertaintyEnabled ? 'Enabled' : 'Disabled'}
          </button>
        </div>
        <div className="text-[11px] text-[var(--color-text-tertiary)]">
          {uncertaintyEnabled ? 'Active — responses with high semantic entropy will carry a hedge or abstention notice.' : 'Off — no abstention overlay. Enable to surface genuine knowledge gaps rather than confident hallucinations.'}
        </div>
      </div>

      {/* Procedural memory (loop 2+3) runtime toggle */}
      <div className="rounded-2xl border border-[var(--color-border-tertiary)] bg-[var(--color-background-primary)] p-5 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-[var(--color-accent)]">Procedural memory</div>
            <div className="mt-0.5 text-[11px] text-[var(--color-text-tertiary)] leading-relaxed">
              Distills successful turns into reusable skills (loop 2) and enrolls them in spaced-repetition review (loop 3).
            </div>
          </div>
          <button
            onClick={() => void toggleProcedural()}
            disabled={proceduralToggling}
            className={`shrink-0 rounded-full px-3 py-1 text-[11px] font-semibold transition disabled:opacity-50 ${proceduralEnabled ? 'bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent)]' : 'border border-[var(--color-border-primary)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]'}`}
          >
            {proceduralToggling ? '…' : proceduralEnabled ? 'Enabled' : 'Disabled'}
          </button>
        </div>
        <div className="text-[11px] text-[var(--color-text-tertiary)]">
          {proceduralEnabled
            ? 'Active — high-quality turns are being distilled into the skill library and scheduled for SRS review.'
            : 'Off — only eval-capture (failures) is running. Enable to start compounding the skill library.'}
        </div>
      </div>

      {/* Plan mode — citizen-controlled approve-before-act gate (EU AI Act Art.14) */}
      <div className={`rounded-2xl border p-5 shadow-sm transition ${planModeEnabled ? 'border-[rgba(220,38,38,0.35)] bg-[rgba(220,38,38,0.03)]' : 'border-[var(--color-border-tertiary)] bg-[var(--color-background-primary)]'}`}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className={`text-xs font-semibold ${planModeEnabled ? 'text-[#dc2626]' : 'text-[var(--color-text-tertiary)]'}`}>Plan mode</div>
            <div className="mt-0.5 text-[11px] text-[var(--color-text-secondary)]">Require step-by-step approval before any action executes.</div>
          </div>
          <button
            onClick={() => void togglePlanMode()}
            disabled={planModeToggling}
            className={`shrink-0 rounded-full px-3 py-1 text-[11px] font-semibold transition disabled:opacity-50 ${planModeEnabled ? 'bg-[#dc2626] text-white hover:bg-[#b91c1c]' : 'border border-[var(--color-border-primary)] text-[var(--color-text-secondary)] hover:border-[#dc2626] hover:text-[#dc2626]'}`}
          >
            {planModeToggling ? '…' : planModeEnabled ? 'Enabled' : 'Disabled'}
          </button>
        </div>
        <div className="text-[11px] text-[var(--color-text-tertiary)]">
          {planModeEnabled
            ? 'On — every turn the agent proposes a numbered step plan; no tool executes until you approve. High-oversight mode (EU AI Act Art.14).'
            : 'Off — agent executes immediately. Enable to require an approve-before-act proposal for every action.'}
        </div>
      </div>

      {/* Hardened execution — least-privilege containment: block shell + file-writes (injection backstop) */}
      <div className={`rounded-2xl border p-5 shadow-sm transition ${hardenedExec ? 'border-[rgba(124,58,237,0.35)] bg-[rgba(124,58,237,0.03)]' : 'border-[var(--color-border-tertiary)] bg-[var(--color-background-primary)]'}`}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className={`text-xs font-semibold ${hardenedExec ? 'text-[#7c3aed]' : 'text-[var(--color-text-tertiary)]'}`}>Hardened execution</div>
            <div className="mt-0.5 text-[11px] text-[var(--color-text-secondary)]">Bind the agent to least-privilege — no shell, no file-writes. Blocks a prompt-injected command from ever executing.</div>
          </div>
          <button
            onClick={() => void toggleHardenedExec()}
            disabled={hardenedToggling}
            className={`shrink-0 rounded-full px-3 py-1 text-[11px] font-semibold transition disabled:opacity-50 ${hardenedExec ? 'bg-[#7c3aed] text-white hover:bg-[#6d28d9]' : 'border border-[var(--color-border-primary)] text-[var(--color-text-secondary)] hover:border-[#7c3aed] hover:text-[#7c3aed]'}`}
          >
            {hardenedToggling ? '…' : hardenedExec ? 'Enabled' : 'Disabled'}
          </button>
        </div>
        <div className="text-[11px] text-[var(--color-text-tertiary)]">
          {hardenedExec
            ? 'On — the agent runs read/search/reason only (purpose: research). run_command, code_execute, and file-writes are denied until you disable this or explicitly elevate the session.'
            : 'Off — the agent has full local capability. Enable to neutralize the indirect-injection → RCE/exfil path (web search still works).'}
        </div>
      </div>
    </div>
  )
}

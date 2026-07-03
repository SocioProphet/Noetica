'use client'

import type { ActiveSurface } from '@/lib/types/surface'

/**
 * COMMAND CENTERS — the organizing spine for the left panel.
 *
 * DRAFT / PROPOSAL (2026-07-03). Not yet wired into <Sidebar>. This models the
 * two-axis cockpit lesson borrowed from SocioProphet client-vue
 * (src/config/{cockpitNav,routeRegistry,domainRoutes}.ts) and Will's 2019
 * reference (willdvlpr-socioprophet .../components/Top.js):
 *
 *   DOMAIN axis      = which command center you're in  (Tier 1 — leftmost rail)
 *   CAPABILITY axis  = that center's tools/surfaces     (Tier 2 — labeled panel)
 *   CENTER           = the active surface
 *
 * We borrow the *mechanism* (data-driven registry + navTier + maturity so
 * nothing is a dead link), NOT their analyst taxonomy (News/Law/Economy/Markets).
 * Noetica is an operator/builder product, so our domains are the command centers
 * Michael named: Cloud/DevSecOps, AI & Model Ops, Data & DataOps, Analytics —
 * plus the core Workspace and cross-cutting Govern.
 */

export type CommandCenterId =
  | 'workspace'   // chat-first collaboration & authoring — the "work"
  | 'workstation' // Local-first dev — Gitea repos, Porter deploys, local GitOps (THE foundation)
  | 'data'        // Data & DataOps — corpus, canon, ingestion, knowledge graph
  | 'ai'          // AI & Model Ops — studio, eval, tuning, boards, agents
  | 'cloud'       // Cloud & DevSecOps — LATER: off-machine, only after local DevSecOps exists
  | 'analytics'   // Analytics — dashboards, benchmarks, telemetry
  | 'govern'      // Govern — policy, alignment, evidence (cross-cutting)

/**
 * Where a surface appears. Borrowed from client-vue's NavTier
 * ('top' | 'left-rail' | 'tab-only' | 'hidden').
 *   primary   — shown in the command-center panel by default
 *   secondary — shown, but below the fold / in a "more" section
 *   tab       — folds into another surface as a tab (not its own panel row)
 *   hidden    — registered (route resolves) but not listed
 */
export type NavTier = 'primary' | 'secondary' | 'tab' | 'hidden'

/**
 * Build state. Borrowed from client-vue's L0–L5 maturity + status.
 *   live    — real, wired to a backend
 *   beta    — works, rough edges
 *   soon    — scaffolded surface, mock/"coming soon" panel (no dead link)
 *   planned — named gap, not yet a surface
 */
export type Maturity = 'live' | 'beta' | 'soon' | 'planned'

export interface CommandCenter {
  id: CommandCenterId
  /** rail label (Tier 1) */
  label: string
  /** one-line "what this center is for" — shown as the panel subtitle */
  blurb: string
}

export interface NavSurface {
  /** existing ActiveSurface id, or a string id for a not-yet-built gap */
  id: ActiveSurface | string
  label: string
  center: CommandCenterId
  tier: NavTier
  maturity: Maturity
  /** true if `id` is NOT yet a real ActiveSurface (a gap to build) */
  gap?: boolean
  /** if this surface folds into another as a tab, the host surface id */
  foldsInto?: ActiveSurface
}

export const COMMAND_CENTERS: CommandCenter[] = [
  { id: 'workspace',   label: 'Workspace', blurb: 'Chat, canvas, notes & rooms — where the work happens' },
  { id: 'workstation', label: 'Workstation', blurb: 'Local-first dev — Gitea repos, Porter deploys, local GitOps' },
  { id: 'data',        label: 'Data',      blurb: 'Corpus, canon, ingestion & the knowledge graph' },
  { id: 'ai',          label: 'AI · Models', blurb: 'Studio, evaluation, tuning, boards & agents' },
  { id: 'cloud',       label: 'Cloud · DevSecOps', blurb: 'Off-machine — comes AFTER local DevSecOps is real' },
  { id: 'analytics',   label: 'Analytics', blurb: 'Dashboards, benchmarks & telemetry' },
  { id: 'govern',      label: 'Govern',    blurb: 'Policy, alignment & evidence — across every center' },
]

/**
 * The registry. Existing surfaces are mapped to a home command center; named
 * gaps (gap:true, maturity:'planned') mark what each center still needs so we
 * can scaffold "coming soon" panels rather than leave empty columns.
 *
 * Ambiguous placements are flagged inline — these are the calls to settle
 * against Michael's screens.
 */
export const NAV_SURFACES: NavSurface[] = [
  // ── Workspace ──────────────────────────────────────────────────────────
  { id: 'chat',       label: 'Workspace',   center: 'workspace', tier: 'primary',   maturity: 'live' },
  { id: 'canvas',     label: 'Canvas',      center: 'workspace', tier: 'primary',   maturity: 'live' },
  { id: 'notes',      label: 'Notes',       center: 'workspace', tier: 'primary',   maturity: 'live' },
  { id: 'cowork',     label: 'Cowork',      center: 'workspace', tier: 'primary',   maturity: 'live' },
  { id: 'workrooms',  label: 'Workrooms',   center: 'workspace', tier: 'primary',   maturity: 'live' },
  { id: 'jitsi',      label: 'Video',       center: 'workspace', tier: 'tab',       maturity: 'live', foldsInto: 'workrooms' },
  { id: 'calendar',   label: 'Calendar',    center: 'workspace', tier: 'secondary', maturity: 'beta' },
  { id: 'docs',       label: 'Documents',   center: 'workspace', tier: 'secondary', maturity: 'beta' }, // ? office suite — could be Data
  { id: 'projects',   label: 'Projects',    center: 'workspace', tier: 'secondary', maturity: 'live' }, // ? PM — could be its own Build center

  // ── Data & DataOps ─────────────────────────────────────────────────────
  { id: 'library',    label: 'Library',     center: 'data', tier: 'primary',   maturity: 'live' },
  { id: 'artifacts',  label: 'Artifacts',   center: 'data', tier: 'primary',   maturity: 'live' },
  { id: 'workspace',  label: 'Project Files', center: 'data', tier: 'secondary', maturity: 'live' },
  { id: 'code',       label: 'Source',      center: 'data', tier: 'secondary', maturity: 'live' }, // ? repos — could be Cloud/DevSecOps
  { id: 'ingest',     label: 'Ingestion',   center: 'data', tier: 'primary',   maturity: 'planned', gap: true },
  { id: 'connectors', label: 'Connectors',  center: 'data', tier: 'primary',   maturity: 'planned', gap: true },
  { id: 'kg',         label: 'Knowledge Graph', center: 'data', tier: 'primary', maturity: 'planned', gap: true },
  { id: 'canon',      label: 'Canon · Corpus',  center: 'data', tier: 'primary', maturity: 'planned', gap: true },

  // ── AI & Model Ops ─────────────────────────────────────────────────────
  { id: 'studio',     label: 'Studio',      center: 'ai', tier: 'primary',   maturity: 'live' },
  { id: 'evaluate',   label: 'Evaluate',    center: 'ai', tier: 'primary',   maturity: 'live' },
  { id: 'rag',        label: 'RAG Inspector', center: 'ai', tier: 'tab',     maturity: 'live', foldsInto: 'studio' },
  { id: 'lab',        label: 'Capabilities', center: 'ai', tier: 'tab',      maturity: 'live', foldsInto: 'studio' },
  { id: 'tune',       label: 'Tune & Train', center: 'ai', tier: 'primary',  maturity: 'live' },
  { id: 'agents',     label: 'Agents',      center: 'ai', tier: 'secondary', maturity: 'beta' },
  { id: 'boards',     label: 'Boards',      center: 'ai', tier: 'primary',   maturity: 'planned', gap: true }, // frontier/MMLU boards
  { id: 'registry',   label: 'Model Registry', center: 'ai', tier: 'secondary', maturity: 'planned', gap: true },

  // ── Cloud & DevSecOps ──────────────────────────────────────────────────
  { id: 'broker',     label: 'Cloud Broker', center: 'cloud', tier: 'primary',   maturity: 'live' },
  { id: 'platform',   label: 'Platform',     center: 'cloud', tier: 'primary',   maturity: 'soon' },
  { id: 'marketplace', label: 'Marketplace', center: 'cloud', tier: 'secondary', maturity: 'soon' },
  { id: 'operate',    label: 'Operate',      center: 'cloud', tier: 'primary',   maturity: 'live' },
  { id: 'computer',   label: 'Computer Use', center: 'cloud', tier: 'tab',       maturity: 'beta', foldsInto: 'operate' },
  { id: 'deploys',    label: 'Deployments',  center: 'cloud', tier: 'primary',   maturity: 'planned', gap: true }, // CI/CD, GKE/ArgoCD
  { id: 'security',   label: 'Security',     center: 'cloud', tier: 'primary',   maturity: 'planned', gap: true }, // DevSecOps posture, global-devsecops-intelligence
  { id: 'secrets',    label: 'Secrets',      center: 'cloud', tier: 'secondary', maturity: 'planned', gap: true },

  // ── Analytics ──────────────────────────────────────────────────────────
  { id: 'analytics',  label: 'Dashboards',   center: 'analytics', tier: 'primary', maturity: 'planned', gap: true },
  { id: 'benchmark',  label: 'Benchmarks',   center: 'analytics', tier: 'primary', maturity: 'planned', gap: true }, // intelligence-superiority
  { id: 'geo',        label: 'Geo',          center: 'analytics', tier: 'secondary', maturity: 'beta' },
  { id: 'telemetry',  label: 'Telemetry',    center: 'analytics', tier: 'secondary', maturity: 'planned', gap: true },

  // ── Govern (cross-cutting) ─────────────────────────────────────────────
  { id: 'govern',     label: 'Govern',      center: 'govern', tier: 'primary', maturity: 'live' },
  { id: 'alignment',  label: 'Alignment',   center: 'govern', tier: 'primary', maturity: 'beta' },
  { id: 'holographme', label: 'HolographMe', center: 'govern', tier: 'secondary', maturity: 'beta' },
]

/** All surfaces for a given command center, in registry order. */
export function surfacesFor(center: CommandCenterId): NavSurface[] {
  return NAV_SURFACES.filter((s) => s.center === center)
}

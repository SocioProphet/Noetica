/**
 * config-plane — sovereign feature flags and kill-switches.
 *
 * The capability a shipped client needs and Noetica had none of: change behaviour, stage a
 * rollout, or disable a broken capability WITHOUT cutting a release. Every fix previously
 * required a full build → publish → user-upgrade cycle (and, with a moving image tag, might
 * never reach the user at all).
 *
 * What makes this ours rather than a copy of the industry pattern:
 *
 *  1. LOCAL OVERRIDE WINS. Precedence is
 *        local override file  >  environment  >  remote cache  >  built-in default.
 *     An operator can always countermand the fleet on their own machine. A remote plane that
 *     could not be overridden locally would contradict the entire product.
 *  2. EVERY DECISION IS EXPLAINABLE. `explain()` names the deciding layer and the age of the
 *     evidence. Opaque booleans are exactly the "declared but unenforceable" shape we refuse.
 *  3. OFFLINE-FIRST, FAIL-SOFT. Flags are read from a stamped local cache; refresh is
 *     best-effort and never blocks a request. No network, no problem — the last known good
 *     snapshot governs, and its age is visible.
 *  4. NO THIRD-PARTY FLAG SAAS. The plane is served by our own admin API.
 *
 * Cache entries are scoped (app, model, org) and timestamped, so a snapshot can never be
 * silently mistaken for a fresher or differently-scoped one.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { noeticaHome } from './local-state.js'

export type FlagValue = boolean | number | string

export interface FlagScope { app: string; model?: string; org?: string }

export interface FlagSnapshot {
  flags: Record<string, FlagValue>
  /** Per-model kill-switches: `false` disables that model everywhere in the app. */
  models: Record<string, boolean>
  fetchedAt: string
  source: string
  scope: FlagScope
}

/** Decision layers, strongest first — this ordering IS the sovereignty guarantee. */
export type DecidedBy = 'local-override' | 'env' | 'remote' | 'default'

export interface Explanation {
  flag: string
  value: FlagValue
  decidedBy: DecidedBy
  /** Age of the remote snapshot in seconds, when one exists (null = never fetched). */
  snapshotAgeSec: number | null
  overridable: true
  /**
   * Set when the remote plane sent a value that was NOT honoured because this build does
   * not declare the flag (see the capability-surface guard in `explain`). Surfacing it is
   * the difference between "your flag silently did nothing" and a debuggable answer.
   */
  remoteProposed?: FlagValue
}

/**
 * Built-in defaults — the answer when nothing else has spoken. A flag absent here is
 * unknown to this build; `isEnabled` returns the caller's fallback for it (default false),
 * so a stale remote snapshot can never switch on a capability this binary doesn't have.
 */
export const DEFAULT_FLAGS: Record<string, FlagValue> = {
  'voice.wake_word': false,
  'memory.banded': false,          // W6.2 lane, off until measured
  'compute.exhaust_accounting': true,
  'federation.enabled': false,
  'deliberation.controller': false, // W6.3 lane, off until bench-proven
}

const cachePath = (): string => path.join(noeticaHome(), 'config-cache.json')
const overridePath = (): string => path.join(noeticaHome(), 'config-override.json')

function readJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T } catch { return fallback }
}

function writeJson(p: string, value: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, p)
}

export function readSnapshot(): FlagSnapshot | null {
  const raw = readJson<Partial<FlagSnapshot> | null>(cachePath(), null)
  if (!raw || typeof raw !== 'object' || !raw.fetchedAt) return null
  return {
    flags: raw.flags ?? {}, models: raw.models ?? {},
    fetchedAt: raw.fetchedAt, source: raw.source ?? 'unknown',
    scope: raw.scope ?? { app: 'noetica' },
  }
}

/** The operator's countermand: { "flags": {...}, "models": {...} } at ~/.noetica/config-override.json */
export function readOverride(): { flags: Record<string, FlagValue>; models: Record<string, boolean> } {
  const raw = readJson<{ flags?: Record<string, FlagValue>; models?: Record<string, boolean> }>(overridePath(), {})
  return { flags: raw.flags ?? {}, models: raw.models ?? {} }
}

function envKey(flag: string): string {
  return `NOETICA_FLAG_${flag.replace(/[.\-]/g, '_').toUpperCase()}`
}

function coerce(raw: string): FlagValue {
  if (raw === 'true') return true
  if (raw === 'false') return false
  const n = Number(raw)
  return Number.isFinite(n) && raw.trim() !== '' ? n : raw
}

function ageSec(snapshot: FlagSnapshot | null): number | null {
  if (!snapshot) return null
  const t = Date.parse(snapshot.fetchedAt)
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null
}

/** Resolve a flag through the full precedence chain, naming the layer that decided. */
export function explain(flag: string, fallback: FlagValue = false): Explanation {
  const snapshot = readSnapshot()
  const base: Pick<Explanation, 'flag' | 'snapshotAgeSec' | 'overridable'> = {
    flag, snapshotAgeSec: ageSec(snapshot), overridable: true,
  }

  const override = readOverride().flags
  if (Object.hasOwn(override, flag)) {
    return { ...base, value: override[flag]!, decidedBy: 'local-override' }
  }

  const env = process.env[envKey(flag)]
  if (env !== undefined) return { ...base, value: coerce(env), decidedBy: 'env' }

  // CAPABILITY-SURFACE GUARD. The remote plane may only toggle flags this build declares in
  // DEFAULT_FLAGS. A snapshot — stale, replayed, or from a compromised plane — therefore
  // cannot introduce a capability the binary never shipped; the worst it can do is flip
  // something already present. (Local override and env are the OPERATOR on their own
  // machine and are deliberately not bound by this.) A rejected remote value is reported
  // rather than dropped, so "the flag I set did nothing" is always debuggable.
  const known = Object.hasOwn(DEFAULT_FLAGS, flag)
  const remoteHas = !!snapshot && Object.hasOwn(snapshot.flags, flag)
  if (remoteHas && known) {
    return { ...base, value: snapshot!.flags[flag]!, decidedBy: 'remote' }
  }

  const def = known ? DEFAULT_FLAGS[flag]! : fallback
  return {
    ...base, value: def, decidedBy: 'default',
    ...(remoteHas ? { remoteProposed: snapshot!.flags[flag]! } : {}),
  }
}

export function isEnabled(flag: string, fallback = false): boolean {
  return explain(flag, fallback).value === true
}

/**
 * Per-model kill-switch. A model is enabled unless something explicitly disables it, and a
 * local override can re-enable one the fleet disabled — the operator keeps the last word.
 */
export function isModelEnabled(model: string): boolean {
  const override = readOverride().models
  if (Object.hasOwn(override, model)) return override[model] !== false
  const snapshot = readSnapshot()
  if (snapshot && Object.hasOwn(snapshot.models, model)) return snapshot.models[model] !== false
  return true
}

/**
 * Best-effort refresh from our own admin plane. Never throws and never blocks a caller:
 * on any failure the previous snapshot stands and its age keeps growing (visibly).
 * Returns the snapshot in force after the attempt.
 */
export async function refresh(opts: {
  url?: string; token?: string; scope?: FlagScope; timeoutMs?: number
} = {}): Promise<FlagSnapshot | null> {
  const url = opts.url || process.env['NOETICA_CONFIG_URL'] || ''
  if (!url) return readSnapshot()
  const scope: FlagScope = opts.scope ?? { app: 'noetica' }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 4000)
  try {
    const qs = new URLSearchParams({ app: scope.app })
    if (scope.model) qs.set('model', scope.model)
    if (scope.org) qs.set('org', scope.org)
    const res = await fetch(`${url}?${qs}`, {
      signal: ctl.signal,
      headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
    })
    if (!res.ok) return readSnapshot()
    const body = (await res.json()) as { flags?: Record<string, FlagValue>; models?: Record<string, boolean> }
    const snapshot: FlagSnapshot = {
      flags: body.flags ?? {}, models: body.models ?? {},
      fetchedAt: new Date().toISOString(), source: url, scope,
    }
    writeJson(cachePath(), snapshot)
    return snapshot
  } catch {
    return readSnapshot()   // offline / timeout / malformed → last known good governs
  } finally {
    clearTimeout(timer)
  }
}

/** Everything the /api/config surface (and the Govern Posture act) needs in one object. */
export function configReport(): {
  flags: Explanation[]; models: Record<string, boolean>
  snapshot: { fetchedAt: string | null; source: string | null; ageSec: number | null; scope: FlagScope | null }
  overrideActive: boolean
} {
  const snapshot = readSnapshot()
  const override = readOverride()
  const names = new Set([
    ...Object.keys(DEFAULT_FLAGS),
    ...Object.keys(snapshot?.flags ?? {}),
    ...Object.keys(override.flags),
  ])
  return {
    flags: [...names].sort().map((f) => explain(f)),
    models: { ...(snapshot?.models ?? {}), ...override.models },
    snapshot: {
      fetchedAt: snapshot?.fetchedAt ?? null, source: snapshot?.source ?? null,
      ageSec: ageSec(snapshot), scope: snapshot?.scope ?? null,
    },
    overrideActive: Object.keys(override.flags).length > 0 || Object.keys(override.models).length > 0,
  }
}

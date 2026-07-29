/**
 * local-state — the versioned root of everything Noetica keeps on your machine.
 *
 * ~/.noetica grew to ~200 entries with NO schema version and no migration story: an
 * upgrade could meet state written by any past build and had to guess. This gives that
 * directory (a) one resolver every module can share instead of re-deriving
 * `homedir()/.noetica`, (b) a `migrationVersion` with named, once-only, ordered
 * migrations, and (c) a usage ledger — counters the app can adapt to, which receipts
 * (an audit of what happened) deliberately do not provide.
 *
 * Design stance: migrations only ever touch ~/.noetica. They never reach into the
 * system (LaunchAgents, keychains) — surprising a user's machine during a version bump
 * is exactly the class of behaviour we refuse to ship.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** The single source of truth for where local state lives. NOETICA_HOME overrides (tests, sandboxes). */
export function noeticaHome(): string {
  return process.env['NOETICA_HOME'] || path.join(os.homedir(), '.noetica')
}

const statePath = (): string => path.join(noeticaHome(), 'state.json')
const usagePath = (): string => path.join(noeticaHome(), 'usage.json')

export interface LocalState {
  migrationVersion: number
  /** Named migrations already applied, oldest first — the audit trail of how this dir got here. */
  applied: string[]
  adoptedAt: string
  notes: string[]
}

const EMPTY_STATE: LocalState = { migrationVersion: 0, applied: [], adoptedAt: '', notes: [] }

function readJson<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(p: string, value: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  // write-then-rename: a crash mid-write must never leave truncated state behind
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, p)
}

export function readState(): LocalState {
  return { ...EMPTY_STATE, ...readJson<Partial<LocalState>>(statePath(), {}) }
}

/**
 * A migration is (name, fn). `fn` mutates state and may touch files under ~/.noetica.
 * Order in this array IS the version order; never reorder or delete an entry — append only,
 * or a machine that already ran migration N will skip work it needs.
 */
export interface Migration { name: string; run: (home: string, state: LocalState) => void }

export const MIGRATIONS: Migration[] = [
  {
    // v1 — adopt the versioned state file itself. Idempotent by construction.
    name: '0001-adopt-state-file',
    run: (_home, state) => {
      if (!state.adoptedAt) state.adoptedAt = new Date().toISOString()
    },
  },
  {
    // v2 — clear the demo neuter marker. A real incident: the YC demo build wrote
    // ~/.noetica/demo-no-models to skip the model sidecars, and a normal build meeting
    // that leftover marker comes up with inference silently disabled. Stale state must
    // not outlive the build that wrote it.
    name: '0002-clear-demo-neuter-marker',
    run: (home, state) => {
      const marker = path.join(home, 'demo-no-models')
      if (fs.existsSync(marker)) {
        fs.rmSync(marker, { force: true })
        state.notes.push(`cleared stale demo marker at ${new Date().toISOString()}`)
      }
    },
  },
]

/**
 * Bring ~/.noetica up to the current schema. Runs only the migrations this machine has
 * not applied, in order, and records each by name. Fail-soft: a migration that throws is
 * recorded as a note and does NOT advance the version (so it retries next boot) — a
 * broken migration must never wedge the app or silently claim success.
 */
export function migrate(): LocalState {
  const home = noeticaHome()
  const state = readState()
  let changed = false

  for (let i = 0; i < MIGRATIONS.length; i++) {
    const m = MIGRATIONS[i]!
    if (state.applied.includes(m.name)) continue
    try {
      m.run(home, state)
      state.applied.push(m.name)
      state.migrationVersion = i + 1
      changed = true
    } catch (err) {
      state.notes.push(`migration ${m.name} failed: ${(err as Error).message}`)
      writeJson(statePath(), state)
      return state // stop at the first failure; later migrations may depend on this one
    }
  }

  if (changed || !fs.existsSync(statePath())) writeJson(statePath(), state)
  return state
}

// ── usage ledger ────────────────────────────────────────────────────────────────
// Counters the product can ADAPT to (which surfaces you actually use, what to keep warm,
// what to schedule for review). Deliberately local-only: this file is never uploaded.

export interface UsageEntry { count: number; firstUsedAt: string; lastUsedAt: string }
export type UsageLedger = Record<string, UsageEntry>

export function readUsage(): UsageLedger {
  return readJson<UsageLedger>(usagePath(), {})
}

/** Record one use of `key` (e.g. 'surface:govern', 'skill:trace-dream'). Returns the new count. */
export function recordUsage(key: string): number {
  const ledger = readUsage()
  const now = new Date().toISOString()
  const prev = ledger[key]
  const next: UsageEntry = prev
    ? { count: prev.count + 1, firstUsedAt: prev.firstUsedAt, lastUsedAt: now }
    : { count: 1, firstUsedAt: now, lastUsedAt: now }
  ledger[key] = next
  writeJson(usagePath(), ledger)
  return next.count
}

/** Most-used keys first — the shape a personalization/SRS consumer wants. */
export function usageSnapshot(limit = 20): Array<{ key: string } & UsageEntry> {
  return Object.entries(readUsage())
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}

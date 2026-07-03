/**
 * noetica-events — the governed OPERATIONAL event lane for ~/.noetica.
 *
 * Emits envelope-redacted, provenance-classed events conforming to
 * ~/.noetica/schemas/noetica.event.schema.json (which conforms to sourceos-spec
 * EventEnvelope: eventId/eventType/specVersion/occurredAt/actor/objectId/payload/integrity).
 * This lane is for feature health, permission changes, and governance verdicts — it
 * COMPLEMENTS the ReasoningRun/Event/Receipt spine (reasoning-evidence.ts), it does not
 * replace it. Design mined from Claude Code's tengu telemetry (see ~/.noetica/NOETICA.md):
 *
 *  - Tri-state health: ok / sad (degraded-but-survived) / bad (hard fail). Never omit sad.
 *  - Operation ⊥ verdict: facts and judgement are separate events (kind field).
 *  - Redaction at the ENVELOPE, never the leaf: governance/redaction.json is applied to
 *    the whole envelope right before serialization, plus the hash-echo invariant — no
 *    cleartext value may remain whose hashed form appears elsewhere in the same event.
 *  - Fail-degraded, never fail-silent: if governance files are unreadable we run on
 *    built-in defaults AND emit a one-time feature.sad about it.
 *
 * Exception-safe throughout: an evidence failure must NEVER break the host operation.
 * Dependency-light: node crypto + fs only.
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SPEC_VERSION = '0.1.0'
const DEFAULT_ACTOR = { id: 'agent:noetica-agent-machine', authority: 'delegated' as const }

export type Severity = 'ok' | 'sad' | 'bad'
export type EventKind = 'operation' | 'verdict'
export type Tier = 'telemetry' | 'substrate' | 'peripheral'
export type Provenance = 'observed' | 'derived' | 'asserted' | 'inherited'
export type Authority = 'owner' | 'delegated' | 'unverified'

export interface Claim {
  field: string
  value: unknown
  provenance: Provenance
  verified?: boolean
  inputs?: string[]
  origin_run?: string
}

export interface NoeticaEventArgs {
  eventType: string           // noetica.<domain>.<name> per the schema pattern
  objectId: string            // what the event is about (feature name, tool, field, run)
  severity?: Severity
  kind?: EventKind
  tier?: Tier
  claims?: Claim[]
  actor?: { id: string; authority: Authority }
  correlation?: Record<string, unknown>
  extra?: Record<string, unknown>
}

// ─── Governance: redaction rules (fail-degraded, never fail-silent) ────────────

type RedactionAction = 'hash' | 'drop' | 'redact' | 'hash-and-count'
interface RedactionRules {
  classes: Record<string, { action: RedactionAction; placeholder?: string }>
  fields: Record<string, string>
}

/** Built-in floor: applied even when governance/redaction.json is unreadable. */
const BUILTIN_RULES: RedactionRules = {
  classes: {
    'pii': { action: 'hash' },
    'secret': { action: 'drop' },
    'canon-restricted': { action: 'redact', placeholder: '[canon-restricted]' },
    'content': { action: 'hash-and-count' },
  },
  fields: {
    device_id: 'pii', account_uuid: 'pii', organization_uuid: 'pii', email: 'pii',
    api_key: 'secret', oauth_token: 'secret', password: 'secret',
    prompt_text: 'content', completion_text: 'content',
  },
}

function noeticaHome(): string { return process.env.NOETICA_HOME || join(homedir(), '.noetica') }
function sink(): string { return process.env.NOETICA_EVENTS_SINK || join(noeticaHome(), 'sessions') }
function dayFile(): string {
  const d = new Date().toISOString().slice(0, 10)
  return join(sink(), `events-${d}.ndjson`)
}
function sha16(s: string): string { return createHash('sha256').update(s).digest('hex').slice(0, 16) }

let _rules: RedactionRules | null = null
let _rulesDegraded = false
let _degradedReported = false

function loadRules(): RedactionRules {
  if (_rules) return _rules
  try {
    const raw = JSON.parse(readFileSync(join(noeticaHome(), 'governance', 'redaction.json'), 'utf8'))
    const classes: RedactionRules['classes'] = {}
    for (const [k, v] of Object.entries(raw.classes ?? {})) {
      const c = v as { action?: string; placeholder?: string }
      if (c && typeof c.action === 'string') classes[k] = { action: c.action as RedactionAction, placeholder: c.placeholder }
    }
    const fields: RedactionRules['fields'] = {}
    for (const [k, v] of Object.entries(raw.fields ?? {})) if (typeof v === 'string') fields[k] = v
    _rules = { classes: { ...BUILTIN_RULES.classes, ...classes }, fields: { ...BUILTIN_RULES.fields, ...fields } }
    _rulesDegraded = false
  } catch {
    // Fail-degraded: run on the built-in floor and say so (once) — never fail-silent.
    _rules = BUILTIN_RULES
    _rulesDegraded = true
  }
  return _rules
}

/** Test hook: drop the rules cache (and the one-time degraded report latch). */
export function _resetGovernanceCacheForTest(): void { _rules = null; _rulesDegraded = false; _degradedReported = false }

// ─── Envelope-level redaction ───────────────────────────────────────────────────

interface Applied { field: string; class: string; action: RedactionAction }

function redactValue(v: unknown, action: RedactionAction, placeholder?: string): unknown {
  switch (action) {
    case 'hash': return `sha256-16:${sha16(String(v))}`
    case 'redact': return placeholder ?? '[redacted]'
    case 'hash-and-count': { const s = String(v); return `hash-and-count:${s.length}:${sha16(s)}` }
    case 'drop': return undefined // handled by caller (key removal)
  }
}

/** Deep-walk the WHOLE envelope applying field rules. Enforcement point = envelope,
 *  never the leaf: this runs once, on the fully-assembled event, so a sensitive field
 *  is caught wherever it appears (payload, extra, correlation — or the envelope itself). */
function applyFieldRules(node: unknown, rules: RedactionRules, applied: Applied[]): unknown {
  if (Array.isArray(node)) return node.map((x) => applyFieldRules(x, rules, applied))
  if (node === null || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const cls = rules.fields[k]
    if (cls && v !== undefined && v !== null) {
      const action = rules.classes[cls]?.action ?? 'redact'
      if (action === 'drop') { applied.push({ field: k, class: cls, action }); continue }
      out[k] = redactValue(v, action, rules.classes[cls]?.placeholder)
      applied.push({ field: k, class: cls, action })
      continue
    }
    out[k] = typeof v === 'object' && v !== null ? applyFieldRules(v, rules, applied) : v
  }
  return out
}

/** Hash-echo invariant (redaction.json invariant #1): after field rules, no cleartext
 *  string may remain whose sha256-16 appears elsewhere in the same event. Catches the
 *  tengu leak class (payload redacted, envelope clear) AND value-in-two-representations. */
function enforceHashEcho(node: unknown, applied: Applied[]): unknown {
  const hashes = new Set<string>()
  const collect = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(collect); return }
    if (n !== null && typeof n === 'object') { Object.values(n).forEach(collect); return }
    if (typeof n === 'string') {
      const m = n.match(/^(?:sha256-16|hash-and-count:\d+):([0-9a-f]{16})$/)
      if (m) hashes.add(m[1])
    }
  }
  collect(node)
  if (hashes.size === 0) return node
  const fix = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(fix)
    if (n !== null && typeof n === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) out[k] = fix(v)
      return out
    }
    if (typeof n === 'string' && !n.startsWith('sha256-16:') && !n.startsWith('hash-and-count:') && hashes.has(sha16(n))) {
      applied.push({ field: '(hash-echo)', class: 'invariant', action: 'hash' })
      return `sha256-16:${sha16(n)}`
    }
    return n
  }
  return fix(node)
}

/** Canonical-JSON hash (sorted keys) — the envelope_hash, computed AFTER redaction. */
function canonicalHash(obj: unknown): string {
  const canon = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(canon)
    if (n !== null && typeof n === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(n as Record<string, unknown>).sort()) out[k] = canon((n as Record<string, unknown>)[k])
      return out
    }
    return n
  }
  return 'sha256:' + createHash('sha256').update(JSON.stringify(canon(obj))).digest('hex')
}

// ─── The emitter ────────────────────────────────────────────────────────────────

/** Emit one governed operational event. Assembles the EventEnvelope-conformant shape,
 *  applies envelope-level redaction + the hash-echo invariant, stamps integrity
 *  (redaction_applied + envelope_hash), appends NDJSON to ~/.noetica/sessions/.
 *  Returns the eventId, or '' on failure. NEVER throws. */
export function emitNoeticaEvent(args: NoeticaEventArgs): string {
  try {
    const rules = loadRules()
    const eventId = randomUUID()
    let envelope: Record<string, unknown> = {
      eventId,
      eventType: args.eventType,
      specVersion: SPEC_VERSION,
      occurredAt: new Date().toISOString(),
      actor: args.actor ?? DEFAULT_ACTOR,
      objectId: String(args.objectId ?? '').slice(0, 300),
      ...(args.correlation ? { correlation: args.correlation } : {}),
      payload: {
        ...(args.severity ? { severity: args.severity } : {}),
        ...(args.kind ? { kind: args.kind } : {}),
        ...(args.tier ? { tier: args.tier } : {}),
        ...(args.claims?.length ? { claims: args.claims } : {}),
        ...(args.extra ?? {}),
      },
    }
    const applied: Applied[] = []
    envelope = applyFieldRules(envelope, rules, applied) as Record<string, unknown>
    envelope = enforceHashEcho(envelope, applied) as Record<string, unknown>
    envelope.integrity = {
      redaction_applied: true,
      ...(applied.length ? { redactions: applied } : {}),
      envelope_hash: '', // placeholder excluded from its own hash below
    }
    ;(envelope.integrity as Record<string, unknown>).envelope_hash = canonicalHash({ ...envelope, integrity: undefined })
    mkdirSync(sink(), { recursive: true })
    appendFileSync(dayFile(), JSON.stringify(envelope) + '\n')
    // Governance-source degradation is itself evidence — one-time, after the sink works.
    if (_rulesDegraded && !_degradedReported) {
      _degradedReported = true
      featureSad('governance_redaction_load', 'builtin_defaults_used')
    }
    return eventId
  } catch (err) {
    console.warn('[noetica-events] emit failed:', err instanceof Error ? err.message : String(err))
    return ''
  }
}

// ─── Tri-state feature health (tengu_feature_ok/sad/bad analog) ────────────────

export function featureOk(name: string, extra?: Record<string, unknown>): string {
  return emitNoeticaEvent({ eventType: 'noetica.feature.ok', objectId: name, severity: 'ok', kind: 'verdict', tier: 'telemetry', extra })
}
/** Degraded-but-survived: ran on a fallback (stale cache, last-known-good, builtin defaults). */
export function featureSad(name: string, errorCode: string, extra?: Record<string, unknown>): string {
  return emitNoeticaEvent({ eventType: 'noetica.feature.sad', objectId: name, severity: 'sad', kind: 'verdict', tier: 'telemetry', extra: { error_code: errorCode, ...extra } })
}
export function featureBad(name: string, errorCode: string, extra?: Record<string, unknown>): string {
  return emitNoeticaEvent({ eventType: 'noetica.feature.bad', objectId: name, severity: 'bad', kind: 'verdict', tier: 'telemetry', extra: { error_code: errorCode, ...extra } })
}

// ─── Gate + permission lanes ────────────────────────────────────────────────────

/** Autonomy/permission gate verdict (control-plane analog of tengu can_use_tool). */
export function gateVerdict(d: { tool: string; decision: string; requestedLevel: string; grantedLevel: string; role: string; reason?: string }): string {
  return emitNoeticaEvent({
    eventType: d.decision === 'deny' || d.decision === 'demote' ? 'noetica.gate.rejected' : 'noetica.gate.roundtrip',
    objectId: d.tool,
    severity: d.decision === 'deny' ? 'bad' : d.grantedLevel !== d.requestedLevel ? 'sad' : 'ok',
    kind: 'verdict',
    tier: 'telemetry',
    claims: [{ field: 'granted_level', value: d.grantedLevel, provenance: 'observed', verified: true }],
    extra: { decision: d.decision, requested: d.requestedLevel, granted: d.grantedLevel, role: d.role, ...(d.reason ? { reason: d.reason } : {}) },
  })
}

/** Peripheral-tier permission-state change (Accessibility/mic/TCC class — invariant 5:
 *  grants and revocations are datable events, not ambient state). */
export function permissionChanged(subject: string, granted: boolean, detail?: Record<string, unknown>): string {
  return emitNoeticaEvent({
    eventType: granted ? 'noetica.permission.granted' : 'noetica.permission.revoked',
    objectId: subject,
    severity: 'ok',
    kind: 'operation',
    tier: 'peripheral',
    claims: [{ field: 'granted', value: granted, provenance: 'observed', verified: true }],
    extra: detail,
  })
}

// ─── Boot evidence ──────────────────────────────────────────────────────────────

/** Called once at boot: records governance-file health and the autonomy-bind state.
 *  The gate being UNBOUND is a chosen (backward-compatible) state → ok with an observed
 *  claim, not sad. Exception-safe. */
export function noeticaBootEvidence(): void {
  try {
    _resetGovernanceCacheForTest() // re-read governance freshly each boot
    loadRules()
    if (_rulesDegraded) featureSad('governance_redaction_load', 'builtin_defaults_used')
    else featureOk('governance_redaction_load')
    let bound = false
    try { readFileSync(join(noeticaHome(), 'autonomy.json'), 'utf8'); bound = true } catch { /* unbound */ }
    featureOk('autonomy_gate', undefined)
    emitNoeticaEvent({
      eventType: 'noetica.governance.conflict_resolved',
      objectId: 'autonomy_bind_state',
      kind: 'operation',
      tier: 'telemetry',
      claims: [{ field: 'autonomy_bound', value: bound, provenance: 'observed', verified: true }],
      extra: { note: bound ? 'gate active (fail-closed)' : 'gate not enforced (no autonomy.json — deliberate)' },
    })
  } catch (err) {
    console.warn('[noetica-events] boot evidence failed:', err instanceof Error ? err.message : String(err))
  }
}

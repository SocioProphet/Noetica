// Typed action layer (Bet C) — the catalog of typed, parameterized actions the agent can take, with the
// metadata a preview→approve UX and the scope-d gate need. v1 is the typed CONTRACT + catalog: each entry
// maps to an existing built-in tool and declares its action class, reversibility, params, and a
// human-readable preview of exactly what a given call will do. Execution still flows through the gated
// tool path (execute_action / built-in tools) — the registry never opens a new un-gated execution route.
// Next phase: per-action approve/undo UX wired to these previews + reversibility handlers.

export type ActionClass = 'read' | 'write' | 'exec' | 'net' | 'memory'

/** A ValueType-algebra term. Composable: `optional(array(scalar 'person'))` is one term, not a
 *  scalar name plus a sibling boolean. Mirrors sourceos-spec's ValueType — the estate's authoritative
 *  type language, with 12 scalar leaves and 8 composites — so an action's parameter shape can carry
 *  the same guarantees an entity field carries. Kept as `unknown` in the TS layer to avoid pulling
 *  the spec's TypeBox at this layer; the JSON schema validates the actual structure at test time. */
export type ValueType = unknown

export interface ActionParam {
  name: string
  /** Legacy scalar type marker. Retained because existing entries carry it; prefer `valueType` for
   *  new entries — flat strings cannot express `array of person` or `optional dateTime`, the exact
   *  gap ValueType exists to close. Every ActionParam MUST carry at least one of `type` or `valueType`;
   *  the JSON schema asserts this. */
  type?: 'string' | 'number' | 'boolean'
  /** Structural type — the composable Apple-parity algebra (see ../schemas/action-catalog-entry.schema.json).
   *  Authoritative when present. */
  valueType?: ValueType
  required: boolean
  description: string
}

export interface ActionDef {
  id: string
  label: string
  description: string
  actionClass: ActionClass
  /** Can the effect be undone (backup kept / inverse exists)? Drives the confirm UX weight. */
  reversible: boolean
  /** Whether a signed consent record must be presented before execution — the client-side echo of
   *  the agent-machine consent-before-fetch discipline (ArtifactConsentRecord). Defaults to false
   *  so opt-in is deliberate. */
  consentRequired?: boolean
  /** URN of the capability-ledger entry gating this action, when the action is behind a runtime
   *  capability gate. Present means `assertEnabled(capabilityRef)` fires before execution. */
  capabilityRef?: string
  /** The underlying built-in tool this typed action maps to. */
  tool: string
  params: ActionParam[]
  /** Human preview of what a specific call will do — shown before approval. */
  preview: (p: Record<string, unknown>) => string
}

const s = (p: Record<string, unknown>, k: string) => String(p[k] ?? '').trim()

export const ACTION_CATALOG: ActionDef[] = [
  {
    id: 'write_file', label: 'Write file', description: 'Create or overwrite a local file. A backup of any existing file is kept, so it can be undone.',
    actionClass: 'write', reversible: true, tool: 'write_file',
    params: [
      { name: 'path', type: 'string', required: true, description: 'File path (under home or /tmp)' },
      { name: 'content', type: 'string', required: true, description: 'Text content to write' },
    ],
    preview: (p) => `Write ${s(p, 'content').length} chars to ${s(p, 'path') || '(path)'} (existing file backed up).`,
  },
  {
    id: 'append_note', label: 'Append to note', description: 'Append a line to a note or log file. Reversible (removes the appended line).',
    actionClass: 'write', reversible: true, tool: 'write_file',
    params: [
      { name: 'path', type: 'string', required: true, description: 'Note/log file path' },
      { name: 'text', type: 'string', required: true, description: 'Line to append' },
    ],
    preview: (p) => `Append "${s(p, 'text').slice(0, 60)}" to ${s(p, 'path') || '(path)'}.`,
  },
  {
    id: 'run_command', label: 'Run command', description: 'Run a shell command in the sandbox. NOT reversible — review carefully before approving.',
    actionClass: 'exec', reversible: false, tool: 'run_command',
    params: [{ name: 'command', type: 'string', required: true, description: 'Shell command' }],
    preview: (p) => `Run: ${s(p, 'command') || '(command)'} — irreversible; review before approving.`,
  },
  {
    id: 'web_search', label: 'Web search', description: 'Search the web. Read-only; leaves the device only to fetch results.',
    actionClass: 'net', reversible: true, tool: 'web_search',
    params: [{ name: 'query', type: 'string', required: true, description: 'Search query' }],
    preview: (p) => `Search the web for "${s(p, 'query') || '(query)'}".`,
  },
  {
    id: 'remember', label: 'Remember', description: 'Save a durable fact to local memory. Reversible (the memory can be deleted).',
    actionClass: 'memory', reversible: true, tool: 'remember',
    params: [{ name: 'fact', type: 'string', required: true, description: 'The fact to remember' }],
    preview: (p) => `Remember: "${s(p, 'fact').slice(0, 80)}".`,
  },
  {
    id: 'read_file', label: 'Read file', description: 'Read a local file. Read-only, no side effects.',
    actionClass: 'read', reversible: true, tool: 'read_file',
    params: [{ name: 'path', type: 'string', required: true, description: 'File path' }],
    preview: (p) => `Read ${s(p, 'path') || '(path)'}.`,
  },
  // ── ValueType-typed actions — the four below exercise a composite the legacy
  // `type: 'string'|'number'|'boolean'` cannot express. Kept alongside the legacy
  // entries so the migration is one entry at a time, not one big rewrite.
  {
    id: 'schedule_reminder', label: 'Schedule reminder',
    description: 'Enqueue a reminder for a specific moment. Reversible (the entry can be cancelled).',
    actionClass: 'memory', reversible: true, tool: 'schedule_reminder',
    params: [
      { name: 'text', valueType: { kind: 'scalar', scalar: 'string' }, required: true, description: 'What the reminder says' },
      { name: 'when', valueType: { kind: 'scalar', scalar: 'dateTime' }, required: true, description: 'When the reminder fires (ISO-8601 with timezone)' },
      { name: 'note', valueType: { kind: 'optional', of: { kind: 'scalar', scalar: 'attributedString' } }, required: false, description: 'Optional attributed-text note carried alongside — attributedString keeps rich text marks that would silently die as plain string.' },
    ],
    preview: (p) => `Reminder "${s(p,'text').slice(0,60)}" scheduled for ${s(p,'when') || '(time)'}.`,
  },
  {
    id: 'invite_people', label: 'Invite people',
    description: 'Send an invite to one or more people. Not reversible — invites can be withdrawn but the recipient sees them.',
    actionClass: 'net', reversible: false, tool: 'invite_people',
    consentRequired: true,
    params: [
      { name: 'recipients', valueType: { kind: 'array', of: { kind: 'scalar', scalar: 'person' }, minItems: 1 }, required: true, description: 'People to invite. `array of person` is exactly the shape Apple\'s bare `dataType` cannot express.' },
      { name: 'occasion', valueType: { kind: 'scalar', scalar: 'string' }, required: true, description: 'What they are being invited to' },
      { name: 'starts_at', valueType: { kind: 'scalar', scalar: 'dateTime' }, required: true, description: 'When it starts' },
    ],
    preview: (p) => `Invite ${Array.isArray(p['recipients']) ? (p['recipients'] as unknown[]).length : 0} people to "${s(p,'occasion')}" at ${s(p,'starts_at')}.`,
  },
  {
    id: 'set_severity', label: 'Set severity',
    description: 'Set the severity level of an item. Reversible.',
    actionClass: 'write', reversible: true, tool: 'set_severity',
    params: [
      { name: 'item_id', valueType: { kind: 'scalar', scalar: 'string' }, required: true, description: 'Identifier of the item' },
      { name: 'level', valueType: { kind: 'enumeration', cases: ['info', 'low', 'medium', 'high', 'critical'] }, required: true, description: 'Enumeration — the cases ARE the type, so widening them is visible as a type change.' },
    ],
    preview: (p) => `Set severity of ${s(p,'item_id') || '(id)'} → ${s(p,'level') || '(level)'}.`,
  },
  {
    id: 'record_measurement', label: 'Record measurement',
    description: 'Record a physical measurement with its dimension. Reversible.',
    actionClass: 'memory', reversible: true, tool: 'record_measurement',
    params: [
      { name: 'value', valueType: { kind: 'scalar', scalar: 'double' }, required: true, description: 'The numeric value' },
      { name: 'quantity', valueType: { kind: 'measurement', dimension: 'information', unit: 'byte' }, required: true, description: '`measurement` carries its dimension so a bare number for a physical quantity is not representable — the exact confusion this constructor exists to prevent.' },
      { name: 'note', valueType: { kind: 'optional', of: { kind: 'scalar', scalar: 'string' } }, required: false, description: 'Optional annotation' },
    ],
    preview: (p) => `Record ${s(p,'value') || '(value)'} (${s(p,'quantity') || '(qty)'}).`,
  },
]

export function getAction(id: string): ActionDef | undefined {
  return ACTION_CATALOG.find((a) => a.id === id)
}

/** Client-safe view of the catalog (drops the preview function; keeps a rendered sample preview). */
export function catalogForClient(): Array<Omit<ActionDef, 'preview'>> {
  return ACTION_CATALOG.map(({ preview: _preview, ...rest }) => rest)
}

/** Render the preview for a specific action + params (used by the approve UX / proposals). */
export function renderPreview(id: string, params: Record<string, unknown>): string | null {
  const a = getAction(id)
  return a ? a.preview(params) : null
}

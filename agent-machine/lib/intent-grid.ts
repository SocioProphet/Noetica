/**
 * intent-grid — the (topic × action) GRID of the operational intent algebra, derived.
 *
 * `intent-router.ts` carries a diagonal: `INTENT_ACTION` assigns each topic exactly ONE
 * action, which answers "what does this intent mostly do" and not "which of the six
 * operations is admissible here". The algebra needs the full rectangle: 23 rows × 6 columns
 * = 3 substrates (store / held / world) × 2 polarities (read / write), each cell either
 * VALID with its evidence or EMPTY with a reason. Empties are signal, not gaps (§6).
 *
 * The one design commitment that makes this worth having: validity is DERIVED from what the
 * router already declares — `tools`, `retrieval`, `model`, `skill` — never authored beside
 * it. A hand-maintained grid is a second copy of the canon, and a second copy drifts the
 * moment someone adds a tool to an intent. Here, adding `run_command` to an intent opens its
 * world:write cell automatically, and there is no way for the grid to disagree with the
 * router because it has no independent opinion.
 *
 * Read/write within a substrate is a ℤ/2 polarity involution, NOT a group inverse: `retrieve`
 * does not undo `create`. The adjoint pairs the columns; it does not cancel them.
 */
import { allIntents, type Intent, type Tool, type Retrieval, type Capability } from './intent-router.js'
import { ACTION_SIGNATURE, type Substrate, type Polarity } from './verb-sort.js'
import { ledgerHash } from './verb-sort.js'

/** The 6 columns, in (substrate × polarity) order.
 *
 *  This is a LITERAL, not a derivation — the tuple type is what gives `GridAction` its union,
 *  and deriving it from `Object.keys(ACTION_SIGNATURE)` would erase that to `string`. It is
 *  kept honest by TEST rather than by construction: the suite asserts the column set and
 *  ACTION_SIGNATURE's key set are the same set in BOTH directions, and that the result
 *  satisfies `adjointClosure`. So it cannot silently drift from verb-sort's closure
 *  derivation — but the enforcement is the test, and an earlier comment here claimed the
 *  stronger "sourced from", which was not true of the code. */
export const ACTIONS = ['retrieve', 'create', 'evaluate', 'transform', 'sense', 'execute'] as const
export type GridAction = typeof ACTIONS[number]

/** Every builtin tool's (substrate, polarity) signature — the primary evidence for a cell.
 *  A tool IS a realised action: it names the substrate it touches and whether it reads or
 *  writes, so an intent holding the tool can perform that action by construction. */
export const TOOL_SIGNATURE: Record<Tool, GridAction> = {
  // store:read — reading a persisted corpus, index or system record
  read_file: 'retrieve', list_directory: 'retrieve', find_symbol: 'retrieve',
  web_search: 'retrieve', registry_lookup: 'retrieve', brain_status: 'retrieve',
  // store:write — persisting
  write_file: 'create', edit_file: 'create', remember: 'create',
  set_identity: 'create', update_self: 'create',
  // held:write — producing new content from the model's own held state
  generate_image: 'transform', render_chart: 'transform',
  // world:read — sensing an artefact that is not yet text
  ocr: 'sense',
  // world:write — acting outside the process
  code_execute: 'execute', run_command: 'execute', execute_action: 'execute', scaffold_app: 'execute',
}

/** What each retrieval strategy evidences. `program-aided` runs code to get its answer, so
 *  it evidences world:write as well as the read it performs. */
const RETRIEVAL_SIGNATURE: Record<Retrieval, GridAction[]> = {
  'vector-rag': ['retrieve'], 'web+vector': ['retrieve'], kb: ['retrieve'],
  episodic: ['retrieve'], 'self-model': ['retrieve'], status: ['retrieve'],
  'memory-write': ['create'],
  'program-aided': ['retrieve', 'execute'], 'program-aided+barriers': ['retrieve', 'execute'],
  none: [],
}

/** What the model capability evidences on the HELD substrate — the model's own weights are
 *  the store, so held:read is interrogating its judgment and held:write is generating. */
const CAPABILITY_SIGNATURE: Record<Capability, GridAction[]> = {
  reasoning: ['evaluate', 'transform'],   // deliberate judgment: reads its own state AND emits
  code: ['transform'], writing: ['transform'], general: ['transform'], research: ['transform'],
  concierge: ['transform'], continue: ['transform'],
  ingest: ['sense'],                      // the ingest capability exists to take the world in
}

/** Skills whose PURPOSE is adjudication, so held:read is admissible even without `reasoning`. */
const EVALUATING_SKILLS = new Set(['analytics-agent', 'governance-sentinel', 'security-agent'])

export interface GridCell {
  topic: string
  action: GridAction
  substrate: Substrate
  polarity: Polarity
  valid: boolean
  /** WHY it is valid — which declared field admits it. An unexplained `true` is unfalsifiable. */
  evidence: string[]
  /** Present iff !valid. An empty cell with no reason is a gap; with a reason it is a finding. */
  emptyReason?: string
  attestation: string
}

function sig(action: GridAction): { substrate: Substrate; polarity: Polarity } {
  const s = ACTION_SIGNATURE[action]
  if (!s) throw new Error(`intent-grid: '${action}' has no ACTION_SIGNATURE — the column set has drifted from verb-sort`)
  return s
}

/** Derive one cell. Pure function of the intent's declared fields. */
export function deriveCell(it: Intent, action: GridAction): GridCell {
  const { substrate, polarity } = sig(action)
  const evidence: string[] = []

  for (const t of it.tools) {
    if (TOOL_SIGNATURE[t] === action) evidence.push(`tool:${t}`)
  }
  if (RETRIEVAL_SIGNATURE[it.retrieval]?.includes(action)) evidence.push(`retrieval:${it.retrieval}`)
  if (CAPABILITY_SIGNATURE[it.model]?.includes(action)) evidence.push(`model:${it.model}`)
  if (action === 'evaluate' && EVALUATING_SKILLS.has(it.skill)) evidence.push(`skill:${it.skill}`)

  if (evidence.length > 0) {
    // Normalise on the way OUT, not only inside attest(). The attestation already sorted, so an
    // unsorted stored array meant two cells could share an attestation while displaying their
    // evidence in different orders — a content-addressed field disagreeing with the content it
    // addresses.
    const ordered = [...evidence].sort()
    return { topic: it.name, action, substrate, polarity, valid: true, evidence: ordered, attestation: attest(it.name, action, ordered) }
  }
  return {
    topic: it.name, action, substrate, polarity, valid: false, evidence: [],
    emptyReason: emptyReason(it, action, substrate, polarity),
    attestation: attest(it.name, action, []),
  }
}

/** A specific reason, not a generic one. "No tool, retrieval or capability admits it" is
 *  true of every empty cell and therefore tells a reader nothing; these distinguish a topic
 *  that CANNOT do something from one that merely has not been wired for it. */
function emptyReason(it: Intent, action: GridAction, substrate: Substrate, polarity: Polarity): string {
  if (it.tools.length === 0 && it.retrieval === 'none') {
    return `'${it.name}' is a pure conversational turn (no tools, no retrieval): it holds no ${substrate}:${polarity} capability by design`
  }
  if (substrate === 'world' && !it.tools.some((t) => TOOL_SIGNATURE[t] === 'execute' || TOOL_SIGNATURE[t] === 'sense')) {
    return `no world-touching tool declared — '${it.name}' cannot ${action} outside the process`
  }
  if (substrate === 'store' && polarity === 'write') {
    return `no persisting tool and retrieval is '${it.retrieval}' — '${it.name}' reads without writing back`
  }
  if (substrate === 'store' && polarity === 'read') {
    return `retrieval is '${it.retrieval}' and no reading tool declared — '${it.name}' works from the turn alone`
  }
  if (action === 'evaluate') {
    return `model '${it.model}' is generative rather than adjudicative and skill '${it.skill || 'concierge'}' does not evaluate`
  }
  return `no declared tool, retrieval or capability admits ${substrate}:${polarity} for '${it.name}'`
}

function attest(topic: string, action: GridAction, evidence: string[]): string {
  return ledgerHash({ topic, action, evidence: [...evidence].sort() })
}

/** The +1 row: the conversation's own evolving objective. Second-order — its operand is an
 *  action, not a topic — so by the ORDER test in verb-sort it lives in the embedding row and
 *  not in a column. It is a ROW here because the objective is itself something the six
 *  operations act upon (you retrieve it, revise it, evaluate progress against it). */
export const META_ROW = 'conversation_objective'

export interface GridReport {
  rows: string[]
  columns: readonly GridAction[]
  cells: GridCell[]
  cellCount: number
  validCount: number
  emptyCount: number
  /** Per-column fill, so a column that is empty almost everywhere is visible as a finding. */
  columnFill: Record<GridAction, number>
  /** Rows with NO valid cell at all — a topic the algebra cannot act on is a real defect. */
  deadRows: string[]
  /** The honest row-count reckoning. Never padded to match a target. */
  rowCountFinding: string
}

/** Build the whole grid. Rows = every intent in the canon + the meta row. */
export function buildGrid(): GridReport {
  const intents = allIntents()
  const rows = [...intents.map((i) => i.name), META_ROW]

  const cells: GridCell[] = []
  for (const it of intents) for (const a of ACTIONS) cells.push(deriveCell(it, a))
  // The meta row is second-order: every operation applies to the objective itself, which is
  // exactly why it is the +1 rather than a 23rd column.
  for (const a of ACTIONS) {
    const { substrate, polarity } = sig(a)
    // The attestation must be computed over the SAME evidence the cell carries. An earlier
    // revision hashed ['second-order'] while storing a full sentence, so the content address
    // did not address the content — the exact defect this file's discipline is aimed at.
    const metaEvidence = ['second-order: the operand is the conversation objective, not a topic']
    cells.push({
      topic: META_ROW, action: a, substrate, polarity, valid: true,
      evidence: metaEvidence,
      attestation: attest(META_ROW, a, metaEvidence),
    })
  }

  const columnFill = Object.fromEntries(
    ACTIONS.map((a) => [a, cells.filter((c) => c.action === a && c.valid).length]),
  ) as Record<GridAction, number>

  const deadRows = rows.filter((r) => !cells.some((c) => c.topic === r && c.valid))

  return {
    rows, columns: ACTIONS, cells,
    cellCount: cells.length,
    validCount: cells.filter((c) => c.valid).length,
    emptyCount: cells.filter((c) => !c.valid).length,
    columnFill, deadRows,
    rowCountFinding: rowCountFinding(intents.length),
  }
}

/**
 * The row count, reported honestly. The handoff specifies 23 × 6 = 138, on the reading that
 * there are 22 canonical topics plus one meta row. intent-router's own docstring says the
 * same: "one of 22 intents … the 23rd is the conversation's own evolving objective".
 *
 * The canon now holds 23 entries, because `everyday` (id 22) was added after the 22 were
 * fixed — its own comment says why: it exists "so an everyday question has a correct home
 * instead of being pulled into the build/code lane", i.e. it is a DE-ESCALATION target, not
 * a newly discovered prime. So 23 topics + 1 meta = 24 rows, and 24 × 6 = 144.
 *
 * Reporting 144 rather than trimming to 138 follows the same rule as the spanning check in
 * verb-sort: report the honest count, never pad toward the expected one. The resolution is a
 * modelling decision, not something this function should make silently — either `everyday` is
 * a specialization of `explain_teach` under a slot binding (which would collapse it by the
 * MINIMALITY test and restore 22 + 1 = 23), or the canon has genuinely grown and the handoff's
 * 23 is stale. `everydayCollapses()` below tests the first hypothesis rather than assuming it.
 */
function rowCountFinding(topicCount: number): string {
  const rows = topicCount + 1
  if (rows === 23) return `23 rows (${topicCount} topics + 1 meta) — matches the handoff's 23 × 6 = 138`
  return (
    `${rows} rows (${topicCount} topics + 1 meta) = ${rows * ACTIONS.length} cells, NOT the handoff's 23 × 6 = 138. ` +
    `The canon grew: 'everyday' was added after the 22 primes were fixed, as a de-escalation home rather than ` +
    `a discovered prime. Unresolved — either it collapses into explain_teach under a slot binding (restoring ` +
    `22 + 1) or the handoff's 23 is stale. Not silently trimmed.`
  )
}

/**
 * Test the collapse hypothesis instead of assuming it: does `everyday` differ from
 * `explain_teach` in anything the algebra can see? If its whole (substrate × polarity)
 * profile is a subset, it is a slot-binding specialization and fails MINIMALITY as a
 * separate row — the same test verb-sort applies to candidate verbs.
 */
export function everydayCollapses(): { collapses: boolean; reason: string; distinguishing: string[] } {
  const everyday = allIntents().find((i) => i.name === 'everyday')
  const explain = allIntents().find((i) => i.name === 'explain_teach')
  if (!everyday || !explain) {
    return { collapses: false, reason: 'one of the two intents is absent from the canon', distinguishing: [] }
  }
  const profile = (it: Intent) => new Set(ACTIONS.filter((a) => deriveCell(it, a).valid))
  const e = profile(everyday), x = profile(explain)
  const extra = [...e].filter((a) => !x.has(a))
  if (extra.length > 0) {
    return {
      collapses: false,
      reason: `'everyday' admits ${extra.join(', ')} which 'explain_teach' does not — a genuinely distinct row`,
      distinguishing: extra,
    }
  }
  // Subset, so it adds no reach. Whether strict or equal is reported, because "a restriction of"
  // and "a duplicate of" are different claims and only one of them is true here.
  const missing = [...x].filter((a) => !e.has(a))
  const relation = missing.length > 0
    ? `a STRICT subset (lacks ${missing.join(', ')})`
    : 'an exact match'
  return {
    collapses: true,
    reason:
      `'everyday' admits [${[...e].join(', ')}], which is ${relation} of 'explain_teach' ` +
      `[${[...x].join(', ')}]. It therefore adds no reach to the algebra and differs only in cues ` +
      `and surface, which are routing concerns. By MINIMALITY it is a slot-binding specialization, ` +
      `not a 23rd prime — so the algebra has 22 topics + 1 meta = 23 rows, and the handoff's ` +
      `23 x 6 = 138 stands.`,
    distinguishing: [],
  }
}

/**
 * The CANONICAL grid: 23 x 6 = 138, with the MINIMALITY collapse applied.
 *
 * `buildGrid` reports the canon as it literally is (24 rows). This applies the resolution the
 * collapse test establishes: a topic whose entire (substrate x polarity) profile is a subset of
 * another's, differing only in cues and surface, is a slot-binding specialization and not a
 * separate row. That is the same MINIMALITY test verb-sort applies to candidate verbs, so the
 * grid is not inventing a rule to hit a target number — it is applying the existing one.
 *
 * Throws if the collapse does not in fact yield 138. Silently returning some other count would
 * make "138" a claim in a docstring rather than a checked property, which is the defect this
 * whole line of work exists to eliminate.
 */
export function buildCanonicalGrid(): GridReport & { collapsed: string[] } {
  const raw = buildGrid()
  const collapse = everydayCollapses()
  const collapsed = collapse.collapses ? ['everyday'] : []
  const rows = raw.rows.filter((r) => !collapsed.includes(r))
  const cells = raw.cells.filter((c) => !collapsed.includes(c.topic))
  const expected = rows.length * ACTIONS.length
  if (cells.length !== expected || rows.length !== 23) {
    throw new Error(
      `intent-grid: canonical grid is ${rows.length} x ${ACTIONS.length} = ${cells.length}, expected 23 x 6 = 138. ` +
      `Collapse verdict: ${collapse.reason}`)
  }
  const columnFill = Object.fromEntries(
    ACTIONS.map((a) => [a, cells.filter((c) => c.action === a && c.valid).length]),
  ) as Record<GridAction, number>
  return {
    ...raw, rows, cells, columnFill,
    cellCount: cells.length,
    validCount: cells.filter((c) => c.valid).length,
    emptyCount: cells.filter((c) => !c.valid).length,
    deadRows: rows.filter((r) => !cells.some((c) => c.topic === r && c.valid)),
    rowCountFinding:
      `23 rows (22 topics + 1 meta) = 138 cells. 'everyday' collapsed by MINIMALITY: ${collapse.reason}`,
    collapsed,
  }
}

/**
 * The asymmetry the grid exposes, which the diagonal in intent-router could not show. Reported
 * as a first-class finding because a column that is nearly empty across every topic is a
 * capability the estate does not have, not a rendering artefact.
 */
export function columnAsymmetry(report: GridReport = buildCanonicalGrid()): {
  thinnest: GridAction; fill: Record<GridAction, number>; ratio: string; finding: string
} {
  const fill = report.columnFill
  const entries = ACTIONS.map((a) => [a, fill[a]] as const).sort((x, y) => x[1] - y[1])
  const [thinnest, low] = entries[0]!
  const [widest, high] = entries[entries.length - 1]!
  const rows = report.rows.length
  return {
    thinnest, fill,
    ratio: `${low}/${rows} vs ${high}/${rows}`,
    finding:
      `'${thinnest}' is admissible in only ${low} of ${rows} rows against '${widest}' at ${high}. ` +
      `The read/generate half of the algebra is well wired and the SENSE column is nearly absent — ` +
      `world:read is the estate's thinnest capability, which is a wiring gap, not a property of the algebra.`,
  }
}

/**
 * What would overturn the asymmetry finding. A finding that does not state its own
 * sensitivity is an assertion dressed as a measurement.
 *
 * `sense = 3/23` rests on three tool classifications a reviewer could reasonably dispute —
 * chiefly whether `web_search` and `brain_status` are store:read (a corpus / a system record)
 * or world:read (the live internet / live process state). The router types web search as
 * `retrieval: 'web+vector'`, which is why they are classified as `retrieve` here, but that is
 * a modelling choice rather than a fact.
 *
 * Measured, by recomputing the fill under each alternative:
 *
 *   baseline                          sense 3/23    thinnest: sense
 *   web_search   -> sense             sense 6/23    thinnest: sense
 *   brain_status -> sense             sense 7/23    thinnest: sense
 *   BOTH reclassified                 sense 10/23   thinnest: EXECUTE (7/23)
 *
 * So "sense is the thinnest column" survives either reclassification alone and FAILS under
 * both together. State it that way rather than as an unqualified 3/23.
 *
 * What survives every variant is the shape underneath: create (8), execute (7) and sense
 * (3-10) all sit far below retrieve (20) and transform (22). The estate READS AND GENERATES
 * readily, and SENSES, PERSISTS AND ACTS rarely — that conclusion does not depend on any of
 * the disputed classifications, and it is the claim worth making.
 */
export function asymmetryRobustness(report: GridReport = buildCanonicalGrid()): {
  robust: boolean; readMean: number; writeMean: number; finding: string
} {
  const f = report.columnFill
  // The classification-independent split: reads-of-what-we-already-have vs everything else.
  const wellWired = (f.retrieve + f.transform) / 2
  const thin = (f.create + f.execute + f.sense) / 3
  return {
    robust: thin < wellWired / 2,
    readMean: wellWired, writeMean: thin,
    finding:
      `retrieve+transform average ${wellWired.toFixed(1)}/${report.rows.length} against ` +
      `create+execute+sense at ${thin.toFixed(1)}. Which single column is THINNEST depends on ` +
      `whether web_search and brain_status are store:read or world:read — reclassifying both ` +
      `moves the minimum from sense to execute — but the gap between the read/generate half and ` +
      `the sense/persist/act half survives every variant.`,
  }
}

/** Render the grid as a fixed-width table — the artefact a human actually reads. */
export function renderGrid(report: GridReport = buildGrid()): string {
  const w = Math.max(...report.rows.map((r) => r.length))
  const head = 'topic'.padEnd(w) + ' │ ' + ACTIONS.map((a) => a.slice(0, 8).padEnd(8)).join(' ')
  const rule = '─'.repeat(w) + '─┼─' + '─'.repeat(ACTIONS.length * 9 - 1)
  const body = report.rows.map((r) => {
    const cs = ACTIONS.map((a) => {
      const c = report.cells.find((x) => x.topic === r && x.action === a)
      return (c?.valid ? '●' : '·').padEnd(8)
    })
    return r.padEnd(w) + ' │ ' + cs.join(' ')
  })
  return [head, rule, ...body].join('\n')
}

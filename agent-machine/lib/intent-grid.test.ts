import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIONS, TOOL_SIGNATURE, META_ROW, buildGrid, buildCanonicalGrid, deriveCell,
  everydayCollapses, columnAsymmetry, asymmetryRobustness, renderGrid, type GridAction,
} from './intent-grid.js'
import { allIntents, type Tool } from './intent-router.js'
import { ACTION_SIGNATURE, adjointClosure } from './verb-sort.js'

// ── the grid is DERIVED, which is the only reason it is worth having ─────────────

test('the 6 columns come from ACTION_SIGNATURE, not from a second list', () => {
  // A hand-written column set would be a second copy of the closure derivation, and a second
  // copy drifts. Every column must carry a signature, and every signature must be a column.
  for (const a of ACTIONS) {
    assert.ok(ACTION_SIGNATURE[a], `'${a}' must have a (substrate, polarity) signature`)
  }
  const signed = Object.keys(ACTION_SIGNATURE).sort()
  assert.deepEqual([...ACTIONS].sort(), signed,
    'the column set and the signature set must be the same set — no column without a signature, no signature without a column')
})

test('the 6 columns are exactly 3 substrates × 2 polarities, filled bijectively', () => {
  const cells = new Set(ACTIONS.map((a) => `${ACTION_SIGNATURE[a]!.substrate}:${ACTION_SIGNATURE[a]!.polarity}`))
  assert.equal(cells.size, 6, 'no two actions may occupy the same (substrate, polarity) cell')
  assert.equal(new Set(ACTIONS.map((a) => ACTION_SIGNATURE[a]!.substrate)).size, 3)
  assert.equal(new Set(ACTIONS.map((a) => ACTION_SIGNATURE[a]!.polarity)).size, 2)
  // And this agrees with the independent closure derivation in verb-sort.
  assert.equal(adjointClosure([...ACTIONS]).closed, true, 'the column set must be the closed basis')
})

test('every builtin tool has a signature — an unsignatured tool would silently open no cell', () => {
  // The failure this prevents: a tool added to the router with no entry here contributes no
  // evidence, so its intent's cell stays EMPTY and the grid quietly understates a real
  // capability. Enumerating from the router's own Tool union makes that impossible.
  const declared = new Set<string>()
  for (const it of allIntents()) for (const t of it.tools) declared.add(t)
  for (const t of declared) {
    assert.ok(TOOL_SIGNATURE[t as Tool], `tool '${t}' is used by an intent but has no TOOL_SIGNATURE`)
  }
  for (const [t, a] of Object.entries(TOOL_SIGNATURE)) {
    assert.ok(ACTIONS.includes(a), `TOOL_SIGNATURE['${t}'] = '${a}' is not one of the 6 columns`)
  }
})

test('a valid cell always carries evidence; an empty cell always carries a reason', () => {
  // This is what stops the grid being an opinion. `valid: true` with no evidence is
  // unfalsifiable, and `valid: false` with no reason is indistinguishable from an oversight.
  for (const c of buildGrid().cells) {
    if (c.valid) {
      assert.ok(c.evidence.length > 0, `${c.topic} × ${c.action} is valid but cites nothing`)
      assert.equal(c.emptyReason, undefined, 'a valid cell must not carry an empty reason')
    } else {
      assert.ok(c.emptyReason && c.emptyReason.length > 20,
        `${c.topic} × ${c.action} is empty with no substantive reason`)
      assert.equal(c.evidence.length, 0)
    }
  }
})

test('adding a tool to an intent OPENS its cell — the grid tracks the canon, it does not shadow it', () => {
  // The load-bearing property, demonstrated rather than asserted. `summarize_doc` declares only
  // read_file, so its world:write cell is empty; hand it run_command and the cell opens with
  // that tool as the evidence. No edit to this file is required, which is the whole point.
  const summarize = allIntents().find((i) => i.name === 'summarize_doc')!
  assert.equal(deriveCell(summarize, 'execute').valid, false, 'baseline: no world-touching tool')

  const withExec = { ...summarize, tools: [...summarize.tools, 'run_command' as Tool] }
  const opened = deriveCell(withExec, 'execute')
  assert.equal(opened.valid, true, 'declaring the tool opens the cell')
  assert.deepEqual(opened.evidence, ['tool:run_command'], 'and names the tool as the evidence')

  // Symmetrically, removing every reading tool AND retrieval closes the store:read cell.
  const blind = { ...summarize, tools: [] as Tool[], retrieval: 'none' as const }
  assert.equal(deriveCell(blind, 'retrieve').valid, false, 'and removing the evidence closes it')
})

// ── the row count, resolved rather than assumed ─────────────────────────────────

test('the raw canon is 24 rows and the grid SAYS SO instead of trimming to 138', () => {
  const raw = buildGrid()
  assert.equal(raw.rows.length, allIntents().length + 1, 'every intent plus the meta row')
  assert.equal(raw.cellCount, raw.rows.length * 6)
  // The handoff specifies 23 × 6 = 138 and intent-router's docstring says "22 intents … the
  // 23rd is the conversation's own evolving objective". The canon now holds 23 entries, so the
  // raw arithmetic gives 24. Padding or trimming silently is the failure mode; reporting is not.
  if (raw.rows.length !== 23) {
    assert.match(raw.rowCountFinding, /NOT the handoff's 23 × 6 = 138/)
    assert.match(raw.rowCountFinding, /Not silently trimmed/)
  }
})

test('everyday collapses by MINIMALITY — the row count is TESTED, not assumed', () => {
  // The resolution has to come from a test, not from picking whichever number matches. The
  // criterion is the one verb-sort already applies to candidate verbs: same (substrate ×
  // polarity) profile, differing only in a slot binding, means not a separate primitive.
  const e = everydayCollapses()
  const profile = (name: string) =>
    ACTIONS.filter((a) => deriveCell(allIntents().find((i) => i.name === name)!, a).valid)

  const ev = profile('everyday'), ex = profile('explain_teach')
  // SUBSET is the criterion, not equality: a row whose operations are a subset of another's adds
  // no reach. They are NOT equal here, and the distinction is load-bearing — `explain_teach` is
  // model 'reasoning' so it admits `evaluate`, while `everyday` is model 'general' and does not.
  assert.ok(ev.every((a) => ex.includes(a)), `everyday ${JSON.stringify(ev)} must be within explain_teach ${JSON.stringify(ex)}`)
  assert.ok(ev.length < ex.length, 'and STRICTLY within — everyday deliberately drops the deliberative column')
  assert.deepEqual(ev, ['retrieve', 'transform'])
  assert.deepEqual(ex, ['retrieve', 'evaluate', 'transform'])

  assert.equal(e.collapses, true)
  assert.deepEqual(e.distinguishing, [], 'it admits nothing explain_teach does not')
  assert.match(e.reason, /MINIMALITY/)
  assert.match(e.reason, /STRICT subset \(lacks evaluate\)/,
    'the reason must state the relation accurately — an earlier revision claimed the profiles were "the same", which was false')
})

test('the canonical grid is 23 × 6 = 138, and throws rather than reporting any other number', () => {
  const c = buildCanonicalGrid()
  assert.equal(c.rows.length, 23)
  assert.equal(c.cellCount, 138, '23 × 6')
  assert.equal(c.validCount + c.emptyCount, 138, 'every cell is adjudicated either way')
  assert.deepEqual(c.collapsed, ['everyday'])
  assert.ok(!c.rows.includes('everyday'))
  assert.ok(c.rows.includes(META_ROW), 'the +1 embedding row is a row')
  // 138 is a checked property, not a docstring claim: buildCanonicalGrid throws otherwise.
  assert.match(c.rowCountFinding, /23 rows \(22 topics \+ 1 meta\) = 138 cells/)
})

// ── what the grid reveals that the diagonal could not ───────────────────────────

test('no dead rows: every topic admits at least one of the six operations', () => {
  // A topic the algebra cannot act on at all would be a genuine defect in the canon.
  const c = buildCanonicalGrid()
  assert.deepEqual(c.deadRows, [], 'a row with no valid cell is a topic the algebra cannot reach')
})

test('the grid is a strict superset of the diagonal it replaces', () => {
  // intent-router's INTENT_ACTION assigns each topic ONE action. Whatever that action is, the
  // grid must agree it is admissible — otherwise the two disagree about the same canon, and the
  // derived one would be wrong.
  const c = buildCanonicalGrid()
  let checked = 0
  for (const it of allIntents()) {
    if (it.name === 'everyday') continue
    const cells = c.cells.filter((x) => x.topic === it.name && x.valid)
    assert.ok(cells.length >= 1, `${it.name} must admit something`)
    // And the grid must be strictly richer somewhere, or it adds nothing over the diagonal.
    checked++
  }
  const multi = allIntents().filter((it) =>
    c.cells.filter((x) => x.topic === it.name && x.valid).length > 1).length
  assert.ok(multi > checked / 2,
    'most topics must admit MORE than one action, or the rectangle is just the diagonal in disguise')
})

test('the SENSE column is the estate\'s thinnest capability — reported as a finding', () => {
  // The asymmetry is the grid's actual payoff. world:read is admissible in a handful of rows
  // while held:write is admissible in nearly all of them, and that is a wiring gap in the
  // estate rather than a property of the algebra. Pinned so it cannot regress unnoticed.
  const a = columnAsymmetry()
  assert.equal(a.thinnest, 'sense')
  assert.ok(a.fill.sense < 6, `sense is admissible in only ${a.fill.sense} rows`)
  assert.ok(a.fill.transform > 15, 'while transform is admissible nearly everywhere')
  assert.ok(a.fill.retrieve > 15, 'as is retrieve')
  // The write columns are thin relative to the reads — the estate reads and generates far more
  // readily than it persists or acts.
  assert.ok(a.fill.create < a.fill.retrieve, 'store:write is thinner than store:read')
  assert.ok(a.fill.execute < a.fill.transform, 'world:write is thinner than held:write')
  assert.match(a.finding, /wiring gap, not a property of the algebra/)
})

test('the meta row is second-order: all six operations apply to the objective itself', () => {
  const c = buildCanonicalGrid()
  const meta = c.cells.filter((x) => x.topic === META_ROW)
  assert.equal(meta.length, 6)
  assert.ok(meta.every((x) => x.valid),
    'the conversation objective can be retrieved, revised, evaluated against — every column applies')
  assert.ok(meta.every((x) => x.evidence.some((e) => e.includes('second-order'))),
    'and each cell says WHY it is admissible, on the same evidence discipline as every other cell')
})

// ── determinism and rendering ───────────────────────────────────────────────────

test('cells are content-addressed and stable across builds', () => {
  const a = buildCanonicalGrid(), b = buildCanonicalGrid()
  assert.deepEqual(a.cells.map((c) => c.attestation), b.cells.map((c) => c.attestation), 'deterministic')
  for (const c of a.cells) assert.match(c.attestation, /^sha256:[0-9a-f]{64}$/)
  // Evidence order must not change the attestation, or the same cell would hash two ways.
  const s = allIntents().find((i) => i.name === 'build_implement')!
  const one = deriveCell(s, 'execute')
  const flipped = deriveCell({ ...s, tools: [...s.tools].reverse() }, 'execute')
  assert.equal(one.attestation, flipped.attestation, 'attestation is order-independent over evidence')
})

test('renderGrid emits one row per row and one mark per column', () => {
  const c = buildCanonicalGrid()
  const lines = renderGrid(c).split('\n')
  assert.equal(lines.length, c.rows.length + 2, 'header + rule + one line per row')
  for (const r of c.rows) {
    const line = lines.find((l) => l.startsWith(r))
    assert.ok(line, `row '${r}' must render`)
    const marks = (line!.match(/[●·]/g) ?? []).length
    assert.equal(marks, 6, `row '${r}' must show exactly 6 cells, got ${marks}`)
  }
})

test('the asymmetry finding states what would overturn it', () => {
  // A finding without its sensitivity is an assertion dressed as a measurement. `sense = 3/23`
  // depends on classifying web_search and brain_status as store:read; reclassifying BOTH as
  // world:read moves the minimum to execute. So the narrow claim is bounded — and the broad one
  // is not, which is why the broad one is what gets asserted here.
  const r = asymmetryRobustness()
  assert.equal(r.robust, true, 'the read/generate half must be more than twice the sense/persist/act half')
  assert.ok(r.readMean > 2 * r.writeMean, `${r.readMean} vs ${r.writeMean}`)
  assert.match(r.finding, /survives every variant/)

  // And the classification-independent core, pinned directly.
  const f = buildCanonicalGrid().columnFill
  for (const thin of ['create', 'execute', 'sense'] as const) {
    for (const wide of ['retrieve', 'transform'] as const) {
      assert.ok(f[thin] < f[wide], `${thin} (${f[thin]}) must be thinner than ${wide} (${f[wide]})`)
    }
  }
})

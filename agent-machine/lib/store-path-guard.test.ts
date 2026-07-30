/**
 * The shared guard for the data-destructive test hazard described in lib/store-path-guard.ts.
 *
 * Two halves, because the hazard has two halves:
 *
 *   STATIC  — no lib module may bind a `~/.noetica` path to an eagerly-evaluated module-scope constant
 *             and also write. That is the shape that makes `npm test` rewrite the operator's real state.
 *   DYNAMIC — every module that HAS been converted must resolve its path LATE: an override set after the
 *             module was imported has to take effect. This is the half that catches a regression which
 *             still *looks* fixed — a `_storePath()` whose body reads a captured module-load constant.
 *
 * Both use `os.userInfo().homedir` as ground truth (via REAL_NOETICA_DIR). It reads the passwd database
 * and ignores $HOME, so a test that moves HOME cannot fake a pass. That property is the whole reason
 * #581 used it, and the reason sandboxing HOME is not an acceptable fix for this class.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  REAL_NOETICA_DIR, isInsideRealNoetica, isEagerHomeBinding, scanBindings, writingFiles,
} from './store-path-guard.js'

const LIB_DIR = __dirname   // CommonJS build target (house pattern; see canon-lookup.ts) — not import.meta

// ── the scanner must not count itself ───────────────────────────────────────────────────────────
// ONE literal, nothing else. This estate has been bitten by a ratchet that counted its own allowlist
// and only went green AFTER it was committed. store-path-guard.ts necessarily binds the real
// ~/.noetica dir at module scope (that IS its ground truth), so it genuinely matches the shape it
// looks for — the exclusion below is load-bearing, and the first test proves it still is.
const SELF = 'store-path-guard.ts'

/**
 * Modules that still carry the hazard and are NOT fixed by this change. This list is a RATCHET: it may
 * only ever shrink. Adding to it is how the guard gets defeated, so a new entry must be argued for in
 * review, and a stale entry FAILS the last test in this file rather than rotting quietly.
 */
const DEFERRED: Record<string, string> = {
  // (dispatch-ledger.ts was deferred to fix/dispatch-ledger-home-and-replay; that lane landed in #575
  //  which converted it to noeticaHome() — no longer hazardous, so removed from DEFERRED here.)
  // Not in the original sweep's write-capable set; found by this scanner because at-rest.appendJsonl
  // and the device/model/voice writers count as writes. Real, unfixed, and each needs its own review.
  'device-attestation.ts': 'device keypair dir — needs its own review of the key-rotation path',
  'dialogue-tracker.ts': 'analytics dir',
  'encrypted-vector-store.ts': 'DB path + a second binding of the at-rest key path',
  'managed-ollama.ts': 'models + runtime dirs, multi-GB — needs a provisioning-side review',
  'qa-pairs.ts': 'training corpus (appendJsonl); mis-classified read-only in the original sweep',
  'stt.ts': 'models dir, shared with managed-ollama',
  'voice-runtime.ts': 'voice dir',
}

/** Eager module-scope `~/.noetica` bindings that only ever READ. Lower priority than the writers, but
 *  tracked so the set cannot grow unnoticed. `SELF` is excluded before this comparison. */
const READ_ONLY_EAGER = ['academic-graph.ts']

// ── 0. the detector itself, before any zero from it is trusted ──────────────────────────────────
// A scanner that has only ever reported "clean" proves nothing, and a mangled pattern reports clean.
// rg/grep are shimmed in this environment and produce false negatives, which is why this is a Node
// walker — but a walker is not automatically safer, so pin its behaviour on both sides.
test('store-path guard: the detector recognises the hazard shape (known positives)', () => {
  const positives = [
    `const STORE = path.join(os.homedir(), '.noetica', 'a2a-trust.json')`,
    `const EVENTS_PATH = process.env['SCOPED_EVENTS'] ?? path.join(os.homedir(), '.noetica', 'e.jsonl')`,
    `export const DIR = join(homedir(), '.noetica', 'analytics')`,
    `const KEY_DIR: string = path.join(os.userInfo().homedir, ".noetica")`,
  ]
  for (const p of positives) assert.equal(isEagerHomeBinding(p), true, `MISSED a known positive: ${p}`)
})

test('store-path guard: the detector does not fire on the safe shapes (known negatives)', () => {
  const negatives = [
    // Lazy — the fix shape. agent-registry.ts has always been this, which is the only reason its
    // HOME-moving test worked while open-chat-index.test.ts's identical one silently did not.
    `const STORE = (): string => path.join(os.homedir(), '.noetica', 'agents.json')`,
    `const blobDir = (): string => process.env['NOETICA_BLOB_DIR'] || join(homedir(), '.noetica', 'blobs')`,
    // Not module scope — a local inside a function is resolved per call by construction.
    `  const p = path.join(os.homedir(), '.noetica', 'x')`,
    // A home path that is not the sovereign data dir.
    `const DEV_ROOT = path.join(os.homedir(), 'dev')`,
  ]
  for (const n of negatives) assert.equal(isEagerHomeBinding(n), false, `FALSE POSITIVE on: ${n}`)
})

test('store-path guard: the scanner rejects a file where a directory is required', () => {
  // A lane tonight got a false negative by passing a file path to a directory walker and reading the
  // empty result as "clean". Make that a throw, never a zero.
  assert.throws(() => scanBindings(path.join(LIB_DIR, SELF)), /DIRECTORY/)
})

// ── 1. the self-exclusion must stay load-bearing ────────────────────────────────────────────────
test('store-path guard: the scanner still matches ITSELF, so excluding it is not a no-op', () => {
  const raw = scanBindings(LIB_DIR)
  assert.ok(
    raw.some((b) => b.file === SELF),
    `${SELF} no longer matches the hazard shape. The self-exclusion below is now vacuous — DELETE it ` +
    `rather than leave a filter that quietly removes nothing.`,
  )
})

// ── 2. the ratchet ──────────────────────────────────────────────────────────────────────────────
test('store-path guard: no lib module freezes a writable ~/.noetica path at module load', () => {
  const bindings = scanBindings(LIB_DIR).filter((b) => b.file !== SELF && !b.file.endsWith('.test.ts'))
  const writers = writingFiles(LIB_DIR)

  const hazards = [...new Set(bindings.filter((b) => writers.has(b.file)).map((b) => b.file))].sort()
  const unregistered = hazards.filter((f) => !(f in DEFERRED))

  const detail = unregistered
    .map((f) => `  ${f}\n` + bindings.filter((b) => b.file === f).map((b) => `      line ${b.line}: ${b.text}`).join('\n'))
    .join('\n')

  assert.deepEqual(unregistered, [],
    `\n${unregistered.length} module(s) freeze a ~/.noetica path into a module-load constant AND write to it.\n` +
    `Running the test suite will write the OPERATOR'S REAL STATE.\n\n${detail}\n\n` +
    `Fix: replace the constant with a resolver that reads the path on EVERY access, plus a per-module\n` +
    `env override — the _storePath() pattern from PR #581:\n\n` +
    `    export function _storePath(): string {\n` +
    `      return process.env['NOETICA_X_STORE'] || path.join(os.homedir(), '.noetica', 'x.json')\n` +
    `    }\n\n` +
    `Do NOT "fix" this by setting process.env.HOME in a test hook. A before() hook runs AFTER the\n` +
    `module graph has loaded, so the constant has already resolved and the sandbox silently misses.\n`)
})

test('store-path guard: the read-only eager bindings are exactly the registered set', () => {
  const bindings = scanBindings(LIB_DIR).filter((b) => b.file !== SELF && !b.file.endsWith('.test.ts'))
  const writers = writingFiles(LIB_DIR)
  const readOnly = [...new Set(bindings.filter((b) => !writers.has(b.file)).map((b) => b.file))].sort()
  assert.deepEqual(readOnly, [...READ_ONLY_EAGER].sort(),
    'a read-only module started freezing a ~/.noetica path (or a tracked one changed). ' +
    'These do not destroy data today, but the shape is one write call away from doing so.')
})

// ── 3. every converted module must resolve LATE ─────────────────────────────────────────────────
/** module specifier → [exported resolver, env override]. Every entry the sweep converted. */
const CONVERTED: [string, string, string][] = [
  ['./a2a-trust.js', '_storePath', 'NOETICA_A2A_STORE'],                      // PR #581
  ['./agent-runs.js', '_runsPath', 'NOETICA_AGENT_RUNS_STORE'],
  ['./agent-runs.js', '_routinesPath', 'NOETICA_ROUTINES_STORE'],
  ['./at-rest.js', '_keyPath', 'NOETICA_AT_REST_KEY'],
  ['./audit-key.js', '_keyDir', 'NOETICA_AUDIT_KEY_DIR'],
  ['./collections.js', '_storePath', 'NOETICA_COLLECTIONS_STORE'],
  ['./concept-defs.js', '_storeDir', 'NOETICA_CONCEPTS_DIR'],
  ['./graph-cluster.js', '_cacheDir', 'NOETICA_GRAPH_CLUSTER_CACHE_DIR'],
  ['./graph-replica.js', '_replicaPath', 'NOETICA_GRAPH_REPLICA_STORE'],
  ['./identity.js', '_identityPath', 'NOETICA_IDENTITY_STORE'],
  ['./ocr.js', '_binDir', 'NOETICA_OCR_BIN_DIR'],
  ['./open-chat-index.js', '_storePath', 'NOETICA_OPEN_CHATS_STORE'],
  ['./proof-fabric.js', '_proofsDir', 'NOETICA_PROOFS_DIR'],
  ['./redact.js', '_policyPath', 'NOETICA_PRIVACY_POLICY'],
  ['./routing-log.js', '_logPath', 'NOETICA_ROUTING_LOG_PATH'],
  ['./scope-d.js', '_eventsPath', 'SCOPED_EVENTS'],
  ['./self-model.js', '_snapshotPath', 'NOETICA_SELF_MODEL_STORE'],
  ['./solution-memory.js', '_dir', 'NOETICA_SOLUTION_MEMORY_DIR'],
  ['./sovereign-id.js', '_rootPath', 'NOETICA_SOVEREIGN_ROOT'],
]

test('store-path guard: an override set AFTER import redirects every converted store', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noetica-store-guard-'))
  try {
    for (const [spec, fnName, envVar] of CONVERTED) {
      // Import FIRST, set the override AFTER. This is the exact ordering that defeated the
      // process.env.HOME sandbox in open-chat-index.test.ts, so it is the ordering worth proving.
      const mod = await import(spec) as Record<string, unknown>
      const resolve = mod[fnName]
      assert.equal(typeof resolve, 'function', `${spec} does not export ${fnName}() — the resolver was renamed or removed`)

      const saved = process.env[envVar]
      const want = path.join(tmp, `${fnName}-${path.basename(spec, '.js')}`)
      try {
        process.env[envVar] = want
        const got = (resolve as () => string)()
        assert.equal(got, want,
          `${spec} ${fnName}() ignored ${envVar} set after import — the path is still frozen at module load`)
        assert.equal(isInsideRealNoetica(got), false,
          `${spec} ${fnName}() resolved inside the operator's REAL sovereign dir: ${got}`)
      } finally {
        if (saved === undefined) delete process.env[envVar]
        else process.env[envVar] = saved
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('store-path guard: with no override the default IS production (teeth both ways)', async () => {
  // The fix must not be a blanket redirect. With nothing injected, each resolver must still point at
  // the real sovereign dir — otherwise the product would silently stop reading the operator's data.
  // These resolvers are pure, so calling them writes nothing.
  const saved: Record<string, string | undefined> = {}
  for (const [, , envVar] of CONVERTED) { saved[envVar] = process.env[envVar]; delete process.env[envVar] }
  try {
    for (const [spec, fnName] of CONVERTED) {
      const mod = await import(spec) as Record<string, () => string>
      const got = (mod[fnName] as () => string)()
      const rel = path.relative(path.join(os.homedir(), '.noetica'), got)
      assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel),
        `${spec} ${fnName}() no longer defaults into ~/.noetica (got ${got}) — the product would stop ` +
        `reading the operator's real data`)
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
})

// ── 4. the deferral list must shrink, never rot ─────────────────────────────────────────────────
test('store-path guard: every DEFERRED entry still actually carries the hazard', () => {
  const bindings = scanBindings(LIB_DIR).filter((b) => b.file !== SELF && !b.file.endsWith('.test.ts'))
  const writers = writingFiles(LIB_DIR)
  const stillHazardous = new Set(bindings.filter((b) => writers.has(b.file)).map((b) => b.file))
  const fixed = Object.keys(DEFERRED).filter((f) => !stillHazardous.has(f)).sort()
  assert.deepEqual(fixed, [],
    `these are no longer hazardous — good. Delete them from DEFERRED so the list keeps shrinking ` +
    `instead of quietly blessing modules that no longer need it: ${fixed.join(', ')}`)
})

test('store-path guard: REAL_NOETICA_DIR ignores $HOME', () => {
  // The property the whole guard rests on. os.homedir() honours $HOME; userInfo() reads passwd.
  const saved = process.env['HOME']
  try {
    process.env['HOME'] = path.join(os.tmpdir(), 'not-the-real-home')
    assert.equal(REAL_NOETICA_DIR, path.join(os.userInfo().homedir, '.noetica'))
    assert.equal(isInsideRealNoetica(path.join(process.env['HOME'], '.noetica', 'x.json')), false)
    assert.equal(isInsideRealNoetica(path.join(REAL_NOETICA_DIR, 'x.json')), true)
  } finally {
    if (saved === undefined) delete process.env['HOME']; else process.env['HOME'] = saved
  }
})

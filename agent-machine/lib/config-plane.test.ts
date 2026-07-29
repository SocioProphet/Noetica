// Every test runs against a throwaway NOETICA_HOME — never the operator's real ~/.noetica.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Both modules resolve NOETICA_HOME lazily (per call), so setting it here governs every
// test regardless of import order.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'noetica-cfg-'))
process.env['NOETICA_HOME'] = HOME

import { explain, isEnabled, isModelEnabled, refresh, configReport, DEFAULT_FLAGS } from './config-plane.js'
import { migrate, readState, recordUsage, usageSnapshot, noeticaHome } from './local-state.js'

const write = (name: string, obj: unknown): void =>
  fs.writeFileSync(path.join(HOME, name), JSON.stringify(obj))
const clear = (name: string): void => fs.rmSync(path.join(HOME, name), { force: true })

function snapshot(flags: Record<string, unknown>, models: Record<string, boolean> = {}, agoSec = 0): void {
  write('config-cache.json', {
    flags, models, source: 'test', scope: { app: 'noetica' },
    fetchedAt: new Date(Date.now() - agoSec * 1000).toISOString(),
  })
}

test('home resolver honours NOETICA_HOME (tests never touch the real dir)', () => {
  assert.equal(noeticaHome(), HOME)
})

// ── the precedence chain IS the sovereignty guarantee ───────────────────────────
test('built-in default decides when nothing else has spoken', () => {
  clear('config-cache.json'); clear('config-override.json')
  const e = explain('voice.wake_word')
  assert.equal(e.decidedBy, 'default')
  assert.equal(e.value, DEFAULT_FLAGS['voice.wake_word'])
  assert.equal(e.snapshotAgeSec, null, 'never fetched → null age, not a fake zero')
})

test('remote beats default', () => {
  snapshot({ 'voice.wake_word': true })
  const e = explain('voice.wake_word')
  assert.equal(e.decidedBy, 'remote')
  assert.equal(e.value, true)
  assert.ok(e.snapshotAgeSec !== null && e.snapshotAgeSec < 5)
})

test('env beats remote', () => {
  snapshot({ 'voice.wake_word': true })
  process.env['NOETICA_FLAG_VOICE_WAKE_WORD'] = 'false'
  try {
    const e = explain('voice.wake_word')
    assert.equal(e.decidedBy, 'env')
    assert.equal(e.value, false)
  } finally { delete process.env['NOETICA_FLAG_VOICE_WAKE_WORD'] }
})

test('LOCAL OVERRIDE beats everything — the operator keeps the last word', () => {
  snapshot({ 'voice.wake_word': false })
  process.env['NOETICA_FLAG_VOICE_WAKE_WORD'] = 'false'
  write('config-override.json', { flags: { 'voice.wake_word': true } })
  try {
    const e = explain('voice.wake_word')
    assert.equal(e.decidedBy, 'local-override')
    assert.equal(e.value, true, 'the fleet said off, the machine says on, the machine wins')
    assert.equal(e.overridable, true)
  } finally {
    delete process.env['NOETICA_FLAG_VOICE_WAKE_WORD']
    clear('config-override.json')
  }
})

test('capability-surface guard: a snapshot cannot introduce a flag this build never shipped', () => {
  snapshot({ 'capability.from_the_future': true })
  assert.equal(isEnabled('capability.from_the_future'), false, 'unknown flag falls back, never trusts the wire')
  const e = explain('capability.from_the_future')
  assert.equal(e.decidedBy, 'default')
  assert.equal(e.remoteProposed, true, 'but the rejected proposal is reported, not silently dropped')
})

// ── kill-switches ───────────────────────────────────────────────────────────────
test('per-model kill-switch disables a model without a release', () => {
  clear('config-override.json')
  snapshot({}, { 'qwen2.5:7b': false })
  assert.equal(isModelEnabled('qwen2.5:7b'), false)
  assert.equal(isModelEnabled('llama3.2:3b'), true, 'unlisted models stay enabled')
})

test('local override can re-enable a fleet-disabled model', () => {
  snapshot({}, { 'qwen2.5:7b': false })
  write('config-override.json', { models: { 'qwen2.5:7b': true } })
  try { assert.equal(isModelEnabled('qwen2.5:7b'), true) } finally { clear('config-override.json') }
})

// ── offline-first ───────────────────────────────────────────────────────────────
test('refresh is fail-soft: unreachable plane leaves the last good snapshot in force', async () => {
  snapshot({ 'federation.enabled': true }, {}, 120)
  const after = await refresh({ url: 'http://127.0.0.1:1/nope', timeoutMs: 250 })
  assert.equal(after?.flags['federation.enabled'], true, 'previous snapshot still governs')
  const e = explain('federation.enabled')
  assert.equal(e.decidedBy, 'remote')
  assert.ok((e.snapshotAgeSec ?? 0) >= 120, 'and its age is visible, not hidden')
})

test('configReport surfaces provenance for every flag', () => {
  clear('config-override.json')
  snapshot({ 'memory.banded': true })
  const r = configReport()
  assert.ok(r.flags.length >= Object.keys(DEFAULT_FLAGS).length)
  assert.ok(r.flags.every((f) => typeof f.decidedBy === 'string'), 'each flag names its decider')
  assert.equal(r.overrideActive, false)
  assert.ok(r.snapshot.fetchedAt, 'snapshot is stamped')
})

// ── local state: migrations + usage ledger ──────────────────────────────────────
test('migrations run once, in order, and are recorded by name', () => {
  const s1 = migrate()
  assert.ok(s1.migrationVersion >= 1)
  assert.ok(s1.applied.includes('0001-adopt-state-file'))
  const adopted = s1.adoptedAt
  const s2 = migrate()          // idempotent
  assert.deepEqual(s2.applied, s1.applied)
  assert.equal(s2.adoptedAt, adopted, 're-running must not rewrite history')
})

test('the demo-neuter migration clears the stale marker that silently disabled inference', () => {
  const marker = path.join(HOME, 'demo-no-models')
  fs.writeFileSync(marker, '')
  // forget that migration so it re-runs against the marker we just planted
  const state = readState()
  const kept = state.applied.filter((n) => n !== '0002-clear-demo-neuter-marker')
  fs.writeFileSync(path.join(HOME, 'state.json'),
    JSON.stringify({ ...state, applied: kept, migrationVersion: 1 }))
  migrate()
  assert.equal(fs.existsSync(marker), false, 'stale state must not outlive the build that wrote it')
  assert.ok(readState().notes.some((n) => n.includes('demo marker')), 'and the cleanup is recorded')
})

test('usage ledger counts and ranks — the signal receipts deliberately do not carry', () => {
  recordUsage('surface:govern')
  recordUsage('surface:govern')
  recordUsage('surface:chat')
  const top = usageSnapshot()
  assert.equal(top[0]?.key, 'surface:govern')
  assert.equal(top[0]?.count, 2)
  assert.ok(top[0]?.firstUsedAt && top[0]?.lastUsedAt)
})

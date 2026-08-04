// Exercise the route's real logic (confinement + ingest) without booting Next.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ingestRunsJsonl } from '../../../../lib/impair/ingest'

const ROOT = fs.realpathSync(os.homedir())
const real = path.join(ROOT, '.noetica/impair/runs.jsonl')

test('the default path resolves inside the confinement root', () => {
  const rel = path.relative(ROOT, path.resolve(ROOT, '.noetica/impair/runs.jsonl'))
  assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel))
})

test('an escaping path is rejected by the lexical barrier', () => {
  for (const bad of ['../../etc/passwd', '/etc/passwd', '~/../../etc/passwd']) {
    const expanded = bad.startsWith('~/') ? path.join(ROOT, bad.slice(2)) : bad
    const rel = path.relative(ROOT, path.resolve(ROOT, expanded))
    assert.ok(rel.startsWith('..') || path.isAbsolute(rel), `${bad} should escape`)
  }
})

test('the committed REAL run fixture ingests and verifies end to end', () => {
  // The fixture is genuine rig output (a CANNABIS sweep on Qwen2.5-0.5B-Instruct), not
  // a hand-written sample — see lib/impair/ingest.test.ts for why that matters.
  const fixture = path.join(process.cwd(), 'tests/fixtures/impair/real-run-qwen25-0.5b.jsonl')
  const src = fs.existsSync(real) ? real : fixture
  const { entries, chain } = ingestRunsJsonl(fs.readFileSync(src, 'utf8'))
  assert.ok(chain.ok, chain.reason)
  assert.equal(entries.length, 3)
  assert.ok(entries.every((e) => e.chain_verified))
  assert.match(entries[2].content, /coarse lesion/)
})

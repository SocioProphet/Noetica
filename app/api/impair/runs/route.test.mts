// Exercise the route's real logic (confinement + ingest) without booting Next.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ingestRunsJsonl } from '../../../../lib/impair/ingest'

const ROOT = fs.realpathSync(os.homedir())
const real = path.join(ROOT, '.noetica/impair/runs.jsonl')

test('the route takes NO user-supplied path', () => {
  // The strongest version of the confinement argument: there is no input to confine.
  // An earlier version accepted ?path= and guarded it; a guarded injection surface is
  // still an injection surface, and reading request.url also broke the static export.
  const raw = fs.readFileSync(
    path.join(process.cwd(), 'app/api/impair/runs/route.ts'), 'utf8')
  // Strip comments before asserting — the file DOCUMENTS why it avoids request.url,
  // and matching that prose would fail the test for saying the right thing.
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.ok(!/searchParams|request\.url|req\.url/.test(code),
    'the route must not read a user-supplied path')
  assert.match(code, /const RUNS_PATH = /)
  assert.match(code, /export async function GET\(\)/, 'GET takes no request arg')
})

test('the route is statically exportable', () => {
  // force-dynamic broke the whole Tauri build, not just this route.
  const src = fs.readFileSync(
    path.join(process.cwd(), 'app/api/impair/runs/route.ts'), 'utf8')
  assert.match(src, /export const dynamic = 'force-static'/)
  assert.ok(!/force-dynamic/.test(src))
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

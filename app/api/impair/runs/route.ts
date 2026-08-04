/**
 * Serve impairment-rig provenance to the governance trail.
 *
 * `lib/impair/ingest.ts` could read a runs.jsonl and verify it, but nothing called it —
 * the data path existed with no caller, which is a strand with extra steps. This is the
 * caller.
 *
 * ── Confinement ──────────────────────────────────────────────────────────────
 *
 * The path comes from a query parameter over local HTTP, so an absolute path or a `..`
 * escape would otherwise turn this into an arbitrary-file-read (js/path-injection).
 * It reuses `app/api/agent-tool/path-confine` rather than adding a THIRD copy of the
 * primitive — that module documents at length why a second copy already exists and why
 * more would be worse, and a security check whose copies drift apart is how you end up
 * with two validators that have opposite blind spots.
 *
 * ── Verification is not optional here ────────────────────────────────────────
 *
 * The route returns the chain verdict alongside the entries and sets `X-Chain-Verified`,
 * so a caller cannot render the trail without also receiving whether the evidence
 * verified. Returning entries alone would let a UI display tampered records as sound.
 */

import { NextResponse } from 'next/server'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { realPathWithinRoot } from '../../agent-tool/path-confine'
import { ingestRunsJsonl } from '@/lib/impair/ingest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ROOT = fs.realpathSync(os.homedir())

/** Where a local rig run writes by default, relative to the confinement root. */
const DEFAULT_REL = '.noetica/impair/runs.jsonl'

function resolveConfined(rel: string | null): { path?: string; error?: string } {
  const requested = rel && rel.trim() ? rel.trim() : DEFAULT_REL
  // Lexical containment BEFORE any filesystem access, then a symlink-safe realpath —
  // the same order the agent-tool route uses, and the order CodeQL recognises.
  const expanded = requested.startsWith('~/') ? path.join(ROOT, requested.slice(2)) : requested
  const resolved = path.resolve(ROOT, expanded)
  const relFromRoot = path.relative(ROOT, resolved)
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    return { error: 'path escapes the confinement root' }
  }
  const real = realPathWithinRoot(resolved, ROOT)
  if (!real) return { error: 'path escapes the confinement root (symlink)' }
  return { path: real }
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const { path: file, error } = resolveConfined(url.searchParams.get('path'))
  if (error) {
    return NextResponse.json({ error }, { status: 400 })
  }
  if (!file || !fs.existsSync(file)) {
    // Absence is a normal state — no runs yet — and must not read as a failure.
    return NextResponse.json(
      {
        entries: [],
        chain: { ok: true, verified: 0, reason: 'no runs recorded yet' },
        source: null,
      },
      { headers: { 'X-Chain-Verified': 'true' } },
    )
  }

  try {
    const { entries, chain } = ingestRunsJsonl(fs.readFileSync(file, 'utf8'))
    return NextResponse.json(
      { entries, chain, source: path.relative(ROOT, file) },
      {
        // Surfaced as a header too, so a caller that ignores the body still cannot
        // present unverified evidence as verified.
        headers: { 'X-Chain-Verified': String(chain.ok) },
        status: chain.ok ? 200 : 409,
      },
    )
  } catch (e) {
    return NextResponse.json(
      { error: `could not parse runs.jsonl: ${e instanceof Error ? e.message : String(e)}` },
      { status: 422 },
    )
  }
}

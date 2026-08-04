/**
 * Serve impairment-rig provenance to the governance trail.
 *
 * `lib/impair/ingest.ts` could read a runs.jsonl and verify it, but nothing called it —
 * the data path existed with no caller, which is a strand with extra steps. This is the
 * caller.
 *
 * ── No user-supplied path, by design ─────────────────────────────────────────
 *
 * An earlier version took the path as a query parameter and guarded it with the
 * agent-tool confinement helper. Two things killed that:
 *
 *   1. reading `request.url` makes the route un-prerenderable, and the desktop frontend
 *      is built with `output: 'export'` — so the whole Tauri build failed, not just this
 *      route;
 *   2. more importantly, a guarded injection surface is still an injection surface. The
 *      only path this route ever needs is the rig's own output location.
 *
 * So the location is a constant. There is no user input to confine, which is strictly
 * safer than confining it well.
 *
 * ── Verification is not optional ─────────────────────────────────────────────
 *
 * The chain verdict is returned alongside the entries and as `X-Chain-Verified`, so a
 * caller cannot render the trail without also receiving whether the evidence verified.
 * Returning entries alone would let a UI display tampered records as sound.
 *
 * ── What static export costs, stated plainly ─────────────────────────────────
 *
 * Under `output: 'export'` this route is PRERENDERED at build time, so the packaged
 * desktop app serves whatever existed when the bundle was built — in practice the empty
 * state. Live provenance in the desktop app needs an agent-machine endpoint, which is
 * how every other live surface here reaches data (see `components/sae/FeatureExplorer`
 * using `amUrl()`). That is a deliberate follow-up, not something to fake by presenting
 * a stale snapshot as fresh. In server mode the route reads on each request.
 */

import { NextResponse } from 'next/server'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { ingestRunsJsonl } from '@/lib/impair/ingest'

export const runtime = 'nodejs'
export const dynamic = 'force-static'

/** The rig's own output location. Not configurable, so there is nothing to inject. */
const RUNS_PATH = path.join(os.homedir(), '.noetica', 'impair', 'runs.jsonl')

export async function GET() {
  if (!fs.existsSync(RUNS_PATH)) {
    // Absence is a normal state — no runs yet — and must not read as a failure.
    return NextResponse.json(
      { entries: [], chain: { ok: true, verified: 0, reason: 'no runs recorded yet' }, source: null },
      { headers: { 'X-Chain-Verified': 'true' } },
    )
  }

  try {
    const { entries, chain } = ingestRunsJsonl(fs.readFileSync(RUNS_PATH, 'utf8'))
    return NextResponse.json(
      { entries, chain, source: '~/.noetica/impair/runs.jsonl' },
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

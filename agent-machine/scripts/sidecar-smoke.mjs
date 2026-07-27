#!/usr/bin/env node
/**
 * sidecar-smoke — launch the BUILT agent-machine binary and assert the bundled sidecars
 * actually resolve on this platform.
 *
 * Why this exists: both Rust sidecars were invisible on every Windows install because the
 * lookup probed `noetica-embed` while Tauri ships `noetica-embed.exe` (#556). Nothing errored
 * — the fallbacks are graceful by design — so CI stayed green, the installer built fine, and
 * the only symptom was "embeddings are slow" reported by a user weeks later. Unit tests over
 * the path logic can't catch the packaging half of that; this runs the real binary and asks it.
 *
 * Usage:
 *   node scripts/sidecar-smoke.mjs <path-to-agent-machine-binary>
 *   node scripts/sidecar-smoke.mjs --stage <binaries-dir> --triple <target-triple>
 *
 * `--stage` mirrors the INSTALL layout out of a Tauri `binaries/` directory: it copies
 * `<name>-<triple><exe>` to `<name><exe>` in a temp dir, which is exactly the rename Tauri
 * performs when bundling. That rename is where the Windows bug lived, so reproducing it is
 * the point — and it keeps each CI job a single line instead of duplicated staging bash.
 *
 * Exits non-zero with a diagnosis on failure. Exits 0 with a notice when sidecars were not
 * built at all (they're best-effort in several jobs — absence must not turn a soft dependency
 * into a hard one; only a sidecar that exists but cannot be RESOLVED is a failure).
 */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const argv = process.argv.slice(2)
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
const stageDir = flag('--stage')
const triple = flag('--triple')

const PORT = Number(process.env.SMOKE_PORT || 8099)
const EXPECTED_SUFFIX = process.platform === 'win32' ? '.exe' : ''
const SIDECARS = ['noetica-embed', 'noetica-operator']

let bin = argv[0] && !argv[0].startsWith('--') ? argv[0] : null

if (stageDir) {
  if (!triple) { console.error('[smoke] FAIL: --stage requires --triple'); process.exit(1) }
  if (!fs.existsSync(stageDir)) { console.error(`[smoke] FAIL: --stage dir not found: ${stageDir}`); process.exit(1) }
  const src = (n) => path.join(stageDir, `${n}-${triple}${EXPECTED_SUFFIX}`)
  const amSrc = src('agent-machine')
  if (!fs.existsSync(amSrc)) {
    console.error(`[smoke] FAIL: agent-machine binary not found: ${amSrc}`)
    console.error(`[smoke] contents: ${fs.readdirSync(stageDir).join(', ')}`)
    process.exit(1)
  }
  const built = SIDECARS.filter((n) => fs.existsSync(src(n)))
  if (built.length < SIDECARS.length) {
    const absent = SIDECARS.filter((n) => !built.includes(n))
    console.log(`[smoke] SKIP: sidecar(s) not built for ${triple}: ${absent.join(', ')} (best-effort build) — nothing to assert`)
    process.exit(0)
  }
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'noetica-smoke-'))
  // The install-layout rename: `<name>-<triple><exe>` → `<name><exe>`.
  fs.copyFileSync(amSrc, path.join(dest, `agent-machine${EXPECTED_SUFFIX}`))
  for (const n of SIDECARS) fs.copyFileSync(src(n), path.join(dest, `${n}${EXPECTED_SUFFIX}`))
  for (const f of fs.readdirSync(dest)) fs.chmodSync(path.join(dest, f), 0o755)
  bin = path.join(dest, `agent-machine${EXPECTED_SUFFIX}`)
  console.log(`[smoke] staged ${triple} install layout → ${dest}`)
}

if (!bin || !fs.existsSync(bin)) {
  console.error(`[smoke] FAIL: agent-machine binary not found: ${bin ?? '<no argument>'}`)
  process.exit(1)
}

const dir = path.dirname(path.resolve(bin))

// The sidecars must be staged beside the binary, exactly as the installer lays them out.
const expected = SIDECARS.map((n) => ({ name: n, file: `${n}${EXPECTED_SUFFIX}` }))
const missingOnDisk = expected.filter((e) => !fs.existsSync(path.join(dir, e.file)))
if (missingOnDisk.length) {
  console.error(`[smoke] FAIL: sidecar(s) not staged beside the binary in ${dir}:`)
  for (const m of missingOnDisk) console.error(`  missing ${m.file}`)
  console.error(`[smoke] contents: ${fs.readdirSync(dir).join(', ')}`)
  process.exit(1)
}
console.log(`[smoke] staged beside binary: ${expected.map((e) => e.file).join(', ')}`)

const child = spawn(bin, [], {
  // NOETICA_AM_PORT is the port knob (not PORT). An EMPTY NOETICA_PREWARM_MODELS skips the
  // model prewarm entirely — CI has no Ollama, and we only care whether the sidecars resolve.
  env: { ...process.env, NOETICA_AM_PORT: String(PORT), NOETICA_PREWARM_MODELS: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
child.stdout.on('data', (d) => { log += d.toString() })
child.stderr.on('data', (d) => { log += d.toString() })

const cleanup = () => { try { child.kill() } catch { /* already gone */ } }
process.on('exit', cleanup)

function fail(msg) {
  console.error(`[smoke] FAIL: ${msg}`)
  if (log.trim()) console.error(`[smoke] --- agent-machine output ---\n${log.trim().slice(-4000)}`)
  cleanup()
  process.exit(1)
}

// Boot can take a while on a cold CI runner (storage attach). Poll rather than sleep-and-hope.
const deadline = Date.now() + 90_000
let status = null
while (Date.now() < deadline) {
  if (child.exitCode !== null) fail(`agent-machine exited early with code ${child.exitCode}`)
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/status`, { signal: AbortSignal.timeout(3000) })
    if (r.ok) {
      const j = await r.json()
      if (j.booted) { status = j; break }
    }
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 1000))
}
if (!status) fail('agent-machine never reported booted=true within 90s')

console.log(`[smoke] booted v${status.version} on :${PORT}`)

// The reported version must be the REAL one. It was hardcoded at '0.4.21' while the app shipped
// 0.4.24, so field reports carried a false version — a user's log said v0.4.21, which made a bug
// already fixed in 0.4.23 look unfixed and pointed triage at the wrong build. A version string
// nobody can trust is worse than no version string.
const pkgVersion = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
).version
if (status.version !== pkgVersion) {
  fail(`/api/status reports v${status.version} but package.json says v${pkgVersion} — the version is stale/hardcoded`)
}
console.log(`[smoke] version matches package.json (${pkgVersion})`)

const sc = status.sidecars
if (!sc) fail('/api/status has no `sidecars` field — the status contract regressed')

const problems = []
for (const key of ['embed', 'operator']) {
  const s = sc[key]
  if (!s) { problems.push(`sidecars.${key} missing from /api/status`); continue }
  if (!s.available) { problems.push(`sidecars.${key}.available=false — the runtime cannot find its binary`); continue }
  // THE regression guard: the resolved binary must carry this platform's executable suffix.
  if (EXPECTED_SUFFIX && !String(s.binary).endsWith(EXPECTED_SUFFIX)) {
    problems.push(`sidecars.${key}.binary="${s.binary}" does not end with "${EXPECTED_SUFFIX}"`)
  }
  console.log(`[smoke] ${key}: available=${s.available} binary=${s.binary}`)
}
if (problems.length) fail(problems.join('; '))

console.log('[smoke] PASS — both sidecars resolved with the correct platform suffix')
cleanup()
process.exit(0)

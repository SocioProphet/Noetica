#!/usr/bin/env node
/**
 * Verify that a published release is actually INSTALLABLE, and say why when it is not.
 *
 * A green release job means "the artifacts were produced". It does not mean a person
 * can install them. Those came apart here: v0.4.24 built cleanly, published five
 * assets, and could not be installed on macOS or Windows because nothing was signed —
 * a failure invisible to every check that existed.
 *
 * The checks below are the ones that decide whether a download turns into a running
 * app:
 *
 *   version    every version source agrees with the tag, and the release moves forward
 *   macos      Gatekeeper accepts it (adhoc signing is REJECTED, not merely warned)
 *   windows    an Authenticode certificate is actually present
 *   linux      control metadata is sane, sidecars are in the payload, deps are portable
 *
 * ── The part that matters for automation ──────────────────────────────────────
 *
 * Every failure is classified RETRIABLE or TERMINAL, because "recut the job on
 * failure" is only correct for one of them.
 *
 *   RETRIABLE  a rerun could plausibly fix it — an upload dropped, a runner died
 *              mid-job, an asset is truncated. Recut it.
 *   TERMINAL   a rerun changes nothing because the cause is configuration or code —
 *              no signing certificate is configured, a dependency is pinned to a
 *              library that does not exist on the target distro, a version source was
 *              never stamped. Recutting these burns runner minutes forever and buries
 *              the real signal under identical failures.
 *
 * Getting that distinction wrong is how a "self-healing" pipeline becomes a machine
 * that hides a broken release behind an infinite retry loop.
 *
 * Usage:
 *   node scripts/verify-release-artifacts.mjs --tag v0.4.24 [--dir ./artifacts]
 *                                             [--json out.json] [--previous v0.4.23]
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const RETRIABLE = 'retriable'
const TERMINAL = 'terminal'

/** @type {{id:string,ok:boolean,severity:string|null,detail:string,klass:string|null}[]} */
const results = []

function record(id, ok, detail, klass = null) {
  results.push({ id, ok, detail, klass: ok ? null : klass })
  const mark = ok ? 'ok  ' : klass === TERMINAL ? 'TERM' : 'RETRY'
  console.log(`  [${mark}] ${id}: ${detail}`)
}

function sh(cmd, args, opts = {}) {
  try {
    // stderr captured, not inherited: codesign/spctl write their detail to stderr and
    // letting it through interleaves with the check output and buries the verdict.
    return {
      ok: true,
      out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }),
    }
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` || String(e) }
  }
}

// ── version ──────────────────────────────────────────────────────────────────

/**
 * Every place a version is written must agree with the tag.
 *
 * src-tauri/Cargo.toml is the one that drifted: the release job stamps package.json
 * and tauri.conf.json only, so Cargo.toml sat at 0.4.13 while releases shipped 0.4.24
 * — eleven patch versions of silent disagreement, and the Rust binary reported the
 * stale one.
 */
export function checkVersionSources(repoRoot, tagVersion) {
  const sources = {
    'package.json': (t) => JSON.parse(t).version,
    'src-tauri/tauri.conf.json': (t) => JSON.parse(t).version,
    'src-tauri/Cargo.toml': (t) => (t.match(/^version\s*=\s*"([^"]+)"/m) || [])[1],
  }
  const found = {}
  for (const [rel, parse] of Object.entries(sources)) {
    const p = path.join(repoRoot, rel)
    if (!fs.existsSync(p)) continue
    try { found[rel] = parse(fs.readFileSync(p, 'utf8')) } catch { found[rel] = '<unparseable>' }
  }
  // Cargo.toml carries the base version; a prerelease tag legitimately extends it.
  const base = tagVersion.split('-')[0]
  const bad = Object.entries(found).filter(([rel, v]) =>
    rel.endsWith('Cargo.toml') ? v !== base : v !== tagVersion && v !== base)
  if (bad.length === 0) {
    record('version.sources', true, `all agree with ${tagVersion}`)
  } else {
    record('version.sources', false,
      `disagree with tag ${tagVersion}: ${bad.map(([r, v]) => `${r}=${v}`).join(', ')}. ` +
      'A rerun stamps the same files it stamped before, so this needs the stamp step fixed.',
      TERMINAL)
  }
  return found
}

/** A release must move forward. Republishing or going backwards breaks every updater. */
export function checkVersionMonotonic(tagVersion, previousVersion) {
  if (!previousVersion) {
    record('version.monotonic', true, 'no previous release supplied; nothing to compare')
    return
  }
  const norm = (v) => v.replace(/^v/, '').split(/[-.]/).map((x) => (/^\d+$/.test(x) ? +x : x))
  const a = norm(tagVersion), b = norm(previousVersion)
  let forward = false, equal = true
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0
    if (x === y) continue
    equal = false
    forward = typeof x === typeof y ? x > y : String(x) > String(y)
    break
  }
  if (equal) {
    record('version.monotonic', false,
      `${tagVersion} is identical to the previous release; a republish under the same ` +
      'version leaves clients unable to tell the builds apart', TERMINAL)
  } else if (!forward) {
    record('version.monotonic', false,
      `${tagVersion} sorts BEFORE ${previousVersion}; updaters will not offer it`, TERMINAL)
  } else {
    record('version.monotonic', true, `${previousVersion} -> ${tagVersion}`)
  }
}

// ── macOS ────────────────────────────────────────────────────────────────────

/**
 * Gatekeeper is the actual gate. An ad-hoc signature satisfies `codesign --verify`
 * while `spctl` rejects it outright, so verifying the signature alone reports success
 * on a build nobody can open.
 */
export function checkMacApp(appPath) {
  if (process.platform !== 'darwin') {
    record('macos.gatekeeper', true, 'skipped: not running on macOS')
    return
  }
  const cs = sh('codesign', ['-dv', '--verbose=2', appPath])
  const adhoc = /Signature=adhoc/.test(cs.out)
  const teamless = /TeamIdentifier=not set/.test(cs.out)

  const spctl = sh('spctl', ['-a', '-vvv', '-t', 'exec', appPath])
  const accepted = spctl.ok && /accepted/.test(spctl.out)

  if (accepted) {
    record('macos.gatekeeper', true, 'spctl accepts the bundle')
  } else {
    record('macos.gatekeeper', false,
      `spctl REJECTS the bundle${adhoc ? ' (ad-hoc signature' : ''}` +
      `${teamless ? ', no TeamIdentifier' : ''}${adhoc ? ')' : ''}. ` +
      'Users see "cannot be opened because the developer cannot be verified". ' +
      'No Developer ID is configured, so a rerun produces an identically unsigned build.',
      TERMINAL)
  }

  const staple = sh('xcrun', ['stapler', 'validate', appPath])
  const stapled = staple.ok && !/does not have a ticket/.test(staple.out)
  record('macos.notarized', stapled,
    stapled ? 'notarization ticket stapled'
            : 'no notarization ticket stapled; first launch requires a network round-trip ' +
              'to Apple and fails outright when offline',
    stapled ? null : TERMINAL)
}

// ── Windows ──────────────────────────────────────────────────────────────────

/**
 * Read the PE certificate table directly rather than shelling out to signtool, so this
 * runs on any platform. An empty table means unsigned, and SmartScreen will interpose
 * a full-screen block on download.
 */
export function checkWindowsExe(exePath) {
  const d = fs.readFileSync(exePath)
  const peOff = d.readUInt32LE(0x3c)
  if (d.toString('ascii', peOff, peOff + 4) !== 'PE\0\0') {
    record('windows.authenticode', false, `${path.basename(exePath)} is not a valid PE image ` +
      '(truncated or corrupt upload) — a rerun may well fix this', RETRIABLE)
    return
  }
  const magic = d.readUInt16LE(peOff + 24)
  const dataDir = peOff + 24 + (magic === 0x20b ? 112 : 96)
  const certSize = d.readUInt32LE(dataDir + 4 * 8 + 4)
  if (certSize > 0) {
    record('windows.authenticode', true, `certificate table present (${certSize} bytes)`)
  } else {
    record('windows.authenticode', false,
      'no Authenticode certificate. SmartScreen shows a full-screen "unrecognised app" ' +
      'block and most users stop there. No signing certificate is configured, so a ' +
      'rerun produces an identically unsigned installer.', TERMINAL)
  }
}

// ── Linux ────────────────────────────────────────────────────────────────────

/** Sidecars missing from the payload is the classic Tauri externalBin failure. */
const REQUIRED_SIDECARS = ['noetica', 'agent-machine', 'noetica-embed', 'noetica-operator']

/**
 * Dependency checks must be TRUE, or they are worse than absent.
 *
 * An earlier version of this file asserted that libwebkit2gtk-4.1-0 "does not exist
 * before Ubuntu 23.04" and classified it TERMINAL. That was simply wrong --
 * libwebkit2gtk-4.1-0 ships on Ubuntu 22.04 (jammy, 2.50.4-0), 24.04, and Debian 12.
 * The check would have fired a false terminal on every single release, which
 * permanently blocks the recut path for a non-reason and trains everyone to ignore a
 * red verdict. A confidently wrong gate does more damage than no gate.
 *
 * So this no longer guesses at distro availability, which cannot be settled from
 * inside the package anyway. It checks the thing the package can actually answer: that
 * a dependency list exists and names a web engine at all. A .deb that declares no
 * webkit dependency will install and then fail to launch, which presents to the user
 * as a broken app rather than a broken package.
 *
 * Verifying real distro satisfiability needs an apt resolve against each target
 * release. That belongs in a matrix job with containers, not in a static check that
 * pretends to know.
 */
const WEB_ENGINE_HINT = /webkit|webview/i

/**
 * Pure judgement on a Depends line, kept separate from unpacking so it is directly
 * testable. The distinction that matters: a MISSING web-engine dependency is a real
 * defect, while the SPECIFIC version of an engine dependency is not something this
 * check is entitled to have an opinion about.
 */
export function classifyDepends(depends) {
  const d = (depends || '').trim()
  if (!d) {
    return { ok: false, klass: TERMINAL,
      detail: 'the package declares no dependencies at all; a Tauri app needs a web ' +
              'engine and GTK, so this installs and then fails to launch' }
  }
  if (!WEB_ENGINE_HINT.test(d)) {
    return { ok: false, klass: TERMINAL,
      detail: `Depends names no web engine (${d}); a Tauri app cannot render without ` +
              'one, so this installs and then fails to launch' }
  }
  return { ok: true, klass: null, detail: `declares a web engine dependency (${d})` }
}

export function checkDeb(debPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'debverify-'))
  const ar = sh('ar', ['x', path.resolve(debPath)], { cwd: tmp })
  if (!ar.ok) {
    record('linux.deb.readable', false,
      `cannot unpack ${path.basename(debPath)} — likely a truncated upload`, RETRIABLE)
    return
  }
  record('linux.deb.readable', true, 'archive unpacks')

  // control
  const ctl = path.join(tmp, 'ctl')
  fs.mkdirSync(ctl, { recursive: true })
  sh('tar', ['xzf', path.join(tmp, 'control.tar.gz'), '-C', ctl])
  const controlPath = fs.existsSync(path.join(ctl, 'control'))
    ? path.join(ctl, 'control') : path.join(ctl, './control')
  const control = fs.existsSync(controlPath) ? fs.readFileSync(controlPath, 'utf8') : ''
  const dep = classifyDepends((control.match(/^Depends:\s*(.+)$/m) || [])[1])
  record('linux.deb.deps', dep.ok, dep.detail, dep.klass)

  // payload
  const list = sh('tar', ['tzf', path.join(tmp, 'data.tar.gz')])
  const missing = REQUIRED_SIDECARS.filter((b) => !list.out.includes(`usr/bin/${b}`))
  if (missing.length === 0) {
    record('linux.deb.sidecars', true, `all ${REQUIRED_SIDECARS.length} binaries present`)
  } else {
    record('linux.deb.sidecars', false,
      `missing from payload: ${missing.join(', ')}. The app installs and then fails at ` +
      'runtime, which looks like a broken app rather than a broken package.', TERMINAL)
  }
  fs.rmSync(tmp, { recursive: true, force: true })
}

/** An asset that is implausibly small is usually a failed upload, and that IS retriable. */
export function checkAssetSizes(dir, minBytes = 1_000_000) {
  const files = fs.readdirSync(dir).filter((f) =>
    /\.(deb|rpm|dmg|exe|tar\.gz)$/.test(f))
  const tiny = files.filter((f) => fs.statSync(path.join(dir, f)).size < minBytes)
  if (files.length === 0) {
    record('assets.present', false, 'no installable assets found on the release', RETRIABLE)
  } else if (tiny.length) {
    record('assets.present', false,
      `implausibly small: ${tiny.join(', ')} — almost always a dropped upload`, RETRIABLE)
  } else {
    record('assets.present', true, `${files.length} assets, all plausibly sized`)
  }
}

// ── verdict ──────────────────────────────────────────────────────────────────

export function verdict() {
  const failures = results.filter((r) => !r.ok)
  const terminal = failures.filter((r) => r.klass === TERMINAL)
  const retriable = failures.filter((r) => r.klass === RETRIABLE)
  return {
    installable: failures.length === 0,
    checks: results,
    failed: failures.length,
    terminal: terminal.map((r) => r.id),
    retriable: retriable.map((r) => r.id),
    // The whole point: only recut what a rerun could actually fix. A terminal failure
    // present anywhere makes recutting pointless — it would reproduce the same build.
    should_recut: retriable.length > 0 && terminal.length === 0,
    recut_blocked_by: terminal.length ? terminal.map((r) => r.id) : null,
  }
}

function main(argv) {
  const arg = (k, d = null) => {
    const i = argv.indexOf(k)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d
  }
  const tag = arg('--tag')
  const dir = arg('--dir', './artifacts')
  const repoRoot = arg('--repo-root', '.')
  const previous = arg('--previous')
  const jsonOut = arg('--json')
  if (!tag) { console.error('--tag is required'); return 2 }
  const version = tag.replace(/^v/, '')

  console.log(`verifying ${tag} in ${dir}\n`)
  checkVersionSources(repoRoot, version)
  checkVersionMonotonic(version, previous ? previous.replace(/^v/, '') : null)

  if (fs.existsSync(dir)) {
    checkAssetSizes(dir)
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f)
      if (f.endsWith('.deb')) checkDeb(p)
      else if (f.endsWith('setup.exe')) checkWindowsExe(p)
      else if (f.endsWith('.app')) checkMacApp(p)
    }
  } else {
    record('assets.present', false, `artifact dir ${dir} does not exist`, RETRIABLE)
  }

  const v = verdict()
  console.log(`\ninstallable: ${v.installable}`)
  if (!v.installable) {
    console.log(`  terminal (a rerun cannot fix): ${v.terminal.join(', ') || 'none'}`)
    console.log(`  retriable (a rerun might fix): ${v.retriable.join(', ') || 'none'}`)
    console.log(`  should_recut: ${v.should_recut}`)
    if (v.recut_blocked_by) {
      console.log(`  NOT recutting — ${v.recut_blocked_by.join(', ')} would reproduce identically`)
    }
  }
  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({ tag, version, ...v }, null, 2))
    console.log(`\nwrote ${jsonOut}`)
  }
  return v.installable ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)))
}

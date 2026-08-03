/**
 * The classification is the load-bearing logic: "recut on failure" is only correct for
 * a failure a rerun could fix. These tests pin that a terminal failure never triggers
 * a recut, because that is how an auto-healing pipeline turns into an infinite loop
 * that hides a broken release.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const SCRIPT = new URL('./verify-release-artifacts.mjs', import.meta.url).pathname

function run(args) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vr-')), 'v.json')
  let code = 0
  try {
    execFileSync('node', [SCRIPT, ...args, '--json', out], { encoding: 'utf8', stdio: 'pipe' })
  } catch (e) { code = e.status }
  return { code, verdict: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null }
}

function fixtureRepo(versions) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'))
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version: versions.pkg }))
  fs.mkdirSync(path.join(d, 'src-tauri'))
  fs.writeFileSync(path.join(d, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: versions.tauri }))
  fs.writeFileSync(path.join(d, 'src-tauri/Cargo.toml'), `[package]\nversion = "${versions.cargo}"\n`)
  return d
}

test('version sources agreeing with the tag passes', () => {
  const repo = fixtureRepo({ pkg: '1.2.3', tauri: '1.2.3', cargo: '1.2.3' })
  const { verdict } = run(['--tag', 'v1.2.3', '--repo-root', repo, '--dir', '/nonexistent'])
  assert.ok(!verdict.terminal.includes('version.sources'))
})

test('a drifted Cargo.toml is TERMINAL, not retriable', () => {
  // The real defect: releases shipped 0.4.24 while Cargo.toml sat at 0.4.13, because
  // the stamp step never touched it. Rerunning stamps the same two files again.
  const repo = fixtureRepo({ pkg: '0.4.24', tauri: '0.4.24', cargo: '0.4.13' })
  const { verdict } = run(['--tag', 'v0.4.24', '--repo-root', repo, '--dir', '/nonexistent'])
  assert.ok(verdict.terminal.includes('version.sources'))
  assert.equal(verdict.should_recut, false)
})

test('a prerelease tag may extend the Cargo base version', () => {
  const repo = fixtureRepo({ pkg: '0.4.24-nightly.20260731', tauri: '0.4.24-nightly.20260731', cargo: '0.4.24' })
  const { verdict } = run(['--tag', 'v0.4.24-nightly.20260731', '--repo-root', repo, '--dir', '/nonexistent'])
  assert.ok(!verdict.terminal.includes('version.sources'))
})

test('republishing the same version is TERMINAL', () => {
  const repo = fixtureRepo({ pkg: '1.0.0', tauri: '1.0.0', cargo: '1.0.0' })
  const { verdict } = run(['--tag', 'v1.0.0', '--repo-root', repo, '--previous', 'v1.0.0', '--dir', '/nonexistent'])
  assert.ok(verdict.terminal.includes('version.monotonic'))
})

test('a version that goes backwards is TERMINAL', () => {
  const repo = fixtureRepo({ pkg: '1.0.0', tauri: '1.0.0', cargo: '1.0.0' })
  const { verdict } = run(['--tag', 'v1.0.0', '--previous', 'v1.1.0', '--repo-root', repo, '--dir', '/nonexistent'])
  assert.ok(verdict.terminal.includes('version.monotonic'))
})

test('missing artifacts are RETRIABLE and DO trigger a recut', () => {
  // A dropped upload is exactly what rerunning fixes.
  const repo = fixtureRepo({ pkg: '1.0.0', tauri: '1.0.0', cargo: '1.0.0' })
  const { verdict } = run(['--tag', 'v1.0.0', '--repo-root', repo, '--dir', '/nonexistent-dir'])
  assert.ok(verdict.retriable.includes('assets.present'))
  assert.equal(verdict.terminal.length, 0)
  assert.equal(verdict.should_recut, true, 'a dropped upload must be recut')
})

test('a truncated asset is RETRIABLE', () => {
  const repo = fixtureRepo({ pkg: '1.0.0', tauri: '1.0.0', cargo: '1.0.0' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-'))
  fs.writeFileSync(path.join(dir, 'App_1.0.0_amd64.deb'), 'truncated')
  const { verdict } = run(['--tag', 'v1.0.0', '--repo-root', repo, '--dir', dir])
  assert.ok(verdict.retriable.includes('assets.present'))
})

test('a terminal failure BLOCKS recut even when a retriable one is present', () => {
  // The whole point. Recutting here would rebuild the same unsigned artifacts forever
  // while the real cause — missing signing config — stays invisible.
  const repo = fixtureRepo({ pkg: '0.4.24', tauri: '0.4.24', cargo: '0.4.13' })
  const { verdict } = run(['--tag', 'v0.4.24', '--repo-root', repo, '--dir', '/nonexistent-dir'])
  assert.ok(verdict.terminal.length > 0)
  assert.ok(verdict.retriable.length > 0)
  assert.equal(verdict.should_recut, false)
  assert.ok(verdict.recut_blocked_by.includes('version.sources'))
})

test('a failing verification exits non-zero', () => {
  const repo = fixtureRepo({ pkg: '0.4.24', tauri: '0.4.24', cargo: '0.4.13' })
  const { code } = run(['--tag', 'v0.4.24', '--repo-root', repo, '--dir', '/nonexistent'])
  assert.equal(code, 1)
})

test('an unsigned PE is detected as TERMINAL', () => {
  // Minimal PE with an empty certificate table — what an unsigned installer looks like.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-'))
  const buf = Buffer.alloc(1_100_000)
  buf.writeUInt32LE(0x80, 0x3c)
  buf.write('PE\0\0', 0x80, 'ascii')
  buf.writeUInt16LE(0x20b, 0x80 + 24)                 // PE32+
  buf.writeUInt32LE(0, 0x80 + 24 + 112 + 4 * 8 + 4)   // cert table size = 0
  fs.writeFileSync(path.join(dir, 'App_1.0.0_x64-setup.exe'), buf)
  const repo = fixtureRepo({ pkg: '1.0.0', tauri: '1.0.0', cargo: '1.0.0' })
  const { verdict } = run(['--tag', 'v1.0.0', '--repo-root', repo, '--dir', dir])
  assert.ok(verdict.terminal.includes('windows.authenticode'))
  assert.equal(verdict.should_recut, false)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { EXE_SUFFIX, resolveSidecarBinary } from './sidecar-path.js'

test('EXE_SUFFIX matches the platform', () => {
  assert.equal(EXE_SUFFIX, process.platform === 'win32' ? '.exe' : '')
})

test('resolves a binary shipped beside the executable, with the platform suffix', () => {
  // Tauri externalBin strips the target triple but KEEPS the extension, so on Windows the
  // installed file is `noetica-embed.exe`. Probing the bare name found nothing there, which
  // is how both sidecars silently went missing on every Windows install.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-beside-'))
  const shipped = path.join(dir, `noetica-embed${EXE_SUFFIX}`)
  fs.writeFileSync(shipped, '')
  const realExecPath = process.execPath
  try {
    Object.defineProperty(process, 'execPath', { value: path.join(dir, `noetica-am${EXE_SUFFIX}`), configurable: true })
    assert.equal(resolveSidecarBinary('noetica-embed', 'embed-sidecar', dir), shipped)
  } finally {
    Object.defineProperty(process, 'execPath', { value: realExecPath, configurable: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a bare extensionless file is NOT accepted on Windows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-bare-'))
  fs.writeFileSync(path.join(dir, 'noetica-embed'), '')   // no .exe
  const realExecPath = process.execPath
  try {
    Object.defineProperty(process, 'execPath', { value: path.join(dir, 'noetica-am'), configurable: true })
    const got = resolveSidecarBinary('noetica-embed', 'embed-sidecar', dir)
    if (process.platform === 'win32') assert.equal(got, null, 'Windows must require the .exe')
    else assert.equal(got, path.join(dir, 'noetica-embed'))
  } finally {
    Object.defineProperty(process, 'execPath', { value: realExecPath, configurable: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('falls back to the cargo dev target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-dev-'))
  const fromDir = path.join(root, 'agent-machine', 'lib')
  const target = path.join(root, 'embed-sidecar', 'target', 'release')
  fs.mkdirSync(fromDir, { recursive: true })
  fs.mkdirSync(target, { recursive: true })
  const built = path.join(target, `noetica-embed${EXE_SUFFIX}`)
  fs.writeFileSync(built, '')
  const realExecPath = process.execPath
  try {
    // execPath points somewhere with no sidecar beside it, so resolution must fall through
    Object.defineProperty(process, 'execPath', { value: path.join(os.tmpdir(), 'nowhere', 'node'), configurable: true })
    assert.equal(resolveSidecarBinary('noetica-embed', 'embed-sidecar', fromDir), built)
  } finally {
    Object.defineProperty(process, 'execPath', { value: realExecPath, configurable: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('returns null when the binary is absent everywhere', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-none-'))
  const realExecPath = process.execPath
  try {
    Object.defineProperty(process, 'execPath', { value: path.join(dir, 'noetica-am'), configurable: true })
    assert.equal(resolveSidecarBinary('noetica-embed', 'embed-sidecar', dir), null)
  } finally {
    Object.defineProperty(process, 'execPath', { value: realExecPath, configurable: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

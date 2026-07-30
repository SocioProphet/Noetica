/**
 * audit-key — the device's audit identity. An Ed25519 keypair generated once and persisted under
 * ~/.noetica (private key 0600, never leaves the device). It signs the governance hash-chain head,
 * so an auditor can verify the attestation against this device's public key. Load-or-create:
 * stable across restarts, so the signature chain is continuous.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, createHash, type KeyObject } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

/** Where the device audit key lives. Resolved on EVERY access — never frozen into a module-load
 *  constant — and overridable with NOETICA_AUDIT_KEY_DIR. loadOrCreateDeviceKey() MINTS and persists a
 *  keypair on any read miss, so a path baked in at import time let `npm test` overwrite the operator's
 *  real device audit identity — which breaks the governance hash-chain's continuity, because every head
 *  signed by the old key stops verifying. See lib/store-path-guard.ts. */
export function _keyDir(): string {
  return process.env['NOETICA_AUDIT_KEY_DIR'] || path.join(os.homedir(), '.noetica')
}
function privPath(): string { return path.join(_keyDir(), 'audit-key.pem') }

export interface DeviceKey {
  publicKey: KeyObject
  privateKey: KeyObject
  fingerprint: string // short sha256 of the SPKI public key — the device's audit identity
  publicKeyPem: string
}

/** Short, human-displayable identity for the device public key. */
export function fingerprint(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('hex').slice(0, 16)
}

function pack(publicKey: KeyObject, privateKey: KeyObject): DeviceKey {
  return {
    publicKey,
    privateKey,
    fingerprint: fingerprint(publicKey),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

/** Load the device audit key, generating + persisting (0600) on first use. */
export function loadOrCreateDeviceKey(): DeviceKey {
  try {
    const pem = fs.readFileSync(privPath(), 'utf8')
    const privateKey = createPrivateKey(pem)
    return pack(createPublicKey(privateKey), privateKey)
  } catch {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    try {
      fs.mkdirSync(_keyDir(), { recursive: true })
      fs.writeFileSync(privPath(), privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 })
    } catch { /* best-effort persist — in-memory key still works for this session */ }
    return pack(publicKey, privateKey)
  }
}

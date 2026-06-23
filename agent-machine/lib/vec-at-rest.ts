/**
 * vec-at-rest — encrypt brain/doc vectors AT REST.
 *
 * vec2text / ALGEN recover ~92% of the source text from a stored embedding, so a plaintext vector on
 * disk is effectively plaintext TEXT to anyone who reads the disk (stolen/imaged laptop). This wraps
 * the canonical base64 vector codec (brain-vec) in the at-rest AES-256-GCM layer (keychain-wrapped
 * key — a stolen LOCKED disk has no usable key), keeping the IN-MEMORY vector plaintext (retrieval
 * stays fast — decrypt happens on hydrate, not per query) while the PERSISTED form is ciphertext.
 *
 * Self-describing (`enc:v1:` prefix, same magic as at-rest): decode transparently reads legacy
 * plaintext too → lazy migration, no breaking change. NOETICA_ENCRYPT_VECTORS=0 disables (debug /
 * portability); reads still auto-detect either form.
 */
import { encodeVec, decodeVec } from './brain-vec.js'
import { encryptLine, decryptLine } from './at-rest.js'

const MAGIC = 'enc:v1:'
const enabled = (): boolean => process.env['NOETICA_ENCRYPT_VECTORS'] !== '0'

/** Encode a vector to the at-rest form: ciphertext when enabled, else the plaintext base64. */
export function encodeVecEncrypted(vec: number[] | Float32Array): string {
  const b64 = encodeVec(vec)
  return enabled() ? encryptLine({ v: b64 }) : b64
}

/**
 * Decode the at-rest form → Float32Array. Handles BOTH ciphertext (`enc:v1:…`) and legacy plaintext
 * base64 (lazy migration). A tampered / wrong-key payload returns an EMPTY vector (the caller treats
 * that as "no embedding" → lexical-only retrieval for that chunk), and never throws.
 */
export function decodeVecEncrypted(s: string, dims?: number): Float32Array {
  if (typeof s === 'string' && s.startsWith(MAGIC)) {
    const o = decryptLine(s) as { v?: string } | null
    return o?.v ? decodeVec(o.v, dims) : new Float32Array(0)
  }
  return decodeVec(s, dims)
}

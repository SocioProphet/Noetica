/**
 * content-credentials.ts — C2PA-style provenance + AI-output marking. EU AI Act Article 50 requires machine-
 * readable marking of generative output (incl. text) by Aug 2026 — a local product must mark even offline.
 * Builds a Content-Credential manifest, a deterministic digest, and a machine-readable marker appended to
 * generated text. (Crypto signing/SynthID image watermarks are the upgrade; this is the always-available base.)
 */
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface ContentCredential {
  generator: string
  model: string
  aiGenerated: true
  timestamp: string
  sourceRefs: string[]
}

export function makeCredential(opts: { generator?: string; model: string; timestamp: string; sourceRefs?: string[] }): ContentCredential {
  return { generator: opts.generator ?? 'noetica', model: opts.model, aiGenerated: true, timestamp: opts.timestamp, sourceRefs: opts.sourceRefs ?? [] }
}

/** Deterministic manifest digest (djb2 over canonical JSON) — stand-in for a C2PA hard binding. */
export function manifestDigest(cred: ContentCredential): string {
  const canonical = JSON.stringify({ generator: cred.generator, model: cred.model, aiGenerated: cred.aiGenerated, timestamp: cred.timestamp, sourceRefs: [...cred.sourceRefs].sort() })
  let h = 5381
  for (let i = 0; i < canonical.length; i++) h = ((h * 33) ^ canonical.charCodeAt(i)) >>> 0
  return 'cc_' + h.toString(16).padStart(8, '0')
}

/** Append a machine-readable AI-generated marker (Art.50). Idempotent. */
export function markAIGenerated(text: string, cred: ContentCredential): string {
  const marker = `\n<!-- c2pa:ai-generated model="${cred.model}" digest="${manifestDigest(cred)}" -->`
  return text.includes('c2pa:ai-generated') ? text : text + marker
}

/** SHA-256 hash of text content — used in compliance logs (never the raw content itself). */
export function responseHash(text: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

export interface ComplianceLogEntry {
  timestamp: string
  event: 'ai_generated_response'
  markedAt: string
  responseHash: string
  complianceStandard: 'EU-AI-Act-Art50'
  model: string
  generator: string
  digest: string
}

/**
 * Append one compliance log entry to logs/ai-act-compliance.ndjson.
 * Never logs raw prompt/response content — only hashes and metadata.
 * Best-effort: throws are caught by the caller.
 */
export function appendComplianceLog(entry: ComplianceLogEntry, logsDir?: string): void {
  const dir = logsDir ?? path.join(process.cwd(), 'logs')
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* already exists */ }
  const file = path.join(dir, 'ai-act-compliance.ndjson')
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o640 })
}

/**
 * Build and (optionally) write a compliance log entry for an AI-generated response.
 * Returns the entry for testing without side effects when logsDir is explicitly set to null.
 */
export function logAIActEvent(opts: {
  responseText: string
  cred: ContentCredential
  logsDir?: string | null
}): ComplianceLogEntry {
  const now = new Date().toISOString()
  const entry: ComplianceLogEntry = {
    timestamp: now,
    event: 'ai_generated_response',
    markedAt: now,
    responseHash: responseHash(opts.responseText),
    complianceStandard: 'EU-AI-Act-Art50',
    model: opts.cred.model,
    generator: opts.cred.generator,
    digest: manifestDigest(opts.cred),
  }
  if (opts.logsDir !== null) {
    appendComplianceLog(entry, opts.logsDir ?? undefined)
  }
  return entry
}

/** Build the SSE content-credentials event payload. */
export function buildC2PAEventPayload(cred: ContentCredential): {
  standard: 'EU-AI-Act-Art50'
  generator: string
  model: string
  aiGenerated: true
  digest: string
  timestamp: string
} {
  return {
    standard: 'EU-AI-Act-Art50',
    generator: cred.generator,
    model: cred.model,
    aiGenerated: true,
    digest: manifestDigest(cred),
    timestamp: cred.timestamp,
  }
}

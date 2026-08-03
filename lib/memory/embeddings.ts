// #602 / prophet-workspace#82 — pin the embedding space on EVERY query path.
//
// The estate learned this once (Noetica PR#600→#602, feedback memory
// `embedding_space_pin_all_paths`): an embedding-space / dimension contract is only real if EVERY
// vector that meets in a cosine shares ONE space. A query embedded at a different dimension than the
// corpus (e.g. OpenAI text-embedding-3-small at 512-dim vs a local nomic-embed-text corpus at
// 768-dim, the same class as the original 384-vs-768) must FAIL LOUD — never silently cosine-miss and
// degrade dense retrieval to lexical keyword scoring.
export class EmbeddingSpaceMismatchError extends Error {
  readonly code = 'embedding-space-mismatch'
  readonly queryDim: number
  readonly corpusDim: number
  constructor(queryDim: number, corpusDim: number, where = 'query') {
    super(
      `embedding-space-mismatch: ${where} vector has dim ${queryDim}, pinned corpus space is ` +
      `${corpusDim} (a foreign-space vector would silently cosine-match nothing and degrade to ` +
      `lexical — #602 / prophet-workspace#82)`,
    )
    this.name = 'EmbeddingSpaceMismatchError'
    this.queryDim = queryDim
    this.corpusDim = corpusDim
  }
}

// Assert two vectors live in the SAME pinned embedding space. Covers the query embed path AND the
// corpus / re-embed paths — a foreign-dimension vector raises instead of silently matching nothing.
export function assertSameEmbeddingSpace(query: number[], corpus: number[], where = 'query'): void {
  if (query.length !== corpus.length) {
    throw new EmbeddingSpaceMismatchError(query.length, corpus.length, where)
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  // #602/#82: a dimension mismatch previously returned 0 here — a SILENT degrade that dropped every
  // cross-space comparison to zero and let dense retrieval collapse to lexical. Fail loud instead.
  if (a.length !== b.length) throw new EmbeddingSpaceMismatchError(a.length, b.length, 'cosine')
  if (a.length === 0) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/\W+/).filter((w) => w.length > 2)
  )
}

// TF-IDF-style keyword scoring — no API needed
export function keywordScore(query: string, text: string): number {
  const qTokens = tokenize(query)
  if (qTokens.size === 0) return 0
  const tTokens = tokenize(text)
  let matches = 0
  for (const t of qTokens) {
    if (tTokens.has(t)) matches++
  }
  return matches / qTokens.size
}

import { amUrl } from '@/lib/tauri/bridge'

// Fetch embedding(s) from the Noetica embed API route.
// openaiKey is optional — when absent the route falls back to a local Ollama model.
// In Tauri (static export), amUrl routes to the :8080 agent-machine sidecar's /api/embed handler.
export async function fetchEmbedding(text: string, openaiKey?: string): Promise<number[] | null> {
  try {
    const res = await fetch(amUrl('/api/embed'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...(openaiKey ? { openai_key: openaiKey } : {}) }),
    })
    if (!res.ok) return null
    const data = await res.json() as { embedding: number[] }
    return data.embedding ?? null
  } catch {
    return null
  }
}

export async function fetchEmbeddings(texts: string[], openaiKey?: string): Promise<number[][] | null> {
  if (texts.length === 0) return []
  try {
    const res = await fetch(amUrl('/api/embed'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts, ...(openaiKey ? { openai_key: openaiKey } : {}) }),
    })
    if (!res.ok) return null
    const data = await res.json() as { embeddings: number[][] }
    return data.embeddings ?? null
  } catch {
    return null
  }
}

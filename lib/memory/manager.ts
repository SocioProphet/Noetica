import type { MemoryEntry, MemoryStore } from './types'
import { cosineSimilarity, keywordScore, assertSameEmbeddingSpace } from './embeddings'

export function addEntry(store: MemoryStore, entry: Omit<MemoryEntry, 'id' | 'created_at'>): MemoryStore {
  const newEntry: MemoryEntry = {
    ...entry,
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
  }
  return { ...store, entries: [...store.entries, newEntry] }
}

export function removeEntry(store: MemoryStore, id: string): MemoryStore {
  return { ...store, entries: store.entries.filter((e) => e.id !== id) }
}

export function updateEntry(store: MemoryStore, id: string, patch: Partial<Pick<MemoryEntry, 'text' | 'tags' | 'embedding'>>): MemoryStore {
  return {
    ...store,
    entries: store.entries.map((e) => e.id === id ? { ...e, ...patch } : e),
  }
}

export function sortedEntries(store: MemoryStore): MemoryEntry[] {
  return [...store.entries].sort((a, b) => b.created_at.localeCompare(a.created_at))
}

// Build a system prompt block from memories — injected at conversation start.
// Pass `relevant` to inject only a curated subset (semantic retrieval result).
export function buildMemoryContext(store: MemoryStore, relevant?: MemoryEntry[]): string | null {
  const entries = relevant ?? sortedEntries(store)
  if (entries.length === 0) return null
  const lines = entries.map((e) => `- ${e.text}`)
  return `## What you know about the user\n\n${lines.join('\n')}`
}

// Score and rank entries by semantic similarity to a query.
// Uses cosine similarity when embeddings are available, keyword scoring otherwise.
//
// #602 / prophet-workspace#82: the corpus embedding dimension is PINNED and propagated onto the query
// path. When the query was embedded but at a different dimension than the corpus, we FAIL LOUD
// (EmbeddingSpaceMismatchError) rather than let every cosine collapse to 0 and silently degrade to
// lexical keyword scoring. A query with NO embedding at all (embed backend unavailable) still keyword-
// scores — that is an availability degrade, not a foreign-space mismatch.
export function searchEntries(
  query: string,
  entries: MemoryEntry[],
  k: number,
  queryEmbedding?: number[],
): MemoryEntry[] {
  if (entries.length === 0) return []

  // Pin the corpus space from the first embedded entry and check the query against it up front, so
  // the failure names query-vs-corpus dims instead of surfacing as a mid-scan zero.
  if (queryEmbedding) {
    const corpusVec = entries.find((e) => e.embedding)?.embedding
    if (corpusVec) assertSameEmbeddingSpace(queryEmbedding, corpusVec, 'query')
  }

  const scored = entries.map((e) => {
    let score: number
    if (queryEmbedding && e.embedding) {
      // Both vectors are pinned to the corpus space above; cosineSimilarity additionally fails loud
      // if a single corpus entry was embedded in a foreign space (contaminated corpus, #602).
      score = cosineSimilarity(queryEmbedding, e.embedding)
    } else {
      score = keywordScore(query, `${e.text} ${e.tags.join(' ')}`)
    }
    return { entry: e, score }
  })

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.entry)
}

// Heuristic: extract memory-worthy statements from an assistant response.
// Returns candidate strings for the user to approve.
export function extractMemoryCandidates(assistantContent: string): string[] {
  const candidates: string[] = []

  // Look for explicit memory markers the model might emit
  const markerRe = /\[REMEMBER:\s*(.+?)\]/gi
  let m: RegExpExecArray | null
  while ((m = markerRe.exec(assistantContent)) !== null) {
    if (m[1]) candidates.push(m[1].trim())
  }

  return candidates
}

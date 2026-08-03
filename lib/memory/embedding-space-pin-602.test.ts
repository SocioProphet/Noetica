/**
 * embedding-space-pin-602.test — the #602 / prophet-workspace#82 regression, made a control that
 * cannot silently fail.
 *
 * The estate learned this once (Noetica PR#600→#602, feedback memory `embedding_space_pin_all_paths`):
 * a query embedded at a different dimension than the corpus must FAIL LOUD, never silently
 * cosine-miss and drop dense retrieval to lexical keyword scoring. The regression was that
 * `cosineSimilarity` returned 0 on a dimension mismatch, so `searchEntries` filtered every dense hit
 * to zero and quietly degraded to `keywordScore` — retrieval that looks like it works and is wrong.
 * The class is the original 384-vs-768; here 512 (OpenAI text-embedding-3-small) vs 768 (nomic).
 *
 * Teeth BOTH ways:
 *   POSITIVE — a query embedded in the PINNED corpus dim uses dense (cosine) retrieval and ranks the
 *              nearer entry first.
 *   NEGATIVE — a query embedded at the WRONG dim is REJECTED loudly (EmbeddingSpaceMismatchError with
 *              a stable `embedding-space-mismatch` code) — the test asserts the error, NOT a lexical
 *              fallback. A contaminated corpus entry (foreign-dim embedding) is rejected too.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cosineSimilarity, assertSameEmbeddingSpace, EmbeddingSpaceMismatchError } from './embeddings.js'
import { searchEntries } from './manager.js'
import type { MemoryEntry } from './types'

const CORPUS_DIM = 768   // pinned corpus space (local nomic-embed-text)
const QUERY_DIM = 512    // OpenAI text-embedding-3-small with dimensions:512 — the wrong-space query

function entry(id: string, text: string, embedding?: number[]): MemoryEntry {
  return {
    id,
    text,
    tags: [],
    created_at: new Date().toISOString(),
    source: 'user',
    ...(embedding ? { embedding } : {}),
  } as MemoryEntry
}

// A unit vector in `dim` space with a single non-zero axis — trivial to reason about cosine on.
function axis(dim: number, i: number): number[] {
  const v = new Array<number>(dim).fill(0)
  v[i % dim] = 1
  return v
}

test('#602/#82 POSITIVE: query pinned to corpus dim uses dense retrieval and ranks nearest first', () => {
  const near = entry('near', 'coastal erosion of dunes', axis(CORPUS_DIM, 3))
  const far = entry('far', 'quarterly revenue totals', axis(CORPUS_DIM, 400))
  const query = axis(CORPUS_DIM, 3)   // same axis as `near` → cosine 1 vs 0

  const results = searchEntries('erosion', [far, near], 5, query)

  // Dense retrieval actually ran: only the aligned entry scores > 0, and it ranks first.
  assert.equal(results[0]?.id, 'near', 'nearest dense entry must rank first')
  assert.ok(!results.some((r) => r.id === 'far'), 'orthogonal entry must score 0 and be filtered')
})

test('#602/#82 NEGATIVE: wrong-dim query is REJECTED loudly, never degraded to lexical', () => {
  // `near`.text contains the query word "erosion", so a silent lexical fallback WOULD return it.
  // The point of the pin: we must throw instead of returning that lexical match.
  const near = entry('near', 'coastal erosion of dunes', axis(CORPUS_DIM, 3))
  const wrongDimQuery = axis(QUERY_DIM, 3)   // 512-dim query vs 768-dim corpus

  assert.throws(
    () => searchEntries('erosion', [near], 5, wrongDimQuery),
    (err: unknown) => {
      assert.ok(err instanceof EmbeddingSpaceMismatchError, 'must be the pinned-space error type')
      assert.equal((err as EmbeddingSpaceMismatchError).code, 'embedding-space-mismatch')
      assert.equal((err as EmbeddingSpaceMismatchError).queryDim, QUERY_DIM)
      assert.equal((err as EmbeddingSpaceMismatchError).corpusDim, CORPUS_DIM)
      return true
    },
    'a wrong-dim query must fail loud, not silently keyword-match "erosion"',
  )
})

test('#602/#82 NEGATIVE: cosineSimilarity fails loud on a dim mismatch (was: silent 0)', () => {
  assert.throws(
    () => cosineSimilarity(axis(QUERY_DIM, 1), axis(CORPUS_DIM, 1)),
    EmbeddingSpaceMismatchError,
    'the original silent-wrong: mismatched dims returned 0 instead of raising',
  )
  // equal-dim cosine still works, and an empty (equal-length) pair is a benign 0.
  assert.equal(cosineSimilarity(axis(CORPUS_DIM, 5), axis(CORPUS_DIM, 5)), 1)
  assert.equal(cosineSimilarity([], []), 0)
})

test('#602/#82 NEGATIVE: a contaminated corpus entry (foreign-dim embedding) is rejected', () => {
  const good = entry('good', 'coastal erosion', axis(CORPUS_DIM, 3))
  const contaminated = entry('bad', 'foreign-space vector', axis(QUERY_DIM, 3))
  const query = axis(CORPUS_DIM, 3)

  assert.throws(
    () => searchEntries('erosion', [good, contaminated], 5, query),
    EmbeddingSpaceMismatchError,
    'a corpus entry embedded in a foreign space must fail loud, not skew the ranking with a 0',
  )
})

test('#602/#82 assertSameEmbeddingSpace pins the query path directly', () => {
  assert.doesNotThrow(() => assertSameEmbeddingSpace(axis(CORPUS_DIM, 0), axis(CORPUS_DIM, 1)))
  assert.throws(
    () => assertSameEmbeddingSpace(axis(QUERY_DIM, 0), axis(CORPUS_DIM, 0)),
    EmbeddingSpaceMismatchError,
  )
})

test('#602/#82 no-embedding query still keyword-scores (availability degrade, not a mismatch)', () => {
  // When the embed backend is unavailable the query has NO vector — keyword fallback is legitimate
  // here and must NOT be conflated with the foreign-space failure above.
  const e = entry('kw', 'coastal erosion of dunes')   // no embedding at all
  const results = searchEntries('erosion', [e], 5, undefined)
  assert.equal(results[0]?.id, 'kw', 'keyword fallback still works when nothing was embedded')
})

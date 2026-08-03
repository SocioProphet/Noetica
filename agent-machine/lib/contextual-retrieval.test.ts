/**
 * contextual-retrieval.test.ts — teeth for the Anthropic Contextual-Retrieval preprocessor.
 *
 * The teeth prove the pattern actually earns its place, BOTH ways:
 *   1. CONTEXTUALIZATION ADDS RECALL — a chunk whose BARE text loses a query wins once its situating
 *      context is prepended (the whole point of the pattern).
 *   2. HYBRID BEATS EITHER ALONE — dense⊕TF-IDF fused via the estate RRF ranks the gold chunk first
 *      when neither the dense leg nor the TF-IDF leg does alone.
 *   3. SPACE PIN IS ENFORCED — a chunk embedded in the WRONG dimension is rejected LOUDLY (#605/#82),
 *      never indexed into a forked vector space.
 *
 * Deterministic + stdlib-runnable: no live LLM (default doc-summary context stub) and no Ollama
 * (an injected deterministic embedder). Run: `npm test` (node --test).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tfidfRanking, contextualizeChunks, situate, docSummaryContext,
  buildContextualIndex, hybridRetrieve, denseRanking, assertCorpusDim,
  type Embedder,
} from './contextual-retrieval.js'

// A deterministic, hermetic embedder: hashed bag-of-words TF vector. Honors { dims } so it can stand
// in for embedText on the pinned corpus path (and, by returning the WRONG size, exercise the #82 guard).
function hashEmbedder(dim: number): Embedder {
  return async (text: string) => {
    const v = new Array(dim).fill(0)
    for (const tok of text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)) {
      let h = 0
      for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0
      v[h % dim] += 1
    }
    return v
  }
}

// ─── TEETH 1: contextualization adds recall ────────────────────────────────────

// An earnings doc. The gold chunk ("It grew 40 percent…") never names the company, the product, or
// the metric — cut out of the document it is unfindable for "acme cloud revenue growth". The doc's
// title/lead and the section heading it sits under carry exactly those terms.
const EARNINGS_DOC = [
  'ACME Corp Q3 FY2026 Earnings Report',
  'Total revenue reached record levels this quarter across all divisions.',
  '',
  'Overview',
  'The company reported strong broad-based results this period driven by resilient enterprise demand and disciplined cost management across the portfolio.',
  '',
  'Cloud Segment',
  'It grew 40 percent year over year, the fastest of any segment.',
  '',
  'Hiring Update',
  'We added 200 employees to support expansion in the region.',
].join('\n')

const EARNINGS_CHUNKS = [
  'Total revenue reached record levels this quarter across all divisions.',
  'The company reported strong broad-based results this period driven by resilient enterprise demand and disciplined cost management across the portfolio.',
  'It grew 40 percent year over year, the fastest of any segment.', // GOLD = chunk index 2
  'We added 200 employees to support expansion in the region.',
]
const GOLD_CHUNK = 'c2'

test('TEETH 1: a chunk that LOSES on bare text WINS once contextualized (recall lift)', async () => {
  const query = 'acme cloud revenue growth'

  // Bare: the gold chunk mentions none of the query terms, so a lexical ranker buries it.
  const bare = tfidfRanking(query, EARNINGS_CHUNKS.map((t, i) => ({ id: `c${i}`, text: t })))
  assert.notEqual(bare[0], GOLD_CHUNK, 'precondition: bare text does NOT surface the gold chunk first')

  // Situate each chunk within the whole document, then index the context+chunk.
  const ctx = await contextualizeChunks(EARNINGS_CHUNKS, EARNINGS_DOC)
  const situated = tfidfRanking(query, ctx.map((c) => ({ id: `c${c.idx}`, text: c.situated })))

  // The situating context injects the company/product/metric the bare chunk lacked → it now wins.
  assert.equal(situated[0], GOLD_CHUNK, 'contextualized: the gold chunk is now the top hit')
  assert.ok(
    situated.indexOf(GOLD_CHUNK) < bare.indexOf(GOLD_CHUNK),
    `contextualization must LIFT the gold chunk's rank (bare #${bare.indexOf(GOLD_CHUNK)} → situated #${situated.indexOf(GOLD_CHUNK)})`,
  )
  // And the lift is causal: the generated context carries the discriminating term ("Cloud").
  assert.match(ctx[2]!.context, /Cloud/, 'the gold chunk was situated under its Cloud section')
})

// ─── TEETH 2: dense ⊕ TF-IDF beats either alone ─────────────────────────────────

test('TEETH 2: dense⊕TF-IDF fused (RRF) surfaces a chunk NEITHER leg ranks first alone', async () => {
  const DIM = 128
  const embed = hashEmbedder(DIM)
  const query = 'acme arpu revenue'

  // A corpus where the dense leg and the lexical leg genuinely disagree on the winner: A_denseWin is
  // aligned/short (dense loves it, low idf), C_lexWin is a lone rare-ish term (TF-IDF loves it), and
  // GOLD is a solid second in BOTH — the classic case RRF is built to win.
  const chunks = [
    { id: 'A_denseWin', text: 'revenue arpu segment revenue outlook' },
    { id: 'GOLD', text: 'arpu revenue segment segment acme' },
    { id: 'B', text: 'arpu' },
    { id: 'C_lexWin', text: 'acme' },
    { id: 'D', text: 'revenue' },
  ]
  const index = {
    dim: DIM,
    items: await Promise.all(chunks.map(async (c) => ({ id: c.id, situated: c.text, vec: await embed(c.text, { dims: DIM }) }))),
  }

  const dense = await denseRanking(index, query, embed)
  const lexical = tfidfRanking(query, index.items.map((it) => ({ id: it.id, text: it.situated })))
  const fused = await hybridRetrieve(index, query, { embed })

  assert.notEqual(dense[0], 'GOLD', 'dense leg alone does NOT rank the gold chunk first')
  assert.notEqual(lexical[0], 'GOLD', 'TF-IDF leg alone does NOT rank the gold chunk first')
  assert.equal(fused[0]!.id, 'GOLD', 'the fused hybrid DOES rank the gold chunk first — it beats either alone')
})

// ─── TEETH 3: the #82 space pin is enforced at index time (reject loudly) ────────

test('TEETH 3: a chunk embedded at the WRONG dimension is REJECTED loudly (#605/#82)', async () => {
  const wrongDim = hashEmbedder(384) // sidecar-native 384 while the corpus is pinned to 768
  await assert.rejects(
    () => buildContextualIndex(['a chunk of text'], 'a document', { embed: wrongDim, dim: 768 }),
    /pinned to 768-dim|forked vector space|#82/,
    'indexing a 384-dim vector into a 768-dim corpus must throw, not silently index a dead chunk',
  )

  // The correctly-pinned embedder indexes fine.
  const rightDim = hashEmbedder(768)
  const ok = await buildContextualIndex(['a chunk of text'], 'a document', { embed: rightDim, dim: 768 })
  assert.equal(ok.items.length, 1)
  assert.equal(ok.items[0]!.vec.length, 768)

  // assertCorpusDim is the reusable guard; it names the dims and the issue in the failure.
  assert.throws(() => assertCorpusDim(new Array(384).fill(0), 768, 'chunk#7'), /384-dim.*768-dim|#82/)
  assert.doesNotThrow(() => assertCorpusDim(new Array(768).fill(0), 768, 'chunk#7'))
})

// ─── Supporting contracts ───────────────────────────────────────────────────────

test('situate prepends the context to the chunk (the indexed unit is context+chunk)', () => {
  assert.equal(situate('CTX', 'CHUNK'), 'CTX\n\nCHUNK')
})

test('default doc-summary generator is deterministic and situates from doc-level terms', () => {
  const a = docSummaryContext({ chunk: EARNINGS_CHUNKS[2]!, document: EARNINGS_DOC })
  const b = docSummaryContext({ chunk: EARNINGS_CHUNKS[2]!, document: EARNINGS_DOC })
  assert.equal(a, b, 'deterministic: same inputs → same context (CI-safe, no live LLM)')
  assert.match(a, /ACME Corp Q3 FY2026 Earnings Report/, 'carries the document title')
})

test('an unavailable embedder (empty vector) degrades to lexical rather than throwing', async () => {
  const down: Embedder = async () => []
  const index = await buildContextualIndex(['some text'], 'a document', { embed: down, dim: 768 })
  assert.equal(index.items.length, 1)
  assert.equal(index.items[0]!.vec.length, 0, 'empty vec is kept (lexical-only), NOT rejected as wrong-dim')
})

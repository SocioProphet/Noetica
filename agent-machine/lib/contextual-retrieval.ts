/**
 * contextual-retrieval.ts — Anthropic's "Contextual Retrieval" preprocessing for the estate RAG stack.
 *
 * The pattern (https://www.anthropic.com/news/contextual-retrieval): a bare chunk, cut out of its
 * document, loses the context that makes it findable — "It grew 40% YoY" never mentions the company,
 * product, or metric, so a query for "ACME cloud revenue" can't reach it. The fix is to SITUATE each
 * chunk within its whole document (a short, ~50-100 token blurb naming what the chunk is about),
 * PREPEND that context to the chunk, then index the CONTEXT+CHUNK two ways — a dense embedding AND a
 * lexical (TF-IDF) posting — and fuse the two rankings at query time.
 *
 * This module is the PREPROCESSOR that runs before embedding. It consumes, does not fork, the merged
 * estate stack:
 *   • the dense⊕lexical fusion is the existing RRF hybrid lane (reciprocalRankFusion, #604) — reused
 *     verbatim for the dense⊕TF-IDF fusion here;
 *   • embeddings are pinned to the corpus space via embedText(text, { dims: CORPUS_EMBED_DIM }) and a
 *     chunk that comes back in a DIFFERENT dimension is REJECTED loudly (#605/#82) rather than indexed
 *     into a forked space where every cosine is garbage;
 *   • it plugs into doc-store.ingestDocument between chunkTextWithSpans() and embedText() — chunk →
 *     situate → context+chunk → embed(pinned) + TF-IDF.
 *
 * The context-generator is PLUGGABLE. The default is a deterministic doc-summary stub so CI (and the
 * teeth) run with no live LLM. The live generator — one Claude call per chunk that returns the
 * situating blurb — is wired as follow-up (see PR); swap it in via the `generate` option.
 *
 * Pure + deterministic (given a deterministic generator + embedder); stdlib-runnable.
 */

import { reciprocalRankFusion } from './rerank-rrf.js'
import { embedText, CORPUS_EMBED_DIM } from './ollama.js'

// ─── Pluggable seams ──────────────────────────────────────────────────────────

/** Produce the situating context for one chunk, given the whole document it came from.
 *  Default: {@link docSummaryContext} (deterministic). Live: a Claude call per chunk (follow-up). */
export type ContextGenerator = (args: {
  chunk: string
  document: string
  filename?: string
  idx: number
}) => string | Promise<string>

/** Embed text into the corpus vector space. Default: {@link embedText}. The `dims` argument is the
 *  #82 space pin — the embedder must answer in that space or the result is rejected upstream. */
export type Embedder = (text: string, opts?: { dims?: number }) => Promise<number[]>

// ─── Default deterministic context generator (the CI/teeth stub) ────────────────

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + '…' : s)

/**
 * Deterministic doc-summary context — the default, no-LLM stub. It situates a chunk using only the
 * document text: the document's title (first non-empty line), a short lead, and the nearest preceding
 * heading to where the chunk sits. This deliberately injects DOCUMENT-LEVEL terms (the company, the
 * product, the report's subject) that a mid-document chunk omits — which is exactly the recall the
 * pattern buys. The live Claude generator produces a richer blurb; this proves the seam and keeps CI
 * hermetic.
 */
export function docSummaryContext(args: { chunk: string; document: string; filename?: string }): string {
  const { chunk, document, filename } = args
  const lines = document.split('\n').map((l) => l.trim()).filter(Boolean)
  const title = clip(lines[0] ?? filename ?? 'document', 80)
  // Lead = the body after the title line, so the blurb carries the document's subject matter.
  const body = lines.slice(1).join(' ')
  const lead = clip(body || title, 160)
  // Nearest preceding heading: scan backward from the chunk's location for a markdown heading or a
  // short Title-Case/UPPERCASE line acting as a section header. Falls back to the title.
  let heading = title
  const at = document.indexOf(chunk.slice(0, 48))
  const before = at >= 0 ? document.slice(0, at) : document
  const prior = before.split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = prior.length - 1; i >= 0; i--) {
    const l = prior[i]!
    if (/^#{1,6}\s+\S/.test(l) || (l.length <= 60 && /^[A-Z][^.!?]*$/.test(l) && l.split(' ').length <= 8)) {
      heading = clip(l.replace(/^#{1,6}\s+/, ''), 80)
      break
    }
  }
  return `From "${title}". ${lead}. This excerpt appears under: ${heading}.`
}

// ─── Situate ────────────────────────────────────────────────────────────────

/** Prepend the situating context to the chunk. The stored/indexed unit is context+chunk. */
export function situate(context: string, chunk: string): string {
  return `${context}\n\n${chunk}`
}

/** One preprocessed chunk: the bare chunk, its situating context, and the situated (context+chunk)
 *  text that actually gets embedded + TF-IDF indexed. */
export interface ContextualChunk {
  idx: number
  chunk: string
  context: string
  situated: string
}

/** chunk[] + document → contextual chunks. Runs the (pluggable) context generator per chunk and
 *  prepends. Async because the live generator is a network call; the default stub is sync. */
export async function contextualizeChunks(
  chunks: string[],
  document: string,
  opts: { generate?: ContextGenerator; filename?: string } = {},
): Promise<ContextualChunk[]> {
  const generate = opts.generate ?? docSummaryContext
  const out: ContextualChunk[] = []
  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx]!
    const context = String(await generate({ chunk, document, filename: opts.filename, idx })).trim()
    out.push({ idx, chunk, context, situated: situate(context, chunk) })
  }
  return out
}

// ─── #82 space-pin guard: reject a wrong-dim embedding LOUDLY ────────────────────

/**
 * The #605/#82 pin, enforced at index time. A vector in a different dimension than the pinned corpus
 * space is not "low quality" — it is unusable: cosine against corpus chunks is meaningless and the
 * downstream dimension guards silently discard every hit, which looks exactly like "retrieval found
 * nothing". So an off-space embedding must fail loudly here, not be indexed. embedText() already
 * honors { dims } and falls back to the corpus model; this is the belt-and-suspenders assertion for
 * the contextual index (and for any injected embedder).
 */
export function assertCorpusDim(vec: number[], dim: number, id: string): void {
  if (vec.length !== dim) {
    throw new Error(
      `contextual-retrieval: chunk "${id}" embedded at ${vec.length}-dim but the corpus is pinned to ` +
        `${dim}-dim — refusing to index into a forked vector space (see #82/#605). Reindex the corpus ` +
        `or fix the embedder before indexing.`,
    )
  }
}

// ─── The hybrid (dense ⊕ TF-IDF) index over situated chunks ─────────────────────

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'has', 'have',
  'its', 'it', 'a', 'an', 'of', 'to', 'in', 'on', 'by', 'as', 'is', 'at', 'or'])

/** Content tokens: lowercased, ≥2 chars, de-stopped. Shared by the TF-IDF ranker. */
function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 2 && !STOP.has(w))
}

/** Cosine over two dense vectors (local + pure so this module drags no native vector engine). */
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]! }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

/**
 * TF-IDF cosine ranking of situated chunks for a query — the LEXICAL half of the hybrid. Each doc and
 * the query are TF-IDF vectors over the corpus vocabulary (tf = term frequency in the doc, idf =
 * ln(1 + N/df)); rank by cosine. This is the "index it with TF-IDF" leg of the Anthropic pattern; it
 * fuses with the dense leg via the existing RRF. Returns ids in descending rank.
 */
export function tfidfRanking(query: string, docs: Array<{ id: string; text: string }>): string[] {
  const N = docs.length || 1
  const toks = docs.map((d) => tokenize(d.text))
  const df = new Map<string, number>()
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1)
  const idf = (w: string) => Math.log(1 + N / ((df.get(w) ?? 0) + 1e-9))
  const tfidfVec = (words: string[]): Map<string, number> => {
    const tf = new Map<string, number>()
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1)
    const v = new Map<string, number>()
    for (const [w, f] of tf) v.set(w, f * idf(w))
    return v
  }
  const qv = tfidfVec(tokenize(query))
  const qnorm = Math.sqrt([...qv.values()].reduce((s, x) => s + x * x, 0)) || 1
  const scored = docs.map((d, i) => {
    const dv = tfidfVec(toks[i]!)
    let dot = 0
    for (const [w, x] of qv) dot += x * (dv.get(w) ?? 0)
    const dnorm = Math.sqrt([...dv.values()].reduce((s, x) => s + x * x, 0)) || 1
    return { id: d.id, score: dot / (qnorm * dnorm) }
  })
  return scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map((s) => s.id)
}

/** A built contextual index: situated chunks, each with its pinned-space embedding. */
export interface ContextualIndex {
  dim: number
  items: Array<{ id: string; situated: string; vec: number[] }>
}

/**
 * Build the hybrid index: contextualize each chunk, embed the SITUATED text in the pinned corpus space
 * (#82), reject any off-space embedding loudly, and keep the situated text for the TF-IDF leg. This is
 * the preprocessing seam doc-store.ingestDocument calls between chunking and storage.
 */
export async function buildContextualIndex(
  chunks: string[],
  document: string,
  opts: {
    generate?: ContextGenerator
    embed?: Embedder
    dim?: number
    filename?: string
    idPrefix?: string
  } = {},
): Promise<ContextualIndex> {
  const embed = opts.embed ?? embedText
  const dim = opts.dim ?? CORPUS_EMBED_DIM
  const prefix = opts.idPrefix ?? 'chunk'
  const contextual = await contextualizeChunks(chunks, document, { generate: opts.generate, filename: opts.filename })
  const items: ContextualIndex['items'] = []
  for (const c of contextual) {
    const id = `${prefix}#${c.idx}`
    const vec = await embed(c.situated, { dims: dim })
    // An empty vector means the embedder was unavailable (breaker/timeout) — degrade to lexical-only
    // for that chunk rather than throwing; a WRONG-dim vector is a space fork and MUST throw (#82).
    if (vec.length) assertCorpusDim(vec, dim, id)
    items.push({ id, situated: c.situated, vec })
  }
  return { dim, items }
}

/**
 * Hybrid retrieval over a contextual index: rank by dense cosine (query embedded in the pinned space)
 * and by TF-IDF, then FUSE the two rankings with the estate's Reciprocal Rank Fusion (#604). A chunk
 * both legs like floats to the top; a chunk only one leg surfaces still competes — which is why the
 * fusion beats either leg alone. Returns fused { id, score } in descending order.
 */
export async function hybridRetrieve(
  index: ContextualIndex,
  query: string,
  opts: { embed?: Embedder; k?: number; limit?: number } = {},
): Promise<Array<{ id: string; score: number }>> {
  const embed = opts.embed ?? embedText
  const limit = opts.limit ?? 8
  const dense = await denseRanking(index, query, embed)
  const lexical = tfidfRanking(query, index.items.map((it) => ({ id: it.id, text: it.situated })))
  return reciprocalRankFusion([dense, lexical], opts.k ?? 60).slice(0, limit)
}

/** Dense ranking: embed the query in the pinned corpus space, cosine against each chunk vector. Chunks
 *  that failed to embed (empty vec) sort last. Exposed so callers can inspect the dense leg alone. */
export async function denseRanking(index: ContextualIndex, query: string, embed: Embedder = embedText): Promise<string[]> {
  const qvec = await embed(query, { dims: index.dim })
  if (qvec.length) assertCorpusDim(qvec, index.dim, 'query')
  return index.items
    .map((it) => ({ id: it.id, score: it.vec.length && qvec.length ? cosine(qvec, it.vec) : -1 }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((s) => s.id)
}

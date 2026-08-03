/**
 * rag-fusion.ts — canonical **query-variant RAG-Fusion** (Raudaschl): generate N query variants,
 * retrieve a ranked list for EACH variant, then fuse the lists with Reciprocal Rank Fusion.
 *
 * Closes the RAG-Fusion gap in prophet-workspace#78 (element 5): RRF was live but only fused
 * lexical⊕dense (`hybrid-retrieve.ts`), NOT N generated-query-variant lists — so the canonical
 * RAG-Fusion wiring was never assembled. This module assembles it by CONSUMING, not reinventing:
 *
 *   • RRF                — imported verbatim from `./rerank-rrf.js` (score = Σ 1/(k+rank)); k configurable.
 *   • Multi-Query        — the variant generator is injected; `ollamaVariantGenerator` reuses the shared
 *                          `generateOllamaText` LLM helper (the same one `retrieval.ts` uses for HyDE/qgen).
 *   • per-variant retrieve — the retriever is injected; `studyBrainRetriever` adapts the existing
 *                          `studyBrainRetrieve` (dense+lexical+material) into a ranked id list per variant.
 *
 * Why per-variant-then-fuse beats study-brain's existing `extraQueries` best-match union: best-match
 * scores every chunk by its single closest variant inside ONE ranking, so a document that is only a
 * MODERATE match for several variants never accumulates. RRF over separate per-variant rankings rewards
 * exactly that consensus — a doc ranked middling by many variants is floated above a doc ranked highly
 * by only one. That consensus signal is what variant-fusion adds (see rag-fusion.test.ts teeth).
 *
 * Determinism: given the same variants and the same per-variant rankings the output order is fixed
 * (RRF is a pure function; ties keep first-seen order via a stable sort). Inject the generator/retriever
 * to test without a model or the brain on disk.
 */
import { reciprocalRankFusion } from './rerank-rrf.js'

/** Retrieve a RANKED list of document ids for one query (best first). */
export type Retriever = (query: string) => Promise<string[]> | string[]

/** Generate up to `n` alternative phrasings of `query` (the original is added separately). */
export type VariantGenerator = (query: string, n: number) => Promise<string[]> | string[]

export interface RagFusionOptions {
  /** RRF constant. Larger k flattens the rank-position weighting. Default 60 (the RRF paper default). */
  k?: number
  /** How many variants to request from the generator. Default 4. `n<=0` ⇒ no generation (original only). */
  n?: number
  /** Include the literal query as one of the fused lists. Default true. */
  includeOriginal?: boolean
}

export interface RagFusionResult {
  /** Fused ranking, best first: `{id, score}` with the RRF score. */
  ranking: Array<{ id: string; score: number }>
  /** The queries actually retrieved over (original + generated, de-duplicated, in fuse order). */
  variants: string[]
  /** The ranked id list retrieved for each variant, aligned 1:1 with `variants` (audit / teeth). */
  perVariant: string[][]
}

/**
 * Run query-variant RAG-Fusion. Generates variants (Multi-Query), retrieves a ranked list per
 * variant, and fuses all lists with RRF. `generateVariants` is optional: omit it (or `n<=0`, or a
 * generator that returns none) and this degenerates to a single-query RRF, i.e. the retriever's own
 * ranking, unchanged — the safe fallback when variant generation is unavailable.
 */
export async function ragFusion(
  query: string,
  retrieve: Retriever,
  opts: RagFusionOptions = {},
  generateVariants?: VariantGenerator,
): Promise<RagFusionResult> {
  const k = opts.k ?? 60
  const n = opts.n ?? 4
  const includeOriginal = opts.includeOriginal !== false

  // MULTI-QUERY (reuse the injected generator). Best-effort: any failure ⇒ no variants, so RAG-Fusion
  // never turns a working single-query retrieval into an error — it just loses the fusion lift.
  let generated: string[] = []
  if (generateVariants && n > 0) {
    try {
      generated = (await generateVariants(query, n)) || []
    } catch {
      generated = []
    }
  }

  // Assemble the query set: original first (if kept), then generated, de-duplicated on trimmed text.
  const seen = new Set<string>()
  const variants: string[] = []
  const push = (q: string): void => {
    const t = (q || '').trim()
    if (t && !seen.has(t)) {
      seen.add(t)
      variants.push(t)
    }
  }
  if (includeOriginal) push(query)
  for (const g of generated) push(g)

  // Empty-variants degenerate case: nothing usable (e.g. empty query AND no variants) ⇒ empty result,
  // not a crash and not an accidental retrieve('').
  if (variants.length === 0) return { ranking: [], variants: [], perVariant: [] }

  // Retrieve a ranked id list PER variant, then FUSE with RRF (imported, not reinvented). A single
  // variant reduces to RRF over one list, which preserves that list's order — plain retrieval, safely.
  const perVariant: string[][] = []
  for (const v of variants) perVariant.push([...(await retrieve(v))])
  const ranking = reciprocalRankFusion(perVariant, k)
  return { ranking, variants, perVariant }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Default adapters — wire the reference impl over the EXISTING Noetica pieces (consume-not-fork).
// These are lazy-imported so the pure `ragFusion` core (and its teeth) never pulls in the model /
// filesystem / brain — inject fixtures to test, use these to run for real.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Multi-Query generator over the shared LLM helper (`generateOllamaText`), the same round-trip
 * `retrieval.ts` already makes for HyDE/qgen. Asks for `n` alternative phrasings, one per line, and
 * parses them defensively (strips numbering/bullets, drops blanks). Returns [] on any failure so the
 * caller degenerates to single-query retrieval.
 */
export async function ollamaVariantGenerator(query: string, n = 4): Promise<string[]> {
  const { generateOllamaText } = await import('./ollama.js')
  const model =
    process.env['NOETICA_CHAT_MODEL'] || process.env['NOETICA_MODEL'] || 'qwen2.5:7b'
  try {
    const { content } = await generateOllamaText({
      model,
      temperature: 0.4,
      numCtx: 1024,
      messages: [
        {
          role: 'user',
          content:
            `Rewrite the search query below as ${n} alternative queries that a retrieval system could ` +
            `use to find the same answer from different angles (synonyms, broader/narrower framings, ` +
            `the underlying concept). One query per line, no numbering, no commentary.\n\nQuery: ${query}`,
        },
      ],
    })
    return content
      .split('\n')
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
      .filter((l) => l.length > 0 && l.toLowerCase() !== query.trim().toLowerCase())
      .slice(0, n)
  } catch {
    return []
  }
}

/**
 * Per-variant retriever over the existing brain retrieval (`studyBrainRetrieve`). Returns a ranked
 * id list (`ocw:field/slug`) so distinct variant rankings fuse by document identity. `depth` is the
 * per-variant list length fed into the fuse (default 20).
 */
export function studyBrainRetriever(fields: string[] = [], depth = 20): Retriever {
  return async (query: string): Promise<string[]> => {
    const { studyBrainRetrieve } = await import('./study-brain.js')
    const hits = await studyBrainRetrieve(query, fields, depth)
    return hits.map((h) => `ocw:${h.field}/${h.slug}`)
  }
}

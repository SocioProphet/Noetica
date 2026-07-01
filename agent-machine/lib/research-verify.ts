/**
 * research-verify — a VERIFIER for research answers, so the compounding loop extends past coding.
 *
 * Coding has a hard verifier (exit 0). Research needs one too, or storing answers just compounds
 * hallucination. This is a deterministic GROUNDING check: every claim (sentence) in the answer must
 * have its content tokens substantially present in the retrieved sources. A claim whose tokens don't
 * appear in any source is unsupported (the model made it up). Score = fraction of claims grounded.
 *
 * It's lexical, not full entailment — but it reliably catches the failure that matters: assertions
 * the sources never made. That's the signal that makes a stored research answer trustworthy to reuse.
 */

const STOP = new Set(['the', 'and', 'for', 'are', 'was', 'were', 'this', 'that', 'with', 'from', 'have', 'has', 'had', 'not', 'but', 'you', 'your', 'they', 'their', 'them', 'its', 'his', 'her', 'our', 'can', 'will', 'would', 'could', 'should', 'into', 'than', 'then', 'when', 'what', 'which', 'who', 'how', 'why', 'all', 'any', 'some', 'one', 'two', 'also', 'more', 'most', 'such', 'about', 'over', 'under', 'these', 'those'])

function contentTokens(s: string): string[] {
  return [...new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 3 && !STOP.has(t)))]
}

export interface GroundingResult { grounded: boolean; score: number; supported: number; total: number; unsupported: string[] }

/**
 * @param answer  the model's answer text
 * @param sources retrieved source texts the answer must be grounded in
 * @param claimCover fraction of a claim's content tokens that must appear in the sources (default .5)
 * @param passAt fraction of claims that must be grounded for the answer to pass (default .7)
 */
export function verifyGrounding(answer: string, sources: { text: string }[], claimCover = 0.5, passAt = 0.7): GroundingResult {
  const srcTokens = new Set<string>()
  for (const s of sources) for (const t of contentTokens(s.text)) srcTokens.add(t)
  const claims = answer.split(/(?<=[.!?])\s+/).map((c) => c.trim()).filter((c) => c.length > 15)
  if (!claims.length) return { grounded: false, score: 0, supported: 0, total: 0, unsupported: [] }
  const unsupported: string[] = []
  let supported = 0
  for (const claim of claims) {
    const ct = contentTokens(claim)
    if (!ct.length) { supported++; continue }   // no content tokens (filler) — not a factual claim
    const covered = ct.filter((t) => srcTokens.has(t)).length / ct.length
    if (covered >= claimCover) supported++
    else unsupported.push(claim.slice(0, 140))
  }
  const score = supported / claims.length
  return { grounded: score >= passAt, score, supported, total: claims.length, unsupported }
}

/* ── Entailment-based grounding (Phase-0.1 upgrade) ────────────────────────────
 * verifyGrounding above is lexical token-overlap: Metric 1 scored it F1 0.24 on
 * RAGTruth (recall 0.48 — misses >half the hallucinations, over-flags 5:1). The
 * eval's NLI arm lifts recall on baseless additions 0.38→0.86. This is the
 * production port: per claim, select the top-K most-similar source sentences as
 * the premise (handles claims that AGGREGATE across sources), then ENTAIL.
 * The entailment engine is injected (EntailFn) so it's pure + testable and the
 * engine is swappable (deberta-nli in the eval, an LLM judge on the mesh in prod).
 * NOTE: re-validate on RAGTruth via scripts/provenance_eval.py before claiming a
 * specific F1 — the measured lift used cross-encoder/nli-deberta-v3-small. */

export type EntailFn = (premise: string, hypothesis: string) => Promise<number>  // 0..1 entailment

function splitSentences(t: string): string[] {
  return t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 15)
}

// The K source sentences most lexically similar to the claim = the premise pool.
function topKSources(claim: string, srcSentences: string[], k: number): string[] {
  const ct = new Set(contentTokens(claim))
  if (!ct.size) return []
  return srcSentences
    .map((s) => { const t = contentTokens(s); return { s, score: t.length ? t.filter((x) => ct.has(x)).length / t.length : 0 } })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.s)
}

/** Entailment grounding: a claim is grounded iff its top-K source premise ENTAILS it. */
export async function verifyGroundingNLI(
  answer: string,
  sources: { text: string }[],
  entail: EntailFn,
  { topK = 4, entailAt = 0.5, passAt = 0.7 }: { topK?: number; entailAt?: number; passAt?: number } = {},
): Promise<GroundingResult> {
  const srcSents = sources.flatMap((s) => splitSentences(s.text))
  const claims = splitSentences(answer)
  if (!claims.length) return { grounded: false, score: 0, supported: 0, total: 0, unsupported: [] }
  const unsupported: string[] = []
  let supported = 0
  for (const claim of claims) {
    if (!contentTokens(claim).length) { supported++; continue }   // filler, not a factual claim
    const premise = topKSources(claim, srcSents, topK)
    const score = premise.length ? await entail(premise.join(' '), claim) : 0   // no similar source ⇒ unsupported
    if (score >= entailAt) supported++
    else unsupported.push(claim.slice(0, 140))
  }
  const score = supported / claims.length
  return { grounded: score >= passAt, score, supported, total: claims.length, unsupported }
}

/** Mesh-native default engine: an LLM entailment judge (swap for a served NLI cross-encoder to match the eval). */
export function makeLlmEntail(generate: (prompt: string) => Promise<string>): EntailFn {
  return async (premise, hypothesis) => {
    const out = (await generate(
      'You are a strict entailment judge. Does the EVIDENCE support the CLAIM? ' +
      'Reply with exactly one word: ENTAILED, NEUTRAL, or CONTRADICTED.\n\n' +
      `EVIDENCE:\n${premise}\n\nCLAIM:\n${hypothesis}\n\nAnswer:`,
    )).toUpperCase()
    if (out.includes('ENTAIL')) return 1
    if (out.includes('CONTRADICT')) return 0
    return 0.3   // neutral < default entailAt ⇒ treated as unsupported
  }
}

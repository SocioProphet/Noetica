/**
 * bon-coverage — the discriminating-token coverage the best-of-N verifier scores against.
 *
 * The old inline gate counted response tokens where `w.length > 3` that appeared in
 * context tokens where `w.length > 3`. Common English words trivially flipped
 * `verified=true` because they appear in ANY nontrivial context, and selectBestOfN
 * sorts verified-first — so an ungrounded fluent answer beat a terse grounded one.
 *
 * This module filters those common words (a small stopword set, corpus-standard) so
 * the coverage number reflects content-bearing overlap. Extracted so the fix has a
 * pure surface the best-of-N tests can exercise.
 *
 * Next: cite the NLI check `/api/grounding/verify-answer` uses when the ollama model
 * is available; until then, content-token coverage is the smallest change that fixes
 * the discriminating case (fluent ungrounded no longer beats grounded terse).
 */

// Small stopword set — a subset of standard corpora (mirrors the STOP set in
// lib/research-verify.ts). Kept in sync with that module by shape; not re-imported
// to avoid coupling agent-machine's browser-safe build to the Next.js path aliases.
export const CONTENT_STOP: ReadonlySet<string> = new Set([
  'the','and','for','are','was','were','this','that','with','from','have','has','had',
  'not','but','you','your','they','their','them','its','his','her','our','can','will',
  'would','could','should','into','than','then','when','what','which','who','how','why',
  'all','any','some','one','two','also','more','most','such','about','over','under',
  'these','those','been','being','because','while','where','there','here','just','only',
  'even','very','much','many','make','made','need','know','like','well','back','same',
  'through','across','above','below','along','against','around','behind','beside','between',
  'beyond','during','except','inside','outside','toward','towards','upon','within','without',
  'though','although','unless','until','since','other','another','else','own','after','before',
  'always','never','often','sometimes','usually','rather','quite','really','still','yet',
  'each','both','either','neither','none','every','several',
])

/** Split into content-bearing tokens: length > 3 AND not in the stopword set. */
export function contentTokens(text: string): string[] {
  return text.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !CONTENT_STOP.has(w))
}

/** Coverage over content-bearing tokens: the fraction of response tokens that
 *  appear in the retrieved context vocabulary. 0 when either side is empty —
 *  a candidate we cannot score is NEVER `verified=true`. */
export function bonCoverage(response: string, context: string): { coverage: number; verified: boolean } {
  const ctx = new Set(contentTokens(context))
  const resp = contentTokens(response)
  if (ctx.size === 0 || resp.length === 0) return { coverage: 0, verified: false }
  const coverage = resp.filter((t) => ctx.has(t)).length / resp.length
  return { coverage, verified: coverage >= 0.05 }
}

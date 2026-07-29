/**
 * inline-bind.ts — Phase 0.4: inline evidence binding for the generative path.
 *
 * All generative paths were POST-HOC bound (faithfulness checked after generation). This module
 * forces the model to cite evidence DURING generation: {"letter","reasoning","cited":[{"id","span"}]}.
 * A model that cites E2 but E2 doesn't support the answer is a detectable faithfulness failure —
 * measurable grounding vs noise, not inferred post-hoc. Feeds Metric 2 (inline fidelity) in the
 * provenance-fidelity eval and the board arm 'inline'.
 *
 * Phase 0 verdict: generative paths POST-HOC only. This closes the gap for the brain/qgen arm.
 */

export interface EvidenceChunk { id: string; text: string }
export interface EvidenceCitation { id: string; span: string }

/** A citation whose quoted excerpt has been LOCATED in the source, not merely matched.
 *
 *  `span` is a verbatim excerpt the model emitted, and it was previously only ever checked
 *  for string presence — enough to say "this text appears in that passage", never "this
 *  claim rests on characters 4120-4197 of that document". `resolution` records which of
 *  those two the record actually supports. */
export interface ResolvedCitation extends EvidenceCitation {
  /** Half-open [start,end) over the source document's normalized extraction. */
  start?: number
  end?: number
  resolution: 'exact' | 'whitespace-normalized' | 'unlocated' | 'no-offset-available'
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Resolve each quoted excerpt to real document offsets.
 *
 *  Matching is whitespace-tolerant because models reflow quoted text, but the offsets
 *  returned are those of what was actually FOUND, never of what was asked for. A citation
 *  that cannot be located says so rather than being dropped or guessed at — an unlocated
 *  citation is a faithfulness signal, and silently discarding it would destroy the very
 *  measurement this module exists to produce. */
export function resolveCitationSpans(
  cited: readonly EvidenceCitation[],
  evidence: ReadonlyArray<{ id: string; text: string; docStart?: number }>,
): ResolvedCitation[] {
  const byId = new Map(evidence.map((e) => [e.id, e]))
  return cited.map((c) => {
    const src = byId.get(c.id)
    const quoted = String(c.span ?? '').trim()
    if (!src || typeof src.docStart !== 'number') return { ...c, resolution: 'no-offset-available' }
    if (!quoted) return { ...c, resolution: 'unlocated' }

    let idx = src.text.indexOf(quoted)
    let matched = quoted
    let resolution: ResolvedCitation['resolution'] = 'exact'
    if (idx < 0) {
      // The model reflowed the whitespace; match token-wise and take what was found.
      const pattern = quoted.split(/\s+/).filter(Boolean).map(escapeRegExp).join('\\s+')
      const m = pattern ? new RegExp(pattern).exec(src.text) : null
      if (!m) return { ...c, resolution: 'unlocated' }
      idx = m.index
      matched = m[0]
      resolution = 'whitespace-normalized'
    }
    return { ...c, start: src.docStart + idx, end: src.docStart + idx + matched.length, resolution }
  })
}

export interface InlineBoundAnswer {
  letter: string
  reasoning: string
  cited: EvidenceCitation[]
  raw: string
  parse_ok: boolean
}

/** Assign E1/E2/... IDs to retrieved chunks and truncate for context budget. */
export function formatEvidence(chunks: Array<{ text: string }>, maxChars = 500): EvidenceChunk[] {
  return chunks.map((c, i) => ({ id: `E${i + 1}`, text: c.text.slice(0, maxChars) }))
}

/**
 * Build the inline-binding prompt. The model must answer AND cite which passage it's relying on,
 * quoting the supporting span verbatim. If no evidence helps, cited = [].
 * Structured JSON output so span+ID are machine-checkable, not free prose.
 */
export function inlineBindPrompt(question: string, choices: string[], evidence: EvidenceChunk[]): string {
  const evBlock = evidence.map((e) => `[${e.id}]\n${e.text}`).join('\n\n')
  const choiceBlock = choices.map((c, i) => `${String.fromCharCode(65 + i)}. ${c}`).join('\n')
  return `Evidence passages (cite only what supports your answer):
${evBlock}

Question: ${question}
${choiceBlock}

Output exactly one JSON line (no markdown, no commentary):
{"letter":"<A|B|C|D>","reasoning":"<one sentence>","cited":[{"id":"<E1|E2|...>","span":"<verbatim excerpt from that passage>"}]}

Rules: letter = your answer; cited = evidence IDs + exact spans you relied on (empty array if none helped).`
}

/** Parse the model's inline-bound JSON. Robust: extracts JSON sub-object; falls back to letter-only. */
export function parseInlineAnswer(raw: string): InlineBoundAnswer {
  const text = raw.trim()
  const jm = text.match(/\{[^{}]*"letter"\s*:\s*"[ABCD]"[^{}]*\}/)
  if (jm) {
    try {
      const p = JSON.parse(jm[0]) as { letter?: unknown; reasoning?: unknown; cited?: unknown }
      const letter = String(p.letter || '').trim().toUpperCase()
      if (/^[ABCD]$/.test(letter)) {
        const cited: EvidenceCitation[] = []
        if (Array.isArray(p.cited)) {
          for (const c of p.cited) {
            if (c && typeof c === 'object' && 'id' in c && 'span' in c)
              cited.push({ id: String((c as Record<string,unknown>)['id']), span: String((c as Record<string,unknown>)['span']) })
          }
        }
        return { letter, reasoning: String(p.reasoning || ''), cited, raw, parse_ok: true }
      }
    } catch { /* fall through */ }
  }
  const lm = text.match(/"letter"\s*:\s*"([ABCD])"|FINAL:\s*([ABCD])/i)
  const letter = lm ? (lm[1] || lm[2] || '').toUpperCase() : ''
  return { letter, reasoning: '', cited: [], raw, parse_ok: false }
}

/**
 * Measure whether a cited span is actually grounded in the cited evidence chunk.
 * Lexical containment proxy (no embedding needed at board time); provenance_eval.py
 * runs the deep NLI check post-hoc on the checkpoint file.
 * Returns 0–1; ≥ 0.4 = plausibly grounded.
 */
export function citationLexicalSupport(citation: EvidenceCitation, evidence: EvidenceChunk[]): number {
  const chunk = evidence.find((e) => e.id === citation.id)
  if (!chunk || !citation.span.trim()) return 0
  const words = (s: string): Set<string> => new Set(
    s.toLowerCase().match(/\b[a-z]{3,}\b/g)?.filter((w) => w.length > 2) ?? [])
  const spanW = words(citation.span)
  const chunkW = words(chunk.text)
  if (spanW.size === 0) return 0
  let hits = 0; for (const w of spanW) if (chunkW.has(w)) hits++
  return hits / spanW.size
}

/**
 * Summarise inline-fidelity for a set of answers: parse-rate, citation rate, and
 * grounding rate (cited spans that have lexical support ≥ threshold).
 */
export function inlineFidelityStats(
  answers: InlineBoundAnswer[],
  evidence: EvidenceChunk[],
  threshold = 0.4,
): { n: number; parse_rate: number; citation_rate: number; grounded_rate: number } {
  const n = answers.length
  if (n === 0) return { n: 0, parse_rate: 0, citation_rate: 0, grounded_rate: 0 }
  let parsed = 0, hasCite = 0, grounded = 0, total_cites = 0
  for (const a of answers) {
    if (a.parse_ok) parsed++
    if (a.cited.length > 0) hasCite++
    for (const c of a.cited) {
      total_cites++
      if (citationLexicalSupport(c, evidence) >= threshold) grounded++
    }
  }
  return {
    n,
    parse_rate: parsed / n,
    citation_rate: hasCite / n,
    grounded_rate: total_cites > 0 ? grounded / total_cites : 0,
  }
}

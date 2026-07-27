/**
 * episodic — cross-session episodic recall. The mesh records every turn as an Interaction atom
 * (promptSummary = the question, responseSummary = the answer, timestamp), but nothing ever
 * surfaced them — the episodic layer was write-only. This recalls prior exchanges relevant to
 * the current question and injects them, so the agent remembers what you discussed *in earlier
 * sessions* ("last time you asked about X, the answer was Y"), not just the current thread.
 *
 * Pure over a minimal store; ranks by Jaccard over the prior question.
 */

import { tokensOf, jaccard } from './graph-search.js'

export interface ExchangeNode { id: string; labels: string[]; properties: Record<string, unknown> }
export interface ExchangeStore {
  nodesByLabel(label: string): ExchangeNode[]
  /** Edge walk — required ONLY for session-scoped recall (see `sessionIds` below). */
  out?(id: string, edgeLabel?: string): ExchangeNode[]
}
export interface PriorExchange { question: string; answer: string; ts: string; score: number }

const META_ANSWER = /^(patterns:|sources:|\s*$)/   // routing summaries, not a real answer

/**
 * Recall prior Interaction atoms whose question is relevant to `query`, most-relevant first.
 *
 * `sessionIds` confines recall to a set of conversations — this is what makes a project a real
 * knowledge boundary rather than a label. Document retrieval was already project-scoped, but
 * episodic recall was global, so selecting a project still pulled prior exchanges from every
 * other project. An Interaction atom carries no sessionId property (the engine links it with a
 * HAS_INTERACTION edge off `urn:noetica:session:<id>`), so scoping walks those edges.
 *
 * Fails CLOSED: if a caller asks for scoped recall but the store can't walk edges, this returns
 * nothing rather than falling back to the global set. A boundary that silently opens is worse
 * than one that returns no results.
 */
export function recallExchanges(
  store: ExchangeStore,
  query: string,
  opts: { limit?: number; excludeRunId?: string; minScore?: number; sessionIds?: string[] } = {},
): PriorExchange[] {
  const qt = tokensOf(query)
  if (qt.size < 2) return []                        // too thin to match meaningfully
  const minScore = opts.minScore ?? 0.18
  let allowed: Set<string> | null = null
  if (opts.sessionIds && opts.sessionIds.length > 0) {
    if (typeof store.out !== 'function') return []   // can't enforce the boundary → recall nothing
    allowed = new Set<string>()
    for (const sid of opts.sessionIds) {
      for (const n of store.out(`urn:noetica:session:${sid}`, 'HAS_INTERACTION')) allowed.add(n.id)
    }
  }
  const out: PriorExchange[] = []
  for (const n of store.nodesByLabel('Interaction')) {
    if (n.properties['hygiene_pruned'] === true) continue
    if (allowed && !allowed.has(n.id)) continue
    const question = String(n.properties['promptSummary'] ?? '').trim()
    const answer = String(n.properties['responseSummary'] ?? '').trim()
    if (!question || !answer || META_ANSWER.test(answer)) continue
    if (opts.excludeRunId && String(n.properties['runId'] ?? '') === opts.excludeRunId) continue
    const score = jaccard(qt, tokensOf(question))
    if (score >= minScore) out.push({ question, answer, ts: String(n.properties['timestamp'] ?? ''), score })
  }
  return out.sort((a, b) => b.score - a.score || b.ts.localeCompare(a.ts)).slice(0, opts.limit ?? 3)
}

/** Render recalled exchanges as a context block (empty string when there are none). */
export function formatExchanges(exchanges: PriorExchange[]): string {
  if (exchanges.length === 0) return ''
  return '\n\n---\n**Prior related exchanges (recalled from earlier sessions — reuse if still valid)**\n' +
    exchanges.map((e) => `- Earlier asked: "${e.question.slice(0, 140)}" → answered: "${e.answer.slice(0, 200)}"`).join('\n')
}

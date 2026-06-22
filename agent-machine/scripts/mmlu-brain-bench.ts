#!/usr/bin/env -S node --import tsx
/**
 * mmlu-brain-bench — the thesis test. Sit the MMLU STEM exam TWICE with the SAME small
 * model: once CLOSED-BOOK (baseline) and once OPEN-BOOK over the MIT-OCW brain (retrieve
 * the most relevant lecture/exam chunks and inject them as context). If the brain arm
 * beats the baseline arm on the identical model, the lift is TECHNIQUE, not horsepower —
 * a 3B that studied the source material outscoring the same 3B that didn't.
 *
 * Clean-eval guarantee: the only inputs to the brain are OCW substance shards in
 * ~/Downloads/MIT OCW/_brain/<field>/*.jsonl. The MMLU questions/answers are NEVER
 * embedded — so this is an open-book exam (study the textbook, then sit it), not
 * memorizing the answer key.
 *
 * Each MMLU subject maps to the brain field(s) that cover it; a subject is only run if
 * its field has shards on disk, so this is runnable the moment math is vectorized and
 * grows automatically as physics/chem/bio/EECS come online.
 *
 * Env:
 *   MMLU_MODEL        answer model (default llama3.2:3b)
 *   MMLU_PER_SUBJECT  questions per subject (default 5; 0 = all)
 *   MMLU_K            retrieved chunks injected in the brain arm (default 4)
 *   MMLU_ARMS         comma list of arms to run (default "baseline,brain")
 *   MMLU_SUBJECTS     comma list to restrict subjects (default: all brain-ready)
 *   MMLU_MAX_CHUNKS   per-field memory cap on loaded chunks (default 150000)
 *   MMLU_SEED         shuffle seed for the per-subject sample (default time-based)
 *   OLLAMA_HOST       ollama base (default http://127.0.0.1:11434)
 *
 * Usage:  OLLAMA_HOST=http://127.0.0.1:11434 npx tsx scripts/mmlu-brain-bench.ts
 *         MMLU_SUBJECTS=college_mathematics,abstract_algebra MMLU_PER_SUBJECT=20 npx tsx ...
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { embedText } from '../lib/ollama.js'

const HOME = os.homedir()
const BANK = path.join(HOME, '.noetica', 'corpus', 'benchmarks', 'mmlu_stem.json')
const BRAIN = process.env['OCW_BRAIN'] || path.join(HOME, 'Downloads', 'MIT OCW', '_brain')
const BASE = (process.env['OLLAMA_HOST'] || 'http://127.0.0.1:11434').replace(/\/$/, '')
const MODEL = process.env['MMLU_MODEL'] || 'llama3.2:3b'
const PER = Number(process.env['MMLU_PER_SUBJECT'] ?? 5)
const K = Number(process.env['MMLU_K'] || 4)
const SHOT_K = Number(process.env['MMLU_SHOT_K'] || 8)      // chunks injected after multi-shot union
const PER_SHOT = Number(process.env['MMLU_PER_SHOT'] || 3)  // chunks each query (broad + per-choice) contributes
const ARMS = (process.env['MMLU_ARMS'] || 'baseline,brain').split(',').map((s) => s.trim()).filter(Boolean)
const CONC = Number(process.env['MMLU_CONC'] || 6)   // questions scored concurrently — ollama calls are I/O; serial left the GPU idle
const MMR_LAMBDA = Number(process.env['MMLU_MMR'] || 0) // >0 enables MMR diverse selection (relevance vs novelty); cluster_analysis showed top-8 collapse into ~2 cells
const MAX_CHUNKS = Number(process.env['MMLU_MAX_CHUNKS'] || 150_000)
const SEED = Number(process.env['MMLU_SEED'] ?? (Date.now() % 2147483647))
const TIMEOUT = Number(process.env['MMLU_TIMEOUT_MS'] || 120_000)
const LETTERS = ['A', 'B', 'C', 'D']
const TRANSCRIPT = path.join(HOME, '.noetica', `mmlu-brain-${Date.now()}.jsonl`)

// MMLU subject → brain field(s) that cover it.
const SUBJECT_FIELDS: Record<string, string[]> = {
  college_mathematics: ['mathematics'], abstract_algebra: ['mathematics'],
  high_school_mathematics: ['mathematics'], high_school_statistics: ['mathematics'],
  college_physics: ['physics'], conceptual_physics: ['physics'], high_school_physics: ['physics'],
  astronomy: ['physics', 'earth_planetary'],
  college_chemistry: ['chemistry'], high_school_chemistry: ['chemistry'],
  college_biology: ['biology', 'biological_eng'], high_school_biology: ['biology', 'biological_eng'],
  college_computer_science: ['eecs'], electrical_engineering: ['eecs'],
}

// FIELD_ADJ — co-prime / adjacent fields to WIDEN into when per-choice coverage is thin. The
// elimination retriever pulls these only when the in-field posterior isn't peaked (biochem needs
// chemistry+biology; a genetics problem needs probability from mathematics; astrophysics spans both).
const FIELD_ADJ: Record<string, string[]> = {
  mathematics: ['physics', 'eecs'], physics: ['mathematics', 'chemistry', 'earth_planetary'],
  chemistry: ['physics', 'biology', 'biological_eng'], biology: ['chemistry', 'biological_eng'],
  biological_eng: ['biology', 'chemistry'], eecs: ['mathematics', 'physics'], earth_planetary: ['physics'],
}

const FRONTIER = { 'Llama-3.2-3B (reported)': 63.4, 'Qwen2.5-7B (reported)': 74.2, 'GPT-4': 86.4 }

interface Q { subject: string; question: string; choices: string[]; answer: number }
interface Chunk { text: string; slug: string; material: string; vec: Float32Array; norm: number }

// ── seeded shuffle (mulberry32) ───────────────────────────────────────────────
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!] }
  return a
}

// ── chunk hygiene ──────────────────────────────────────────────────────────────
// OCW PDFs extract with glyph failures (U+FFFD �), control chars, and ragged
// whitespace. Injecting that raw confuses a small model into never committing to an
// answer. Clean it, then drop chunks that are mostly garbage so only legible material
// reaches the prompt. (The stored embedding was computed on the raw text — that's fine
// for retrieval; we only sanitize what we INJECT.)
function cleanText(s: string): string {
  return s
    .replace(/\uFFFD/g, ' ')                                  // failed-glyph replacement char
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') // control chars (keep tab/nl/cr)
    .replace(/[ \t]+/g, ' ')                                   // collapse spaces/tabs
    .replace(/ *\n[ \n]*/g, '\n')                              // collapse blank lines
    .trim()
}
function usableChunk(text: string): boolean {
  if (text.length < 100) return false
  const letters = (text.match(/[A-Za-z]/g) || []).length
  return letters >= 50   // enough real prose/symbols to be worth injecting
}

// ── brain: load a field's chunks into a compact in-memory index ────────────────
const fieldCache = new Map<string, Chunk[]>()
function fieldDir(field: string): string { return path.join(BRAIN, field) }
function fieldReady(field: string): boolean {
  const d = fieldDir(field)
  return fs.existsSync(d) && fs.readdirSync(d).some((f) => f.endsWith('.jsonl'))
}
function loadField(field: string): Chunk[] {
  if (fieldCache.has(field)) return fieldCache.get(field)!
  const dir = fieldDir(field)
  const chunks: Chunk[] = []
  if (fs.existsSync(dir)) {
    for (const fn of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
      if (chunks.length >= MAX_CHUNKS) break
      const lines = fs.readFileSync(path.join(dir, fn), 'utf8').split('\n')
      for (const line of lines) {
        if (!line.trim() || chunks.length >= MAX_CHUNKS) continue
        try {
          const o = JSON.parse(line) as { text?: string; slug?: string; material?: string; vec?: string; dims?: number }
          if (!o.text || !o.vec) continue
          const text = cleanText(o.text)
          if (!usableChunk(text)) continue   // drop garbled / near-empty chunks before they can be injected
          const buf = Buffer.from(o.vec, 'base64')
          const vec = new Float32Array(buf.buffer, buf.byteOffset, (o.dims || 768))
          let n = 0; for (let i = 0; i < vec.length; i++) n += vec[i]! * vec[i]!
          chunks.push({ text, slug: o.slug || fn, material: o.material || 'reference', vec, norm: Math.sqrt(n) || 1 })
        } catch { /* skip bad line */ }
      }
    }
  }
  fieldCache.set(field, chunks)
  return chunks
}
function topK(qVec: number[], pools: Chunk[][], k: number): Chunk[] {
  let qn = 0; for (const v of qVec) qn += v * v; qn = Math.sqrt(qn) || 1
  const scored: Array<{ c: Chunk; s: number }> = []
  for (const pool of pools) for (const c of pool) {
    let dot = 0; const m = Math.min(qVec.length, c.vec.length)
    for (let i = 0; i < m; i++) dot += qVec[i]! * c.vec[i]!
    scored.push({ c, s: dot / (qn * c.norm) })
  }
  scored.sort((a, b) => b.s - a.s)
  // de-dupe near-identical texts, keep the k best distinct
  const out: Chunk[] = []; const seen = new Set<string>()
  for (const { c } of scored) { const key = c.text.slice(0, 80); if (seen.has(key)) continue; seen.add(key); out.push(c); if (out.length >= k) break }
  return out
}

// Multi-shot retrieval: a broad query (question + all choices) THEN one targeted query per answer
// choice — 2nd/3rd-shot specificity. Each option pulls the chunk that would confirm/refute IT, so
// the discriminating fact lands in context. For memorization subjects (biology) this is the
// difference between "the topic is in the brain" and "the answer is in the brain". Union by best
// cosine across shots, dedup, take the top finalK.
// embedCached — brain, qgen, champion and verify all re-embed the SAME per-choice queries.
// Memoize so each distinct query embeds once per run (cuts ollama calls ~half).
const _embCache = new Map<string, Promise<number[]>>()
function embedCached(text: string): Promise<number[]> {
  const k = text.slice(0, 240)
  let p = _embCache.get(k)
  if (!p) { p = embedText(text); _embCache.set(k, p) }
  return p
}

// cosine between two already-loaded chunk vectors (norms precomputed) — for MMR novelty
function chunkCos(a: Chunk, b: Chunk): number {
  let dot = 0; const m = Math.min(a.vec.length, b.vec.length)
  for (let i = 0; i < m; i++) dot += a.vec[i]! * b.vec[i]!
  return dot / ((a.norm || 1) * (b.norm || 1))
}

async function retrieveMulti(question: string, choices: string[], pools: Chunk[][], perShot: number, finalK: number, extra: string[] = []): Promise<Chunk[]> {
  const queries = [`${question}\n${choices.join(' ')}`, ...choices.map((c) => `${question}\n${c}`), ...extra.filter(Boolean)]
  const best = new Map<string, { c: Chunk; s: number }>()
  for (const query of queries) {
    const qv = await embedCached(query)
    if (!qv.length) continue
    let qn = 0; for (const v of qv) qn += v * v; qn = Math.sqrt(qn) || 1
    const shot: Array<{ c: Chunk; s: number }> = []
    for (const pool of pools) for (const c of pool) {
      let dot = 0; const m = Math.min(qv.length, c.vec.length)
      for (let i = 0; i < m; i++) dot += qv[i]! * c.vec[i]!
      shot.push({ c, s: dot / (qn * c.norm) })
    }
    shot.sort((a, b) => b.s - a.s)
    for (const hit of shot.slice(0, perShot)) {
      const key = hit.c.text.slice(0, 80)
      const prev = best.get(key)
      if (!prev || hit.s > prev.s) best.set(key, hit)
    }
  }
  const ranked = [...best.values()].sort((a, b) => b.s - a.s)
  if (MMR_LAMBDA <= 0 || ranked.length <= finalK) return ranked.slice(0, finalK).map((x) => x.c)
  // MMR: greedily pick finalK balancing relevance (cosine to query) against novelty (low similarity
  // to already-picked). Fixes the redundancy where brute-force top hits collapse into one sub-topic,
  // so the K context slots carry K distinct facets instead of the same fact restated.
  const pool = ranked.slice(0, Math.max(finalK * 5, 40))
  const picked: Array<{ c: Chunk; s: number }> = []
  while (picked.length < finalK && pool.length) {
    let bi = 0, bScore = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const r = pool[i]!
      let maxSim = 0
      for (const p of picked) { const sim = chunkCos(r.c, p.c); if (sim > maxSim) maxSim = sim }
      const mmr = MMR_LAMBDA * r.s - (1 - MMR_LAMBDA) * maxSim
      if (mmr > bScore) { bScore = mmr; bi = i }
    }
    picked.push(pool.splice(bi, 1)[0]!)
  }
  return picked.map((x) => x.c)
}

// eliminateArm — the Monty-Hall MCQ play. Instead of a quick top-k match, gather confirm/REFUTE
// evidence per CHOICE (the doors), score them, and treat the choices as competing (ruling one out
// lifts the others). A three-way verdict — SUPPORT / REFUTE / INSUFFICIENT — makes elimination
// explicit and, crucially, marks which choices we DON'T yet have coverage for. The saturation gate:
// if the posterior isn't peaked OR a choice is still uncovered, WIDEN into adjacent/co-prime fields
// and probe again. Only then commit. Never defaults to A.
async function eliminateArm(question: string, choices: string[], pools: Chunk[][], wider: Chunk[][]):
  Promise<{ letter: string; coverage: number; rounds: number; margin: number }> {
  const n = choices.length
  const score = new Array<number>(n).fill(0)
  const covered = new Array<boolean>(n).fill(false)
  let rounds = 0
  const probe = async (ps: Chunk[][]) => {
    if (!ps.length) return
    rounds++
    await Promise.all(choices.map(async (ch, i) => {
      const hits = await retrieveMulti(question, [ch], ps, PER_SHOT, 5)
      const ctx = hits.map((h, k) => `[${k + 1}] ${h.text.slice(0, 380)}`).join('\n\n')
      const raw = await ask(`MIT course evidence:\n${ctx}\n\nQuestion: ${question}\nCandidate answer: "${ch}"\n\nWeighing the evidence and sound reasoning on THIS candidate only, reply ONE line exactly: "VERDICT: SUPPORT|REFUTE|INSUFFICIENT conf 0.NN".`)
      const m = /VERDICT:\s*(SUPPORT|REFUTE|INSUFFICIENT)\D*([01](?:\.\d+)?)?/i.exec(raw)
      const v = m ? m[1]!.toUpperCase() : 'INSUFFICIENT'
      const conf = m && m[2] != null ? Math.min(1, Math.max(0, Number(m[2]))) : 0.5
      if (v === 'SUPPORT') { score[i]! += conf; covered[i] = true }
      else if (v === 'REFUTE') { score[i]! -= conf; covered[i] = true }   // elimination — pushes mass to the rest
    }))
  }
  await probe(pools)
  const margin = () => { const s = [...score].sort((a, b) => b - a); return (s[0] ?? 0) - (s[1] ?? 0) }
  const peaked = () => covered.every(Boolean) && margin() > 0.3
  if (!peaked()) await probe(wider)                        // coverage gate → widen into co-prime fields
  const mx = Math.max(...score)
  const top = score.map((s, i) => ({ s, i })).filter((x) => x.s === mx)
  const best = top.length > 1 ? (top.find((x) => x.i !== 0)?.i ?? top[0]!.i) : top[0]!.i   // tie-break away from A
  return { letter: LETTERS[best]!, coverage: covered.filter(Boolean).length / n, rounds, margin: margin() }
}

// ── model ──────────────────────────────────────────────────────────────────────
const SYS = 'You are taking a multiple-choice exam. Reason in ONE short sentence, then end with a line "FINAL: X" where X is exactly one of A, B, C, or D.'
async function ask(prompt: string, temperature = 0): Promise<string> {
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, stream: false, temperature, max_tokens: 220, messages: [{ role: 'system', content: SYS }, { role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(TIMEOUT),
    })
    const d = await res.json() as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> }
    const m = d.choices?.[0]?.message
    return (m?.content || m?.reasoning_content || '').trim()
  } catch { return '' }
}

// askVote — self-consistency: sample K answers at temperature, return the MAJORITY letter.
// The single biggest universal MMLU lift in the literature, and it launders positional A-bias out
// of the answer (a bias toward "A" washes out across diverse samples). Unaffordable on CPU; cheap
// on the L4. k<=1 collapses to one temp-0 answer (voting off), so non-champion arms are unaffected.
const SC_K = Number(process.env['MMLU_SC_K'] || 5)
async function askVote(prompt: string, k: number): Promise<{ letter: string; agree: number }> {
  if (k <= 1) return { letter: extractLetter(await ask(prompt)), agree: 1 }
  const votes = new Map<string, number>()
  for (let s = 0; s < k; s++) {
    const l = extractLetter(await ask(prompt, 0.7))
    if (l) votes.set(l, (votes.get(l) || 0) + 1)
  }
  if (!votes.size) return { letter: extractLetter(await ask(prompt)), agree: 0 }
  const [letter, n] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]!
  return { letter, agree: n / k }
}

// gen — neutral-system generation for query generation. MUST NOT use the MCQ SYS, or the model
// answers "FINAL: X" instead of writing the passage we want to embed.
async function gen(prompt: string): Promise<string> {
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, stream: false, temperature: 0, max_tokens: 220, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(TIMEOUT),
    })
    const d = await res.json() as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> }
    const m = d.choices?.[0]?.message
    return (m?.content || m?.reasoning_content || '').trim()
  } catch { return '' }
}

// queryGen — proper query generation + expansion BEFORE retrieval. nomic-embed matches surface form,
// so a terse MCQ stem sits in question-space, not the textbook-prose-space the corpus lives in.
// We add two extra query shots (cheap on a GPU model; was unaffordable on CPU, cached per question):
//   • HyDE      — a hypothetical textbook passage answering the question, embedded in document-space
//   • step-back — the general concept/principle/theorem being tested, to surface governing material
const qgCache = new Map<string, string[]>()
async function queryGen(question: string, choices: string[]): Promise<string[]> {
  if (qgCache.has(question)) return qgCache.get(question)!
  const out: string[] = []
  const hyde = await gen(`Write a 2-3 sentence factual passage, in the style of a textbook, stating the facts, definitions, or laws needed to answer the following. Do NOT mention the question or the options; just assert the relevant knowledge directly.\n\nQuestion: ${question}\nOptions: ${choices.join(' | ')}`)
  if (hyde.replace(/\s+/g, ' ').trim().length > 20) out.push(hyde.replace(/\s+/g, ' ').trim().slice(0, 600))
  const sb = await gen(`Name the single general concept, principle, theorem, or topic this question tests. Reply with ONLY a short noun phrase (3-8 words), no sentence, no punctuation.\n\n${question}`)
  const sbc = (sb.split('\n')[0] || '').replace(/^[^a-zA-Z]+/, '').replace(/[."']+$/, '').trim()
  if (sbc.length > 2 && sbc.length < 80) out.push(sbc)
  qgCache.set(question, out)
  return out
}

// "Plug in each answer" — what a good student does. Instead of "pick one of four" (which a weak
// model answers with a positional A-bias), verify EACH choice independently against its own
// targeted evidence, then take the best-supported. Per-option scoring sidesteps the bias and forces
// the model to evaluate each option on its merits.
async function verifyArm(question: string, choices: string[], pools: Chunk[][]): Promise<{ letter: string; scores: number[] }> {
  const scores: number[] = []
  for (let i = 0; i < choices.length; i++) {
    const ctx = (await retrieveMulti(question, [choices[i]!], pools, PER_SHOT, 4)).map((h, n) => `[${n + 1}] ${h.text.slice(0, 400)}`).join('\n\n')
    const prompt = `Relevant MIT course notes (use only what helps):\n${ctx}\n\nQuestion: ${question}\nProposed answer: "${choices[i]}"\n\nUsing the notes and sound reasoning, is the proposed answer the CORRECT answer to the question? Reply on ONE line exactly: "VERDICT: YES conf 0.NN" or "VERDICT: NO conf 0.NN".`
    const raw = await ask(prompt)
    const m = /VERDICT:\s*(YES|NO)\D*([01](?:\.\d+)?)?/i.exec(raw)
    const yes = m ? /yes/i.test(m[1]!) : /\byes\b/i.test(raw)
    const conf = m && m[2] != null ? Math.min(1, Math.max(0, Number(m[2]))) : 0.5
    scores[i] = yes ? conf : -conf   // best-supported wins; an explicit NO pushes it negative
  }
  let best = 0; for (let i = 1; i < scores.length; i++) if (scores[i]! > scores[best]!) best = i
  return { letter: LETTERS[best]!, scores }
}
function extractLetter(raw: string): string {
  const t = raw.trim()
  // 1. explicit FINAL: directive (strongest) — tolerate **bold**, parens, spacing
  let m = /FINAL:\s*\**\(?\s*([A-D])\b/i.exec(t); if (m) return m[1]!.toUpperCase()
  // 2. "the answer is C", "answer: (C)", "correct answer = D"
  m = /\bans(?:wer)?\b[^A-Da-d]{0,12}\(?\*?([A-D])\b/i.exec(t); if (m) return m[1]!.toUpperCase()
  // 3. a parenthesized / trailing-paren letter near the end: "(C)" or "C)"
  m = /\(\s*([A-D])\s*\)|\b([A-D])\)/.exec(t.slice(-50)); if (m) return (m[1] || m[2])!.toUpperCase()
  // 4. fallback: the LAST standalone A–D anywhere in the reply
  m = /\b([A-D])\b(?![\s\S]*\b[A-D]\b)/.exec(t); return m ? m[1]!.toUpperCase() : ''
}
function pct(a: number, b: number): string { return b ? (100 * a / b).toFixed(1) : '0.0' }

// ── verified-compute arm: the model only PARSES; units + the law catalog compute and certify ──
const COMPUTE_PY = path.join(__dirname, 'compute_arm.py')
interface CompRes { answer: string | null; mode: string }
/** Score the whole compute arm for a subject in ONE python call (one sympy import). Each result
 *  is the verified answer letter, or null=abstain when no law fits / units reject the extraction. */
function computeBatch(qs: Q[]): CompRes[] {
  const res: CompRes[] = qs.map(() => ({ answer: null, mode: 'abstain' }))
  if (!qs.length) return res
  const input = qs.map((q, i) => JSON.stringify({ id: i, question: q.question, choices: q.choices })).join('\n') + '\n'
  try {
    const out = execFileSync('python3', [COMPUTE_PY, '--batch'], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env } })
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      try { const r = JSON.parse(line) as { id: number; answer: string | null; mode: string }; if (typeof r.id === 'number' && r.id < res.length) res[r.id] = { answer: r.answer, mode: r.mode } } catch { /* skip a bad line */ }
    }
  } catch { return qs.map(() => ({ answer: null, mode: 'error' })) }
  return res
}

const KTYPE_PY = path.join(__dirname, 'knowledge_type.py')
interface KType { types: string[]; solver: string }
/** Classify each question's knowledge type (one python call) so the CHAMPION arm understands the
 *  problem BEFORE approaching: compute the computational, verify the conceptual, retrieve the factual. */
function ktypeBatch(qs: Q[]): KType[] {
  const res: KType[] = qs.map(() => ({ types: ['BasicFacts'], solver: 'retrieve' }))
  if (!qs.length) return res
  const input = qs.map((q, i) => JSON.stringify({ id: i, question: q.question, choices: q.choices })).join('\n') + '\n'
  try {
    const out = execFileSync('python3', [KTYPE_PY, '--batch'], { input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env } })
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      try { const r = JSON.parse(line) as { id: number; types: string[]; solver: string }; if (typeof r.id === 'number' && r.id < res.length) res[r.id] = { types: r.types, solver: r.solver } } catch { /* skip */ }
    }
  } catch { /* default all to retrieve */ }
  return res
}

async function main() {
  const mmlu = JSON.parse(fs.readFileSync(BANK, 'utf8')) as Record<string, Q[]>
  const rand = rng(SEED)

  // which subjects can we run? (their field has shards on disk)
  let subjects = Object.keys(mmlu).filter((s) => SUBJECT_FIELDS[s]?.some(fieldReady))
  if (process.env['MMLU_SUBJECTS']) {
    const want = new Set(process.env['MMLU_SUBJECTS'].split(',').map((s) => s.trim()))
    subjects = subjects.filter((s) => want.has(s))
  }
  const skipped = Object.keys(mmlu).filter((s) => !subjects.includes(s))

  console.log(`# MMLU brain-bench — model=${MODEL} | arms=[${ARMS.join(', ')}] | k=${K} | ${PER || 'all'}/subject | seed=${SEED}`)
  console.log(`# brain=${BRAIN} | base=${BASE}`)
  console.log(`# brain-ready subjects (${subjects.length}): ${subjects.join(', ')}`)
  if (skipped.length) console.log(`# waiting on vectorize (${skipped.length}): ${skipped.join(', ')}`)
  console.log(`# transcript: ${TRANSCRIPT}\n`)
  if (!subjects.length) { console.log('No brain-ready subjects yet — let the vectorizer finish a field first.'); return }

  const tally: Record<string, Record<string, { c: number; n: number; a?: number }>> = {} // arm → subject → {c,n,attempted}
  for (const arm of ARMS) tally[arm] = {}

  for (const subject of subjects) {
    const fields = SUBJECT_FIELDS[subject]!.filter(fieldReady)
    const pools = fields.map(loadField)
    const widerPools = ARMS.includes('elim')
      ? [...new Set(fields.flatMap((f) => FIELD_ADJ[f] ?? []).filter((f) => !fields.includes(f) && fieldReady(f)))].map(loadField)
      : []
    const poolN = pools.reduce((a, p) => a + p.length, 0)
    const sample = shuffle(mmlu[subject]!, rand).slice(0, PER > 0 ? PER : mmlu[subject]!.length)
    process.stdout.write(`\n## ${subject}  (fields: ${fields.join('+')} · ${poolN.toLocaleString()} chunks · ${sample.length} q)\n`)
    for (const arm of ARMS) tally[arm]![subject] = { c: 0, n: 0, a: 0 }
    // verified-compute arm scored up front (one python call per subject); used by compute + route + champion
    const comp: CompRes[] = (ARMS.includes('compute') || ARMS.includes('route') || ARMS.includes('champion')) ? computeBatch(sample) : []
    // knowledge-type per question (the 'understand first' step) — used by the champion router
    const kt: KType[] = ARMS.includes('champion') ? ktypeBatch(sample) : []

    const scoreQuestion = async (i: number) => {
      const q = sample[i]!
      const base = `${q.question}\n\n${q.choices.map((c, j) => `${LETTERS[j]}. ${c}`).join('\n')}`
      const gold = LETTERS[q.answer]
      const row: Record<string, unknown> = { subject, i, gold }

      // brain retrieval (shared by the brain arm AND the route arm's fallback) — multi-shot:
      // a broad query + one targeted query per choice, union top-K. MMLU_SHOT_K sets how many
      // chunks land in context (default 8); MMLU_PER_SHOT how many each query contributes (default 3).
      let context = ''
      if (ARMS.includes('brain') || ARMS.includes('route')) {
        const hits = await retrieveMulti(q.question, q.choices, pools, PER_SHOT, SHOT_K)
        context = hits.map((h, n) => `[${n + 1}] ${h.text.slice(0, 500)}`).join('\n\n')
        row['sources'] = hits.map((h) => `${h.slug}:${h.material}`)
      }

      // queryGen arm: identical retriever + model, but with HyDE + step-back query shots added.
      // Same answer path as brain → the column isolates the retrieval lift from query generation.
      // Also built for champion, whose retrieve path uses this same HyDE/qgen context.
      let qgenContext = ''
      if (ARMS.includes('qgen') || ARMS.includes('champion')) {
        const extra = await queryGen(q.question, q.choices)
        row['qgen'] = extra.map((e) => e.slice(0, 70))
        const hits = await retrieveMulti(q.question, q.choices, pools, PER_SHOT, SHOT_K, extra)
        qgenContext = hits.map((h, n) => `[${n + 1}] ${h.text.slice(0, 500)}`).join('\n\n')
        row['qgen_sources'] = hits.map((h) => `${h.slug}:${h.material}`)
      }

      // Same answer-format rule on every model-answered arm — the only difference is the injected
      // context (brain) or the path taken (route), so the comparison stays fair.
      const ANSWER_RULE = '\n\nReason in ONE short sentence, then output exactly one final line: "FINAL: X" (X = A, B, C, or D).'
      const brainPrompt = `Relevant MIT course notes (use only what helps; ignore noise and fragments):\n\n${context}\n\nExam question:\n${base}${ANSWER_RULE}`
      let brainLetter: string | undefined // memoize so brain + route don't double-ask the model
      const askBrain = async (): Promise<string> => (brainLetter ??= extractLetter(await ask(brainPrompt)))
      const qgenPrompt = `Relevant MIT course notes (use only what helps; ignore noise and fragments):\n\n${qgenContext}\n\nExam question:\n${base}${ANSWER_RULE}`
      let qgenLetter: string | undefined
      const askQgen = async (): Promise<string> => (qgenLetter ??= extractLetter(await ask(qgenPrompt)))
      const ci = comp[i]
      const marks: string[] = []
      const results: Array<{ arm: string; ok: boolean; attempted: boolean }> = []
      for (const arm of ARMS) {
        let letter = ''; let mode = ''; let attempted = true
        if (arm === 'compute') {                 // verified compute only (abstains where no law fits)
          letter = ci?.answer ?? ''; mode = ci?.mode ?? 'abstain'; attempted = !!ci?.answer
        } else if (arm === 'route') {             // the dispatch: compute where computable, else retrieve
          if (ci?.answer) { letter = ci.answer; mode = ci.mode } else { letter = await askBrain(); mode = 'retrieve' }
        } else if (arm === 'brain') {
          letter = await askBrain()
        } else if (arm === 'qgen') {              // brain + HyDE/step-back query generation
          letter = await askQgen(); mode = 'qgen'
        } else if (arm === 'elim') {              // Monty-Hall: per-choice confirm/REFUTE, posterior, coverage-gated widening
          const e = await eliminateArm(q.question, q.choices, pools, widerPools)
          letter = e.letter; mode = `elim:cov${Math.round(e.coverage * 100)}:r${e.rounds}`
          row['coverage'] = e.coverage; row['elim_rounds'] = e.rounds; row['elim_margin'] = Number(e.margin.toFixed(2))
        } else if (arm === 'verify') {            // plug EACH choice in, verify vs its evidence, pick best
          const v = await verifyArm(q.question, q.choices, pools)
          letter = v.letter; mode = 'verify'
          row['verify_scores'] = v.scores.map((s) => Number(s.toFixed(2)))
        } else if (arm === 'champion') {          // THE CROWN — a COUNCIL: ensemble every signal so it can't lose to a member
          const k = kt[i] ?? { types: ['BasicFacts'], solver: 'retrieve' }
          row['ktype'] = k.types
          if (k.solver === 'compute' && ci?.answer && ci.mode !== 'prog') {
            letter = ci.answer; mode = `compute:${ci.mode}`           // exact computation overrides the council
          } else {
            // Reuse the answers baseline/brain/qgen ALREADY produced this question (free — they run
            // before champion), add a diverse closed-book self-consistency reasoning vote, and take a
            // confidence-weighted majority. Designed so champion can't do worse than its members in the
            // typical case: agreement compounds, disagreement breaks toward the reasoning vote, and it
            // NEVER defaults to A (the trap the old verify path fell into — it picked A 31% vs gold 19%).
            const w = new Map<string, number>()
            const add = (L: unknown, wt: number) => { if (typeof L === 'string' && L && L !== '?') w.set(L, (w.get(L) ?? 0) + wt) }
            add(row['baseline_pred'], 1)        // closed-book reasoning
            add(row['brain_pred'], 1)           // retrieval
            add(row['qgen_pred'], 1)            // HyDE retrieval
            const sc = await askVote(`${base}${ANSWER_RULE}`, SC_K)   // diverse reasoning vote (no retrieval noise)
            add(sc.letter, 1 + sc.agree)                              // weight ≤2: breaks ties + can pair with baseline to overrule retrieval on the lanes it hurts, but never overrules a unanimous 3-arm council
            row['sc_agree'] = Number(sc.agree.toFixed(2))
            const ranked = [...w.entries()].sort((a, b) =>
              b[1] - a[1] || (a[0] === sc.letter ? -1 : b[0] === sc.letter ? 1 : a[0] === 'A' ? 1 : b[0] === 'A' ? -1 : 0))
            letter = ranked[0]?.[0] || sc.letter || 'B'
            mode = `council:${k.types?.[0] ?? '?'}`
          }
        } else {                                  // baseline (closed book)
          letter = extractLetter(await ask(`${base}${ANSWER_RULE}`))
        }
        const ok = letter === gold
        results.push({ arm, ok, attempted })
        row[`${arm}_pred`] = letter || '?'; row[`${arm}_ok`] = ok; if (mode) row[`${arm}_mode`] = mode
        marks.push(`${arm}:${ok ? '✓' : '✗'}${arm === 'compute' && !attempted ? '·' : (letter || '?')}`)
      }
      return { i, row, marks, gold, results }
    }

    // bounded-parallel over questions (ollama I/O overlaps); apply shared state in order
    for (let s = 0; s < sample.length; s += CONC) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(CONC, sample.length - s) }, (_, j) => scoreQuestion(s + j)),
      )
      for (const r of batch) {
        for (const res of r.results) {
          const t = tally[res.arm]![subject]!; t.n++; if (res.ok) t.c++
          if (res.arm === 'compute' && res.attempted) t.a = (t.a ?? 0) + 1
        }
        fs.appendFileSync(TRANSCRIPT, JSON.stringify(r.row) + '\n')
        console.log(`  ${String(r.i + 1).padStart(3)}. ${r.marks.join('  ')}  /${r.gold}`)
      }
    }
  }

  // ── summary ──
  console.log(`\n# ════════ results (model ${MODEL}) ════════`)
  const header = `  ${'subject'.padEnd(26)}` + ARMS.map((a) => a.padStart(10)).join('') + (ARMS.length === 2 ? '     Δ' : '')
  console.log(header)
  const totals: Record<string, { c: number; n: number; a: number }> = {}
  for (const arm of ARMS) totals[arm] = { c: 0, n: 0, a: 0 }
  for (const subject of subjects) {
    const cells = ARMS.map((a) => { const t = tally[a]![subject]!; totals[a]!.c += t.c; totals[a]!.n += t.n; totals[a]!.a += t.a ?? 0; return `${pct(t.c, t.n)}%`.padStart(10) })
    let delta = ''
    if (ARMS.length === 2 && tally['brain'] && tally['baseline']) {
      const b = tally['brain'][subject]!, base = tally['baseline'][subject]!
      const d = (100 * b.c / b.n) - (100 * base.c / base.n)
      delta = `  ${d >= 0 ? '+' : ''}${d.toFixed(1)}`
    }
    console.log(`  ${subject.padEnd(26)}${cells.join('')}${delta}`)
  }
  const totLine = ARMS.map((a) => `${pct(totals[a]!.c, totals[a]!.n)}%`.padStart(10)).join('')
  let totDelta = ''
  if (ARMS.length === 2 && totals['brain'] && totals['baseline']) {
    const d = (100 * totals['brain'].c / totals['brain'].n) - (100 * totals['baseline'].c / totals['baseline'].n)
    totDelta = `  ${d >= 0 ? '+' : ''}${d.toFixed(1)}`
  }
  console.log(`  ${'── OVERALL'.padEnd(26)}${totLine}${totDelta}`)
  if (totals['compute']) {
    const cv = totals['compute']!
    console.log(`  ${'   ↳ compute'.padEnd(26)}  fired on ${cv.a}/${cv.n} (${pct(cv.a, cv.n)}%) · accuracy-on-fired ${pct(cv.c, cv.a)}%  (the verified-compute moat; rest abstain${ARMS.includes('route') ? ' → routed to brain' : ''})`)
  }
  console.log(`\n# reference (published overall MMLU):`)
  for (const [k, v] of Object.entries(FRONTIER)) console.log(`  ${k.padEnd(26)} ${v}%`)
  console.log(`\n# transcript: ${TRANSCRIPT}`)
}
main().catch((e) => { console.error(e); process.exit(1) })

/**
 * sft-harvest — the SUCCESS/training half of the verifier→training loop.
 *
 * eval-capture.captureFailure grows a regression set from FAILED turns; this grows an SFT set from
 * VERIFIED-correct production turns — rejection sampling: keep only what the grounding-verifier
 * accepted with confidence. The shard (verified.sft.jsonl) is what the Atlas causal_lm_lora trainer
 * (tritfabric) fine-tunes on, submitted via /api/tune → POST /v1/train. This is the data link that
 * turns "sharper per turn" (the loop) into "sharper per week" (the model).
 */
import type { Trace } from './eval-capture.js'

export interface SftExample { input: string; output: string; coverage: number; capturedAt: number }

/**
 * Dual of captureFailure: promote a trace to an SFT positive iff it's verified, well-covered,
 * non-abstained, and non-trivial. The coverage bar is HIGHER than the failure capture — we only
 * train on confident wins, not merely "not a failure".
 */
export function captureVerified(
  trace: Trace,
  now: number,
  opts: { minCoverage?: number; minOutputLen?: number } = {},
): SftExample | null {
  const minCoverage = opts.minCoverage ?? 0.7
  const minOutputLen = opts.minOutputLen ?? 24
  if (!trace.verified) return null
  if (trace.coverage < minCoverage) return null
  if (trace.decision === 'abstain') return null
  const input = (trace.input ?? '').trim()
  const output = (trace.output ?? '').trim()
  if (input.length < 4 || output.length < minOutputLen) return null
  return { input, output, coverage: trace.coverage, capturedAt: now }
}

/** One JSONL line. Stores coverage/capturedAt too (the trainer reads input/output and ignores the
 *  rest — read_sft_texts), so a re-read can still dedupe by quality. */
export function toSftLine(ex: SftExample): string {
  return JSON.stringify({ input: ex.input, output: ex.output, coverage: ex.coverage, capturedAt: ex.capturedAt })
}

/** Parse a shard's text back into examples (tolerant — skips malformed / incomplete lines). */
export function readSftShard(text: string): SftExample[] {
  const out: SftExample[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const r = JSON.parse(t) as Partial<SftExample>
      if (r.input && r.output) {
        out.push({ input: r.input, output: r.output, coverage: Number(r.coverage ?? 0), capturedAt: Number(r.capturedAt ?? 0) })
      }
    } catch {
      /* skip malformed line */
    }
  }
  return out
}

/** Dedupe by normalized input, keeping the highest-coverage example (tie → most recent). */
export function dedupeVerified(xs: SftExample[]): SftExample[] {
  const byInput = new Map<string, SftExample>()
  for (const x of xs) {
    const k = x.input.trim().toLowerCase()
    const prev = byInput.get(k)
    if (!prev || x.coverage > prev.coverage || (x.coverage === prev.coverage && x.capturedAt > prev.capturedAt)) {
      byInput.set(k, x)
    }
  }
  return [...byInput.values()]
}

/**
 * Build the Atlas SubmitTrainJob request (POST /v1/train) for a harvested shard — the contract the
 * tritfabric causal_lm_lora entrypoint consumes (DatasetSpec.train.uri, ResourceSpec, peft).
 */
export function buildTuneRequest(opts: {
  datasetUri: string
  baseModel: string
  examples: number
  gpu?: number
}): Record<string, unknown> {
  return {
    tenant: 'noetica',
    task: 'generation',
    entrypoint: 'causal_lm_lora',
    metric: 'train_loss',
    mode: 'min',
    base_model: opts.baseModel,
    train: { uri: opts.datasetUri },
    peft: { r: 16, alpha: 32 },
    resources: { CPU: 4, GPU: opts.gpu ?? 1, MEM: 24 },
    use_ray: true,
    note: `noetica verified-trace SFT (${opts.examples} examples)`,
  }
}

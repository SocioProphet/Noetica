/**
 * nli-availability — the "NLI unavailable" vs "NLI says NEUTRAL" distinction.
 *
 * Pre-fix, the grounding endpoints hard-coded a generate() that swallowed every
 * error into the string 'NEUTRAL'. verifyGroundingNLI/makeLlmEntail interpret
 * NEUTRAL as "the judge saw the claim but neither entails nor contradicts it",
 * so on a machine WITHOUT the qwen2.5:7b model, every claim silently resolved
 * as neutral and the Answer-Card surfaced "X/Y sentences supported" — a
 * fabricated support count rather than an honest "check not run".
 *
 * This module splits those two states:
 *   1) probeNliModel(model) — before the run, is the model on the local Ollama
 *      inventory? Returns { available, reason }. When false the endpoint returns
 *      { available:false, ... } and does NOT invoke the verifier at all.
 *   2) makeTrackingEntail(model, generate) — wraps generate so a runtime error
 *      (model pulled mid-run, ollama restarted, transient 500) flips
 *      wasAvailable() to false and the endpoint reports that instead of a
 *      score derived from silent-NEUTRAL fallbacks.
 *
 * Two-layer because either alone leaves a hole: probe-only misses runtime
 * outages, wrap-only misses the common case (model was never installed).
 */

import { isOllamaRunning, listLocalModels } from './ollama.js'

export interface NliProbe {
  available: boolean
  reason?: string
  model?: string
}

/** Pre-flight: is Ollama up AND does its model list include `model`? */
export async function probeNliModel(model: string): Promise<NliProbe> {
  const running = await isOllamaRunning()
  if (!running) return { available: false, reason: 'ollama_unreachable', model }
  const inventory = await listLocalModels()
  // A local Ollama tag can be tagged with or without a repo prefix (`qwen2.5:7b` vs
  // `library/qwen2.5:7b`). Accept a suffix match on the requested id so the probe
  // isn't overly strict about which form the operator installed.
  const has = inventory.some((n) => n === model || n.endsWith('/' + model) || n.startsWith(model + '@'))
  if (!has) return { available: false, reason: 'model_not_installed', model }
  return { available: true, model }
}

export interface TrackingEntail {
  entail: (prompt: string) => Promise<string>
  wasAvailable: () => boolean
  lastError: () => string | undefined
}

/** Wrap a generate function so runtime errors flip `wasAvailable()` to false.
 *  On error the wrapper still returns 'NEUTRAL' — the downstream verifier keeps
 *  producing a shape-valid result — but the endpoint MUST check wasAvailable()
 *  and, when false, surface { available:false } instead of the (now meaningless)
 *  score. Passing the caller responsibility explicitly is deliberate: it makes
 *  the "confidently wrong support count" defect impossible to reintroduce by
 *  copy-paste. */
export function makeTrackingEntail(
  generate: (prompt: string) => Promise<string>,
): TrackingEntail {
  let ok = true
  let err: string | undefined
  return {
    entail: async (prompt: string) => {
      try {
        return await generate(prompt)
      } catch (e) {
        ok = false
        err = e instanceof Error ? e.message : String(e)
        return 'NEUTRAL'
      }
    },
    wasAvailable: () => ok,
    lastError: () => err,
  }
}

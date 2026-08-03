// Model warm-up readiness — the honest version.
//
// Before this, "the local model is still warming up" was inferred AFTER a request
// failed (a regex over the error string), with no model name, no elapsed time, and the
// composer stayed enabled — so the user's first message hit a cold model, failed, and
// they retried into the same wall. This module is the proactive signal instead: a model
// is READY when it is resident in the runtime (Ollama `/api/ps`), and the UI names it and
// counts the wait until then.
//
// Pure and unit-tested; the network probe and the React wiring consume these.

/** Ollama tags default to `:latest`; compare on the base name when a tag is absent. */
function normalizeTag(id: string): { base: string; tag: string } {
  const [base, tag = 'latest'] = id.toLowerCase().trim().split(':')
  return { base, tag }
}

/**
 * Is `modelId` resident (loaded) in the runtime? `loadedModels` is the list the runtime
 * reports as in-memory (Ollama `/api/ps`). Matches exact id, and an untagged request
 * against any resident tag of the same base (so asking for `qwen2.5` is satisfied by a
 * loaded `qwen2.5:7b`), never the reverse (a specific tag needs that exact tag).
 */
export function isModelReady(modelId: string | null | undefined, loadedModels: readonly string[]): boolean {
  if (!modelId) return false
  const want = normalizeTag(modelId)
  const wantUntagged = !modelId.includes(':')
  return loadedModels.some((loaded) => {
    const have = normalizeTag(loaded)
    if (have.base !== want.base) return false
    return wantUntagged || have.tag === want.tag
  })
}

const FRIENDLY: Record<string, string> = {
  qwen2: 'Qwen 2', 'qwen2.5': 'Qwen 2.5', 'qwen2.5-coder': 'Qwen 2.5 Coder', qwen3: 'Qwen 3',
  llama3: 'Llama 3', 'llama3.1': 'Llama 3.1', 'llama3.2': 'Llama 3.2',
  'deepseek-r1': 'DeepSeek-R1', 'deepseek-v3': 'DeepSeek-V3', mistral: 'Mistral',
  'llava': 'LLaVA', 'nomic-embed-text': 'Nomic Embed', gemma2: 'Gemma 2', gemma3: 'Gemma 3', phi3: 'Phi-3',
}

/** Human-facing model name, tag preserved. `qwen2.5:7b` → `Qwen 2.5:7b`. */
export function friendlyModelName(modelId: string): string {
  const { base } = normalizeTag(modelId)
  const tag = modelId.includes(':') ? modelId.slice(modelId.indexOf(':')) : ''
  return (FRIENDLY[base] ?? base.charAt(0).toUpperCase() + base.slice(1)) + tag
}

/** The warm-up label the composer shows while a model loads. */
export function warmupLabel(modelId: string, elapsedMs: number): string {
  const secs = Math.max(0, Math.round(elapsedMs / 1000))
  return `Loading ${friendlyModelName(modelId)}… ${secs}s`
}

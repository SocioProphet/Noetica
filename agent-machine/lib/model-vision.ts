// Which models can actually accept image input.
//
// Used to decide whether an image-bearing turn must be routed to a vision model, and
// (with the router) to record it honestly when an explicitly-chosen text model is
// swapped for one.
//
// This is deliberately a capability ALLOWLIST, not a "cloud vs local" name proxy. The
// previous heuristic treated every model whose name began with a cloud family
// (deepseek, mistral, command, sonar, o1 …) as image-capable — so an explicit
// deepseek-r1 plus an image read as "can see images" and the turn was never routed to
// the installed VLM, then told the user to install a vision model that was already
// there. Those families are text-only. When unsure we return false, which routes the
// image to a real vision model rather than a blind one — the safe direction.

// Open / local vision models (Ollama tags) and Mistral's Pixtral.
const VLM_PATTERNS: RegExp[] = [
  /llava/, /bakllava/, /moondream/, /minicpm-?v/, /pixtral/,
  /llama-?3\.2-vision/, /qwen2\.?5?-?vl/, /-vl\b/, /vl:/, /vision/,
]

// Reliably-multimodal cloud families. Precise on purpose — bare mistral / deepseek /
// command / sonar / o1-mini / o3-mini are text-only and must NOT match.
const CLOUD_VISION_PATTERNS: RegExp[] = [
  /^claude-3/, /^claude-(opus|sonnet|haiku)/, /^claude-[4-9]/,
  /^gpt-4o/, /^gpt-4-turbo/, /^gpt-4-vision/, /^gpt-4\.[1-9]/, /^gpt-[5-9]/, /^chatgpt-4o/,
  /^gemini/,
  /^grok-vision/, /^grok-[2-9][^ ]*vision/,
]

/** True only when `modelId` is confidently able to accept image input. */
export function canModelSeeImages(modelId: string | null | undefined): boolean {
  if (!modelId) return false
  const m = modelId.toLowerCase().trim()
  if (VLM_PATTERNS.some((re) => re.test(m))) return true
  if (CLOUD_VISION_PATTERNS.some((re) => re.test(m))) return true
  return false
}

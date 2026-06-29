/**
 * agent-session — developer-facing session API for the Noetica model mesh.
 *
 * Design mirrors Apple's LanguageModelSession:
 *   LanguageModelSession → AgentSession
 *   .light / .moderate / .deep → Reasoning.LIGHT / MODERATE / DEEP
 *   @Generable + session.respond(to:, generating: T.self) → schema + session.respond(prompt, { schema })
 *
 * Reasoning levels map to the same env-var model suite the Python prophet-agent-session uses,
 * so both libraries are interchangeable at a protocol level.
 *
 * Environment:
 *   PROPHET_LIGHT_MODEL     Local model for LIGHT lane  (default llama3.2:1b)
 *   PROPHET_MODERATE_MODEL  Local model for MODERATE     (default qwen3:14b)
 *   PROPHET_DEEP_MODEL      Local model for DEEP          (default qwen3:14b)
 *   ANTHROPIC_API_KEY       If set, DEEP enables Anthropic fallback
 *   PROPHET_HOSTED_MODEL    Anthropic model for DEEP fallback (default claude-sonnet-4-6)
 */
import { generateOllamaText, streamOllama } from './ollama.js'

// ── Reasoning levels ──────────────────────────────────────────────────────────

export enum Reasoning {
  LIGHT     = 'light',     // fastest local model, best for classification/intent
  MODERATE  = 'moderate',  // default: balanced quality+speed (qwen3:14b)
  DEEP      = 'deep',      // best quality: local → Anthropic fallback on failure
  SOVEREIGN = 'sovereign', // local-only, zero egress — raises on any hosted attempt
}

export enum RoutePolicy {
  LOCAL_FIRST = 'local-first', // prefer local, allow hosted if configured
  LOCAL_ONLY  = 'local-only',  // never call hosted APIs (SOVEREIGN default)
  HOSTED_OK   = 'hosted-ok',   // prefer hosted quality
}

/** JSON Schema object that the model must satisfy in its structured response. */
export type OutputSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
  [key: string]: unknown
}

// ── Provider interface (injectable for testing) ────────────────────────────────

export interface SessionProvider {
  generate(params: {
    model: string
    messages: Array<{ role: 'system' | 'user'; content: string }>
    responseFormat?: { type: 'json_schema'; json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean } }
  }): Promise<{ content: string; reasoning: string }>
  stream(params: {
    model: string
    messages: Array<{ role: 'system' | 'user'; content: string }>
  }): AsyncGenerator<{ text?: string }>
}

export interface SessionConfig {
  reasoning?: Reasoning
  policy?: RoutePolicy
  system?: string
  /** Injectable provider — override in tests to avoid live network calls. */
  _provider?: SessionProvider
}

// ── Model + effort resolution ─────────────────────────────────────────────────

const MODEL_ENV: Record<Reasoning, string> = {
  [Reasoning.LIGHT]:     'PROPHET_LIGHT_MODEL',
  [Reasoning.MODERATE]:  'PROPHET_MODERATE_MODEL',
  [Reasoning.DEEP]:      'PROPHET_DEEP_MODEL',
  [Reasoning.SOVEREIGN]: 'PROPHET_MODERATE_MODEL',
}
const MODEL_DEFAULT: Record<Reasoning, string> = {
  [Reasoning.LIGHT]:     'llama3.2:1b',
  [Reasoning.MODERATE]:  'qwen3:14b',
  [Reasoning.DEEP]:      'qwen3:14b',
  [Reasoning.SOVEREIGN]: 'qwen3:14b',
}
const MAX_TOKENS: Record<Reasoning, number> = {
  [Reasoning.LIGHT]:     512,
  [Reasoning.MODERATE]:  2048,
  [Reasoning.DEEP]:      4096,
  [Reasoning.SOVEREIGN]: 2048,
}

function localModel(r: Reasoning): string {
  return process.env[MODEL_ENV[r]] ?? MODEL_DEFAULT[r]
}
function defaultPolicy(r: Reasoning): RoutePolicy {
  return r === Reasoning.SOVEREIGN ? RoutePolicy.LOCAL_ONLY : RoutePolicy.LOCAL_FIRST
}

// ── Default (real) provider ────────────────────────────────────────────────────

const DEFAULT_PROVIDER: SessionProvider = {
  async generate(params) {
    return generateOllamaText({
      model: params.model,
      messages: params.messages,
      responseFormat: params.responseFormat,
    })
  },
  // eslint-disable-next-line @typescript-eslint/require-await
  async *stream(params) {
    for await (const event of streamOllama({
      model: params.model,
      messages: params.messages as Parameters<typeof streamOllama>[0]['messages'],
      enableThinking: false,
    })) {
      if ('text' in event && typeof event.text === 'string') yield { text: event.text }
    }
  },
}

// ── Anthropic hosted fallback (DEEP only) ─────────────────────────────────────

async function callAnthropic(params: {
  model: string; system?: string; prompt: string; schema?: OutputSchema; maxTokens: number
}): Promise<string> {
  const apiKey = process.env['ANTHROPIC_API_KEY']
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set — cannot fall back to hosted provider')

  const systemParts: string[] = []
  if (params.system) systemParts.push(params.system)
  if (params.schema) {
    systemParts.push(
      `You MUST respond with valid JSON that conforms exactly to this JSON Schema:\n${JSON.stringify(params.schema, null, 2)}\nOutput only the JSON object — no prose, no fences.`
    )
  }

  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.maxTokens,
    messages: [{ role: 'user', content: params.prompt }],
  }
  if (systemParts.length) body['system'] = systemParts.join('\n\n')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`)
  const data = await res.json() as { content?: Array<{ text?: string }> }
  return data.content?.[0]?.text ?? ''
}

// ── Schema instruction + parsing ──────────────────────────────────────────────

function schemaInstruction(schema: OutputSchema): string {
  return (
    `You MUST respond with valid JSON that strictly conforms to this JSON Schema:\n` +
    `${JSON.stringify(schema, null, 2)}\n` +
    `Output ONLY the JSON object — no prose, no markdown fences.`
  )
}

function parseStructured(raw: string): Record<string, unknown> {
  const stripped = raw.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim()
  return JSON.parse(stripped) as Record<string, unknown>
}

// ── AgentSession ──────────────────────────────────────────────────────────────

export class AgentSession {
  private readonly reasoning: Reasoning
  private readonly policy: RoutePolicy
  private readonly system?: string
  private readonly _provider: SessionProvider

  constructor(config: SessionConfig = {}) {
    this.reasoning = config.reasoning ?? Reasoning.MODERATE
    this.policy = config.policy ?? defaultPolicy(this.reasoning)
    this.system = config.system
    this._provider = config._provider ?? DEFAULT_PROVIDER
  }

  /**
   * Send a single prompt and get a response.
   *
   * When `schema` is provided the model is constrained to emit valid JSON
   * matching that schema, and the return value is the parsed object.
   * Without a schema the raw string is returned.
   */
  async respond(prompt: string, opts: { schema?: OutputSchema } = {}): Promise<string | Record<string, unknown>> {
    const { schema } = opts
    const maxTokens = MAX_TOKENS[this.reasoning]
    const model = localModel(this.reasoning)

    const messages: Array<{ role: 'system' | 'user'; content: string }> = []
    const systemParts: string[] = []
    if (this.system) systemParts.push(this.system)
    if (schema) systemParts.push(schemaInstruction(schema))
    if (systemParts.length) messages.push({ role: 'system', content: systemParts.join('\n\n') })
    messages.push({ role: 'user', content: prompt })

    const responseFormat = schema
      ? { type: 'json_schema' as const, json_schema: { name: 'response', schema: schema as Record<string, unknown>, strict: true } }
      : undefined

    if (this.reasoning === Reasoning.DEEP && this.policy !== RoutePolicy.LOCAL_ONLY) {
      try {
        const { content } = await this._provider.generate({ model, messages, responseFormat })
        return schema ? parseStructured(content) : content
      } catch {
        // Hosted fallback for DEEP lane — transparent to the caller
        const hostedModel = process.env['PROPHET_HOSTED_MODEL'] ?? 'claude-sonnet-4-6'
        const text = await callAnthropic({ model: hostedModel, system: this.system, prompt, schema, maxTokens })
        return schema ? parseStructured(text) : text
      }
    }

    const { content } = await this._provider.generate({ model, messages, responseFormat })
    return schema ? parseStructured(content) : content
  }

  /**
   * Stream a response token-by-token, yielding text chunks as they arrive.
   * Structured output is not supported in stream mode — use `respond()` for that.
   */
  async *stream(prompt: string): AsyncGenerator<string> {
    const model = localModel(this.reasoning)
    const messages: Array<{ role: 'system' | 'user'; content: string }> = []
    if (this.system) messages.push({ role: 'system', content: this.system })
    messages.push({ role: 'user', content: prompt })

    for await (const event of this._provider.stream({ model, messages })) {
      if (event.text) yield event.text
    }
  }
}

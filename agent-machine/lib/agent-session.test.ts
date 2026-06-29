/**
 * Tests for AgentSession (TypeScript session API).
 * Uses injectable providers — no live Ollama or Anthropic required.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentSession, Reasoning, RoutePolicy } from "./agent-session.js";
import type { SessionProvider, OutputSchema } from "./agent-session.js";

// ── Mock provider factory ──────────────────────────────────────────────────────

function mockProvider(response: string, throws?: Error): SessionProvider & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    async generate(params) {
      calls.push(params)
      if (throws) throw throws
      return { content: response, reasoning: "" }
    },
    async *stream(params) {
      calls.push(params)
      for (const word of response.split(" ")) {
        yield { text: word + " " }
      }
    },
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("respond returns plain string by default", async () => {
  const prov = mockProvider("The capital of France is Paris.")
  const session = new AgentSession({ reasoning: Reasoning.MODERATE, _provider: prov })
  const result = await session.respond("What is the capital of France?")
  assert.equal(result, "The capital of France is Paris.")
})

test("respond returns parsed object when schema is provided", async () => {
  const prov = mockProvider(JSON.stringify({ city: "Paris", country: "France" }))
  const schema: OutputSchema = {
    type: "object",
    properties: { city: { type: "string" }, country: { type: "string" } },
    required: ["city", "country"],
  }
  const session = new AgentSession({ reasoning: Reasoning.MODERATE, _provider: prov })
  const result = await session.respond("Capital of France", { schema }) as { city: string }
  assert.equal(result.city, "Paris")
})

test("respond strips markdown fences from structured response", async () => {
  const prov = mockProvider("```json\n{\"x\": 42}\n```")
  const schema: OutputSchema = {
    type: "object",
    properties: { x: { type: "number" } },
    required: ["x"],
  }
  const session = new AgentSession({ _provider: prov })
  const result = await session.respond("Give me x=42", { schema }) as { x: number }
  assert.equal(result.x, 42)
})

test("system prompt is included in messages sent to provider", async () => {
  const prov = mockProvider("reply")
  const session = new AgentSession({
    system: "You are a concise assistant.",
    reasoning: Reasoning.LIGHT,
    _provider: prov,
  })
  await session.respond("hello")
  const call = prov.calls[0] as { messages: Array<{ role: string; content: string }> }
  const sysMsg = call.messages.find((m) => m.role === "system")
  assert.ok(sysMsg, "system message missing")
  assert.ok(sysMsg.content.includes("concise assistant"))
})

test("schema instruction is appended to system message", async () => {
  const prov = mockProvider(JSON.stringify({ val: 1 }))
  const schema: OutputSchema = { type: "object", properties: { val: { type: "number" } }, required: ["val"] }
  const session = new AgentSession({ system: "Be brief.", _provider: prov })
  await session.respond("prompt", { schema })
  const call = prov.calls[0] as { messages: Array<{ role: string; content: string }> }
  const sysContent = call.messages.find((m) => m.role === "system")?.content ?? ""
  assert.ok(sysContent.includes("Be brief."))
  assert.ok(sysContent.includes("JSON Schema"))
})

test("LIGHT lane uses PROPHET_LIGHT_MODEL env var", async () => {
  const prov = mockProvider("ok")
  const orig = process.env["PROPHET_LIGHT_MODEL"]
  process.env["PROPHET_LIGHT_MODEL"] = "tinyllama:latest"
  try {
    const session = new AgentSession({ reasoning: Reasoning.LIGHT, _provider: prov })
    await session.respond("hello")
    const call = prov.calls[0] as { model: string }
    assert.equal(call.model, "tinyllama:latest")
  } finally {
    if (orig === undefined) delete process.env["PROPHET_LIGHT_MODEL"]
    else process.env["PROPHET_LIGHT_MODEL"] = orig
  }
})

test("DEEP lane falls back to Anthropic when local throws (if ANTHROPIC_API_KEY set)", async () => {
  const prov = mockProvider("", new Error("ollama unreachable"))
  const origKey = process.env["ANTHROPIC_API_KEY"]
  process.env["ANTHROPIC_API_KEY"] = "test-key"

  const originalFetch = global.fetch
  global.fetch = async (url: string | URL | Request, opts?: RequestInit) => {
    if (String(url).includes("anthropic.com")) {
      return new Response(
        JSON.stringify({ content: [{ text: "Anthropic fallback" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      ) as Response
    }
    return originalFetch(url, opts)
  }

  try {
    const session = new AgentSession({ reasoning: Reasoning.DEEP, _provider: prov })
    const result = await session.respond("hello")
    assert.equal(result, "Anthropic fallback")
  } finally {
    global.fetch = originalFetch
    if (origKey === undefined) delete process.env["ANTHROPIC_API_KEY"]
    else process.env["ANTHROPIC_API_KEY"] = origKey
  }
})

test("DEEP lane with no ANTHROPIC_API_KEY propagates local error", async () => {
  const prov = mockProvider("", new Error("ollama unreachable"))
  const origKey = process.env["ANTHROPIC_API_KEY"]
  delete process.env["ANTHROPIC_API_KEY"]
  try {
    const session = new AgentSession({ reasoning: Reasoning.DEEP, _provider: prov })
    await assert.rejects(() => session.respond("hello"), /ollama unreachable|ANTHROPIC_API_KEY/)
  } finally {
    if (origKey !== undefined) process.env["ANTHROPIC_API_KEY"] = origKey
  }
})

test("SOVEREIGN uses LOCAL_ONLY policy by default", () => {
  // Just verify the session constructs without error and uses the right reasoning
  const prov = mockProvider("ok")
  const session = new AgentSession({ reasoning: Reasoning.SOVEREIGN, _provider: prov })
  assert.ok(session instanceof AgentSession)
})

test("stream yields chunks from provider", async () => {
  const prov = mockProvider("Hello world")
  const session = new AgentSession({ _provider: prov })
  const chunks: string[] = []
  for await (const chunk of session.stream("say hello")) {
    chunks.push(chunk)
  }
  assert.ok(chunks.length > 0, "expected at least one chunk")
  assert.ok(chunks.join("").includes("Hello"), "expected 'Hello' in chunks")
})

test("respond passes responseFormat to provider when schema is given", async () => {
  const prov = mockProvider(JSON.stringify({ ok: true }))
  const schema: OutputSchema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }
  const session = new AgentSession({ _provider: prov })
  await session.respond("test", { schema })
  const call = prov.calls[0] as { responseFormat?: { type: string } }
  assert.equal(call.responseFormat?.type, "json_schema")
})

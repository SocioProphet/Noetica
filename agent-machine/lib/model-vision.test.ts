import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canModelSeeImages } from './model-vision.js'
import { buildRouterDecision, LOCAL_MODEL_SUITE } from './router.js'

test('text-only "cloud-looking" models are NOT image-capable (the B1-3 bug)', () => {
  for (const id of ['deepseek-r1:8b', 'deepseek-v3', 'mistral:7b', 'mixtral', 'command-r', 'sonar', 'o1-mini', 'o3-mini']) {
    assert.equal(canModelSeeImages(id), false, `${id} should be text-only`)
  }
})

test('real vision models — local VLMs and multimodal cloud — are image-capable', () => {
  for (const id of ['llava:13b', 'llava', 'bakllava', 'llama3.2-vision', 'qwen2.5vl:7b', 'minicpm-v', 'moondream', 'pixtral',
                    'claude-3-5-sonnet', 'claude-opus-4-8', 'gpt-4o', 'gpt-4-turbo', 'gpt-4.1', 'gemini-1.5-pro', 'grok-2-vision']) {
    assert.equal(canModelSeeImages(id), true, `${id} should see images`)
  }
})

test('empty / null is safe (routes to a real VLM rather than a blind one)', () => {
  assert.equal(canModelSeeImages(''), false)
  assert.equal(canModelSeeImages(null), false)
  assert.equal(canModelSeeImages(undefined), false)
})

// End-to-end: the exact scenario Gus reported — explicit text model + an image, with a
// VLM installed — must route to the VLM, not send the image to the blind model.
test('an explicit text model + image routes to the installed VLM (not "no vision model")', () => {
  const allModels = LOCAL_MODEL_SUITE.map((m) => m.name)
  const decision = buildRouterDecision({
    requestId: 'r', content: 'describe this image',
    ollamaAvailable: true, hasAnthropicKey: false, hasOpenAIKey: false,
    explicitModelId: 'deepseek-r1:8b', hasImages: true, availableModels: allModels,
  })
  assert.equal(decision.domain, 'vision')
  assert.ok(canModelSeeImages(decision.resolvedModel), `routed model ${decision.resolvedModel} must be vision-capable`)
  assert.notEqual(decision.resolvedModel, 'deepseek-r1:8b')
})

test('an explicit VLM is respected — no override', () => {
  const allModels = LOCAL_MODEL_SUITE.map((m) => m.name)
  const decision = buildRouterDecision({
    requestId: 'r', content: 'describe this image',
    ollamaAvailable: true, hasAnthropicKey: false, hasOpenAIKey: false,
    explicitModelId: 'llava:13b', hasImages: true, availableModels: allModels,
  })
  assert.equal(decision.resolvedModel, 'llava:13b')
})

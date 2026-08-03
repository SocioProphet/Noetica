import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isModelReady, friendlyModelName, warmupLabel } from './modelReadiness'

test('a model is ready only when it is resident in the runtime', () => {
  assert.equal(isModelReady('qwen2.5:7b', ['qwen2.5:7b', 'nomic-embed-text']), true)
  assert.equal(isModelReady('qwen2.5:7b', ['nomic-embed-text']), false)
  assert.equal(isModelReady('qwen2.5:7b', []), false)
})

test('an untagged request is satisfied by any resident tag of the same base', () => {
  assert.equal(isModelReady('qwen2.5', ['qwen2.5:7b']), true)
})

test('a specific tag is NOT satisfied by a different resident tag (no false "ready")', () => {
  assert.equal(isModelReady('qwen2.5:14b', ['qwen2.5:7b']), false)
})

test('null / empty is never ready', () => {
  assert.equal(isModelReady(null, ['qwen2.5:7b']), false)
  assert.equal(isModelReady('', ['qwen2.5:7b']), false)
})

test('friendly names are human-facing, tag preserved', () => {
  assert.equal(friendlyModelName('qwen2.5:7b'), 'Qwen 2.5:7b')
  assert.equal(friendlyModelName('deepseek-r1:8b'), 'DeepSeek-R1:8b')
  assert.equal(friendlyModelName('llava:13b'), 'LLaVA:13b')
})

test('the warm-up label names the model and counts the wait', () => {
  assert.equal(warmupLabel('qwen2.5:7b', 0), 'Loading Qwen 2.5:7b… 0s')
  assert.equal(warmupLabel('qwen2.5:7b', 3400), 'Loading Qwen 2.5:7b… 3s')
})

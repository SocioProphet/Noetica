import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureVerified, toSftLine, readSftShard, dedupeVerified, buildTuneRequest } from './sft-harvest.js'

const base = { input: 'Write fib(n) in Python', output: 'def fib(n):\n    a,b=0,1\n    for _ in range(n): a,b=b,a+b\n    return a', verified: true, coverage: 0.9, decision: 'coding' }

test('captureVerified keeps a confident, verified, well-covered turn', () => {
  const ex = captureVerified(base, 1000)
  assert.ok(ex)
  assert.equal(ex!.input, base.input)
  assert.equal(ex!.coverage, 0.9)
})

test('captureVerified rejects unverified / thin-coverage / abstained / trivial', () => {
  assert.equal(captureVerified({ ...base, verified: false }, 1), null)
  assert.equal(captureVerified({ ...base, coverage: 0.5 }, 1), null)        // below 0.7 bar
  assert.equal(captureVerified({ ...base, decision: 'abstain' }, 1), null)
  assert.equal(captureVerified({ ...base, output: 'ok' }, 1), null)          // too short
})

test('toSftLine / readSftShard round-trip preserves quality fields', () => {
  const ex = captureVerified(base, 1234)!
  const text = `${toSftLine(ex)}\n\n{bad json\n${toSftLine({ ...ex, input: 'other', coverage: 0.8 })}`
  const back = readSftShard(text)
  assert.equal(back.length, 2)                      // malformed line skipped
  assert.equal(back[0]!.coverage, 0.9)
  assert.equal(back[0]!.capturedAt, 1234)
})

test('dedupeVerified keeps the highest-coverage example per input', () => {
  const xs = [
    { input: 'Q', output: 'a', coverage: 0.7, capturedAt: 1 },
    { input: 'q', output: 'b', coverage: 0.95, capturedAt: 2 },   // same input (normalized), better
    { input: 'OTHER', output: 'c', coverage: 0.8, capturedAt: 3 },
  ]
  const out = dedupeVerified(xs)
  assert.equal(out.length, 2)
  const q = out.find((x) => x.input.toLowerCase() === 'q')!
  assert.equal(q.coverage, 0.95)
})

test('buildTuneRequest emits the Atlas causal_lm_lora contract', () => {
  const req = buildTuneRequest({ datasetUri: 'gs://x/verified.sft.jsonl', baseModel: 'Qwen/Qwen2.5-Coder-7B-Instruct', examples: 42, gpu: 1 })
  assert.equal(req['entrypoint'], 'causal_lm_lora')
  assert.equal(req['task'], 'generation')
  assert.deepEqual(req['train'], { uri: 'gs://x/verified.sft.jsonl' })
  assert.equal((req['resources'] as any).GPU, 1)
  assert.equal(req['use_ray'], true)
})

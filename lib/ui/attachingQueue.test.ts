import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enqueueAttaching, dequeueAttaching } from './attachingQueue'

test('enqueue adds chips without mutating the input', () => {
  const before = ['a.pdf']
  const after = enqueueAttaching(before, ['b.txt', 'c.md'])
  assert.deepEqual(after, ['a.pdf', 'b.txt', 'c.md'])
  assert.deepEqual(before, ['a.pdf']) // immutable
})

test('dequeue removes exactly ONE occurrence (duplicate names clear independently)', () => {
  const list = ['dup.txt', 'other.md', 'dup.txt']
  const once = dequeueAttaching(list, 'dup.txt')
  assert.deepEqual(once, ['other.md', 'dup.txt']) // one dup remains
  const twice = dequeueAttaching(once, 'dup.txt')
  assert.deepEqual(twice, ['other.md'])
})

test('dequeue of an absent name is a no-op copy', () => {
  const list = ['a.pdf']
  const out = dequeueAttaching(list, 'missing.txt')
  assert.deepEqual(out, ['a.pdf'])
  assert.notEqual(out, list) // a copy, never the same ref
})

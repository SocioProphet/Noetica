import { test } from 'node:test'
import assert from 'node:assert/strict'
import { menuMaxHeightAbove } from './menuMaxHeight'

test('uses the space above the trigger, minus the margin', () => {
  assert.equal(menuMaxHeightAbove(300, 16), 284)
})

test('a tiny window gives a small-but-nonnegative height, never a clip-forcing floor', () => {
  // The old Math.max(140, …) would return 140 here and clip; we return the real space.
  assert.equal(menuMaxHeightAbove(100, 16), 84)
  assert.equal(menuMaxHeightAbove(20, 16), 4)
})

test('never negative (trigger at/above the margin)', () => {
  assert.equal(menuMaxHeightAbove(10, 16), 0)
  assert.equal(menuMaxHeightAbove(0), 0)
})

test('capped so a very tall window does not get an absurd menu', () => {
  assert.equal(menuMaxHeightAbove(2000, 16, 560), 560)
})

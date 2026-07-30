import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchDialogue } from './dialogue'

// matchDialogue returns null when the deterministic layer should NOT handle it (→ falls through to the model).
//
// This probe used to be `/🎱/.test(...)`, looking for an emoji that dialogue.ts has never
// emitted — its decision replies are plain text. So `is8ball` answered false for EVERY input:
// the two "must not be 8-balled" tests below passed vacuously and would have kept passing if
// the 8-ball had hijacked every message on the surface, which is the exact live misfire they
// were written to guard. Probe for what the implementation actually returns instead: the
// closed set of decision replies. Anything else — including null — means it did not fire.
const EIGHT_BALL_REPLIES = new Set([
  'Yes.', 'No.', 'Maybe — your call.', 'Signs point to yes.',
  'I wouldn’t count on it.', 'Ask again later.', 'Definitely.', 'Better not tell you now.',
])
const is8ball = (s: string) => {
  const reply = matchDialogue(s)?.reply
  return reply !== undefined && EIGHT_BALL_REPLIES.has(reply)
}

test('a genuine "will it…" question is NOT hijacked by the magic-8-ball', () => {
  // The exact phrasing that mis-fired in the live app.
  assert.equal(matchDialogue('will it run here or where'), null, 'a real question must fall through to the model')
  assert.equal(is8ball('will it run here or where'), false)
  // Other real technical questions that the old `will (it|i|this).*` pattern wrongly 8-balled:
  for (const q of ['will it work', 'will it run on linux', 'will this scale', 'will i need docker']) {
    assert.equal(is8ball(q), false, `"${q}" should reach the model, not the 8-ball`)
  }
})

test('any info-question (where/what/how/…) is never 8-balled', () => {
  for (const q of ['should i use postgres or where does it store data', 'is it a good idea and how do i start']) {
    assert.equal(is8ball(q), false, `"${q}" contains a question word → model`)
  }
})

test('explicit 8-ball / decision novelty still works', () => {
  assert.equal(is8ball('magic 8 ball'), true)
  assert.equal(is8ball('should i buy bitcoin'), true)
  assert.equal(is8ball('decide for me'), true)
  assert.equal(is8ball('yes or no'), true)
})

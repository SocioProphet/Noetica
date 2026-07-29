import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BAND_WINDOW_MS, PROMOTION_THRESHOLD, bandOf, reinforce, verdict, applyVerdict,
  sweepBands, bandCounts, type BandedDoc, type BandSweepReport,
} from './memory-bands.js'
import { autoDream, inMemoryStore, type TopicDoc } from './memory-layers.js'
import { bandSweepDeps, recallTopicBanded } from './memory-bands-wiring.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = 1_800_000_000_000

const doc = (over: Partial<BandedDoc> = {}): BandedDoc => ({
  name: 'topic-a', body: 'body', links: [], updatedAt: NOW, ...over,
})

test('a fresh memory starts in the session band', () => {
  assert.equal(bandOf(doc()), 'session')
})

test('inside its window an unproven memory is held, not judged early', () => {
  const v = verdict(doc({ bandSince: NOW - 2 * HOUR }), NOW)
  assert.equal(v.action, 'hold')
  assert.match(v.why, /within session window/)
})

test('enough reinforcement promotes — kept because it keeps being NEEDED', () => {
  const d = doc({ bandSince: NOW - HOUR, reinforcements: PROMOTION_THRESHOLD.session })
  const v = verdict(d, NOW)
  assert.equal(v.action, 'promote')
  assert.equal(v.to, 'daily')
  const moved = applyVerdict(d, v, NOW)!
  assert.equal(moved.band, 'daily')
  assert.equal(moved.reinforcements, 0, 'the counter resets — each band must be earned again')
  assert.equal(moved.bandSince, NOW)
})

test('a session memory nothing ever recalled is pruned when its window elapses', () => {
  const v = verdict(doc({ bandSince: NOW - (BAND_WINDOW_MS.session + HOUR) }), NOW)
  assert.equal(v.action, 'prune')
  assert.match(v.why, /zero recalls/)
  assert.equal(applyVerdict(doc(), v, NOW), null)
})

test('a memory that once earned a longer band is DEMOTED, never destroyed — a second chance', () => {
  const d = doc({ band: 'weekly', bandSince: NOW - (BAND_WINDOW_MS.weekly + DAY), reinforcements: 1 })
  const v = verdict(d, NOW)
  assert.equal(v.action, 'demote')
  assert.equal(v.to, 'daily', 'falls back one step, not to zero')
  assert.equal(applyVerdict(d, v, NOW)!.band, 'daily')
})

test('permanent never decays, and an operator pin is exempt entirely', () => {
  const perm = verdict(doc({ band: 'permanent', bandSince: 0 }), NOW)
  assert.equal(perm.action, 'hold')
  const pinned = verdict(doc({ bandSince: 0, pinned: true }), NOW)
  assert.equal(pinned.action, 'hold')
  assert.match(pinned.why, /pinned/)
})

test('every verdict explains itself — a memory never vanishes without a cause', () => {
  for (const d of [doc(), doc({ bandSince: 0 }), doc({ reinforcements: 9 })]) {
    assert.ok(verdict(d, NOW).why.length > 0)
  }
})

test('reinforce is what makes bands track usefulness rather than recency', () => {
  const once = reinforce(doc(), NOW)
  assert.equal(once.reinforcements, 1)
  assert.equal(reinforce(once, NOW).reinforcements, 2)
  assert.equal(once.bandSince, doc().updatedAt, 'reinforcing does not restart the window')
})

test('sweep reports population per band and an auditable move list', () => {
  const { survivors, report } = sweepBands([
    doc({ name: 'promoted', reinforcements: 5 }),
    doc({ name: 'held', bandSince: NOW - HOUR }),
    doc({ name: 'dropped', bandSince: NOW - (BAND_WINDOW_MS.session + HOUR) }),
  ], NOW)
  assert.equal(report.promoted, 1)
  assert.equal(report.pruned, 1)
  assert.equal(report.held, 1)
  assert.equal(survivors.length, 2)
  assert.deepEqual(bandCounts(survivors), { session: 1, daily: 1, weekly: 0, permanent: 0 })
  assert.ok(report.moves.every((m) => m.why.length > 0), 'every move carries its reason')
  assert.ok(report.moves.find((m) => m.name === 'promoted')?.to === 'daily')
})

// ── wired into consolidation, not a shelf library ───────────────────────────────
test('autoDream runs the band sweep as a real phase and reports it', async () => {
  const store = inMemoryStore()
  const stale: TopicDoc = { name: 'never-used', body: 'b', links: [], updatedAt: NOW - (BAND_WINDOW_MS.session + HOUR) }
  const keep: TopicDoc = { name: 'earned', body: 'b', links: [], updatedAt: NOW }
  await store.writeTopic(stale)
  await store.writeTopic({ ...keep, ...{ reinforcements: 5 } } as TopicDoc)

  const report = await autoDream(store, bandSweepDeps(NOW))
  assert.ok(report.bands, 'the dream reports its band decisions')
  // `bands` is deliberately `unknown` on DreamReport so memory-layers stays unaware of bands;
  // the consumer that installed the phase is the one that knows the shape.
  const bands = report.bands as BandSweepReport
  assert.equal(bands.pruned, 1, 'the never-recalled session memory is gone')
  assert.equal(bands.promoted, 1, 'the reinforced one moved up')
  assert.equal(await store.readTopic('never-used'), null)
  const survivor = (await store.readTopic('earned')) as BandedDoc | null
  assert.equal(survivor?.band, 'daily')
})

test('recall reinforces through the store — the read path feeds survival', async () => {
  const store = inMemoryStore()
  await store.writeTopic({ name: 't', body: 'b', links: [], updatedAt: NOW })
  await recallTopicBanded(store, 't', NOW)
  await recallTopicBanded(store, 't', NOW)
  const after = (await store.readTopic('t')) as BandedDoc
  assert.equal(after.reinforcements, 2, 'two recalls = two reinforcements, persisted')
  assert.equal(verdict(after, NOW).action, 'promote', 'and that is enough to earn the next band')
})

test('recalling a missing topic is a no-op, not a crash', async () => {
  const store = inMemoryStore()
  assert.equal(await recallTopicBanded(store, 'nope', NOW), null)
})

/**
 * memory-bands-wiring — where the band mechanism meets the live memory system.
 *
 * Kept separate from memory-bands.ts (pure decisions) and memory-layers.ts (pure layering)
 * so neither has to import the other at runtime: bands needs only layers' TYPES, and layers
 * stays unaware of bands. This module is the only place the two are composed, which is also
 * the only place that needs a store.
 */
import type { DreamDeps, MemoryStore } from './memory-layers.js'
import { sweepBands, reinforce, type BandedDoc } from './memory-bands.js'

/**
 * Recall a topic AND record that it was needed. Read paths should prefer this over the raw
 * `recallTopic`: survival is supposed to track usefulness, and usefulness is only observable
 * at recall. Returns the doc as the caller sees it (reinforcement is persisted separately, so
 * a read never blocks on the write).
 */
export async function recallTopicBanded(
  store: MemoryStore, name: string, now = Date.now(),
): Promise<BandedDoc | null> {
  const doc = (await store.readTopic(name)) as BandedDoc | null
  if (!doc) return null
  await store.writeTopic(reinforce(doc, now))
  return doc
}

/**
 * DreamDeps that install the band sweep as a consolidation phase. Composes with any deps the
 * caller already has; if they supply their own `bandSweep` it wins (tests, alternative policies).
 */
export function bandSweepDeps(now = Date.now(), base: DreamDeps = {}): DreamDeps {
  return {
    ...base,
    bandSweep: base.bandSweep ?? ((docs) => sweepBands(docs as BandedDoc[], now)),
  }
}

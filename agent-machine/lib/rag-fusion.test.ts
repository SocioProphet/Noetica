import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ragFusion, type Retriever, type VariantGenerator } from './rag-fusion.js'

// A fixture retriever: a fixed ranked id list per query string (best first). No model, no brain on
// disk — the teeth exercise the FUSION, deterministically.
const RANKINGS: Record<string, string[]> = {
  // Literal query: the GOLD doc is dead last; a distractor A ranks first.
  'orig query': ['A', 'B', 'C', 'D', 'GOLD'],
  // Each variant surfaces GOLD near the top from a different angle. Note GOLD is only ever moderate
  // across them individually — it is the CONSENSUS across variants that must lift it.
  'variant one': ['GOLD', 'B', 'A'],
  'variant two': ['GOLD', 'C'],
  'variant three': ['B', 'GOLD'],
}
const fixtureRetriever: Retriever = (q: string) => RANKINGS[q] ?? []
const threeVariants: VariantGenerator = () => ['variant one', 'variant two', 'variant three']

test('TEETH: a doc that ranks LOW for the single query rises to the TOP after variant-fusion', async () => {
  // Baseline — single query only (no generator): the retriever's own order, GOLD is LAST.
  const single = await ragFusion('orig query', fixtureRetriever, { n: 0 })
  assert.deepEqual(single.ranking.map((r) => r.id), ['A', 'B', 'C', 'D', 'GOLD'])
  assert.equal(single.ranking[single.ranking.length - 1]!.id, 'GOLD', 'GOLD must start LOW')

  // Variant-fusion — generate variants, retrieve per variant, RRF-fuse: GOLD is now FIRST.
  const fused = await ragFusion('orig query', fixtureRetriever, { n: 3 }, threeVariants)
  assert.equal(fused.ranking[0]!.id, 'GOLD', 'variant-fusion must float the consensus doc to the top')
  // and it genuinely moved (proves the fusion added signal, not that the fixture was pre-sorted)
  const goldSingle = single.ranking.findIndex((r) => r.id === 'GOLD')
  const goldFused = fused.ranking.findIndex((r) => r.id === 'GOLD')
  assert.ok(goldFused < goldSingle, `GOLD rose ${goldSingle}→${goldFused}`)
  // original is fused alongside the variants (4 lists total), audit trail is exposed
  assert.deepEqual(fused.variants, ['orig query', 'variant one', 'variant two', 'variant three'])
  assert.equal(fused.perVariant.length, 4)
})

test('RRF is deterministic: same inputs → same order and same scores', async () => {
  const a = await ragFusion('orig query', fixtureRetriever, { n: 3 }, threeVariants)
  const b = await ragFusion('orig query', fixtureRetriever, { n: 3 }, threeVariants)
  assert.deepEqual(a.ranking, b.ranking)
})

test('k is configurable and flows into the fusion', async () => {
  // A different k must still be deterministic and keep GOLD on top for this fixture.
  const k5 = await ragFusion('orig query', fixtureRetriever, { n: 3, k: 5 }, threeVariants)
  const k5b = await ragFusion('orig query', fixtureRetriever, { n: 3, k: 5 }, threeVariants)
  assert.deepEqual(k5.ranking, k5b.ranking)
  assert.equal(k5.ranking[0]!.id, 'GOLD')
  // different k ⇒ different absolute scores (proves k is actually used, not ignored)
  const k60 = await ragFusion('orig query', fixtureRetriever, { n: 3, k: 60 }, threeVariants)
  const s5 = k5.ranking.find((r) => r.id === 'GOLD')!.score
  const s60 = k60.ranking.find((r) => r.id === 'GOLD')!.score
  assert.notEqual(s5, s60)
})

test('DEGENERATE: no generator ⇒ single-query RRF preserves the retriever order', async () => {
  const out = await ragFusion('orig query', fixtureRetriever)
  assert.deepEqual(out.variants, ['orig query'])
  assert.deepEqual(out.ranking.map((r) => r.id), ['A', 'B', 'C', 'D', 'GOLD'])
})

test('DEGENERATE: generator returns zero variants ⇒ falls back to the single original query', async () => {
  const none: VariantGenerator = () => []
  const out = await ragFusion('orig query', fixtureRetriever, { n: 3 }, none)
  assert.deepEqual(out.variants, ['orig query'])
  assert.deepEqual(out.ranking.map((r) => r.id), ['A', 'B', 'C', 'D', 'GOLD'])
})

test('DEGENERATE: a single variant fuses to exactly that variant’s ranking', async () => {
  const one: VariantGenerator = () => ['variant one']
  const out = await ragFusion('orig query', fixtureRetriever, { n: 3, includeOriginal: false }, one)
  assert.deepEqual(out.variants, ['variant one'])
  assert.deepEqual(out.ranking.map((r) => r.id), ['GOLD', 'B', 'A'])
})

test('DEGENERATE: nothing usable (empty query, no variants) ⇒ empty result, not a crash', async () => {
  const out = await ragFusion('   ', fixtureRetriever, { includeOriginal: false })
  assert.deepEqual(out, { ranking: [], variants: [], perVariant: [] })
})

test('a generator that throws is tolerated ⇒ degrades to single-query, never errors', async () => {
  const boom: VariantGenerator = () => {
    throw new Error('model unavailable')
  }
  const out = await ragFusion('orig query', fixtureRetriever, { n: 3 }, boom)
  assert.deepEqual(out.variants, ['orig query'])
  assert.equal(out.ranking[0]!.id, 'A')
})

test('variants are de-duplicated (a variant equal to the original is not fused twice)', async () => {
  const dup: VariantGenerator = () => ['orig query', 'variant one']
  const out = await ragFusion('orig query', fixtureRetriever, { n: 3 }, dup)
  assert.deepEqual(out.variants, ['orig query', 'variant one'])
})

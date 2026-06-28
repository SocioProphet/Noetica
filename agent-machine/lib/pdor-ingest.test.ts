import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCatalogGraph } from './pdor-ingest.js'
import { evaluatePdor, type Pdor } from './data-onboarding.js'
import { characterize, parseDelimited } from './characterization.js'
import { synapseEnrich } from './synapseiq-enrich.js'

const pdor = (over: Partial<Pdor> = {}): Pdor => ({
  id: 'oct-18.01', requester: 'r', intent: 'capture',
  source: { name: 'MIT OCW 18.01' }, license: { type: 'cc-by' }, ...over,
})

const edge = (props: GraphProposalLike[], rel: string) => props.find((p) => p.op === 'add-edge' && (p.payload as any).rel === rel)
type GraphProposalLike = { op: string; payload: Record<string, unknown> }

test('open self-certified PDOR → catalog asset node, brain-eligible, with PDOR + license edges', () => {
  const d = evaluatePdor(pdor())
  const g = buildCatalogGraph(pdor(), d)
  assert.equal(g.ingested, true)
  const asset = g.proposals.find((p) => p.op === 'add-node' && (p.payload as any).kind === 'CommonsAsset')!
  assert.equal((asset.payload as any).brainEligible, true)
  assert.equal((asset.payload as any).segmented, false)
  assert.ok(edge(g.proposals, 'requested_via'))
  assert.ok(edge(g.proposals, 'licensed_under'))
})

test('segmented (CC-BY-SA, approved) → asset segmented + governed_by segment-from-brain', () => {
  const p = pdor({ license: { type: 'cc-by-sa' } })
  const d = evaluatePdor(p, [{ reviewer: 'a', role: 'license', approve: true }, { reviewer: 'b', role: 'segmentation', approve: true }])
  const g = buildCatalogGraph(p, d)
  const asset = g.proposals.find((x) => (x.payload as any).kind === 'CommonsAsset')!
  assert.equal((asset.payload as any).segmented, true)
  assert.equal((asset.payload as any).brainEligible, false)
  const govEdges = g.proposals.filter((x) => x.op === 'add-edge' && (x.payload as any).rel === 'governed_by').map((x) => (x.payload as any).to)
  assert.ok(govEdges.includes('rule:segment-from-brain'))
})

test('NO ingest key (needs-review / declined / bookmark) → nothing enters the graph', () => {
  const needs = buildCatalogGraph(pdor({ license: { type: 'cc-by-nc' } }), evaluatePdor(pdor({ license: { type: 'cc-by-nc' } })))
  assert.equal(needs.ingested, false)
  assert.equal(needs.proposals.length, 0)
  const declined = buildCatalogGraph(pdor(), evaluatePdor(pdor({ license: { type: 'proprietary' } }), [{ reviewer: 'a', role: 'license', approve: false }]))
  assert.equal(declined.ingested, false)
  const bookmark = buildCatalogGraph(pdor({ intent: 'register' }), evaluatePdor(pdor({ intent: 'register' })))
  assert.equal(bookmark.ingested, false)
})

test('characterization → classification Terms + profile props on the asset', () => {
  const p = pdor()
  const c = characterize(parseDelimited('city,lat,lon,when\nAustin,30.2,-97.7,2001-01-01\nDallas,32.7,-96.8,2014-06-01'))
  const g = buildCatalogGraph(p, evaluatePdor(p), { characterization: c })
  const terms = g.proposals.filter((x) => x.op === 'add-edge' && (x.payload as any).rel === 'classified_as').map((x) => (x.payload as any).to)
  assert.ok(terms.includes('term:geospatial'))
  assert.ok(terms.includes('term:temporal'))
  const prof = g.proposals.find((x) => x.op === 'update-prop')!
  assert.equal((prof.payload as any).hasGeo, true)
})

test('SynapseIQ enrichment → asset contains symbol edges (entity linkage)', async () => {
  const p = pdor()
  const e = await synapseEnrich('def integrate(f):\n pass\nclass Series: pass', { filename: 'calc.py' })
  const g = buildCatalogGraph(p, evaluatePdor(p), { enrichment: e })
  const contains = g.proposals.filter((x) => x.op === 'add-edge' && (x.payload as any).rel === 'contains').map((x) => (x.payload as any).to)
  assert.ok(contains.includes('integrate') && contains.includes('Series'))
})

test('fileUri → stored_as edge to the physical file', () => {
  const p = pdor()
  const g = buildCatalogGraph(p, evaluatePdor(p), { fileUri: 'gs://commons/18.01/notes.pdf' })
  assert.ok(g.proposals.some((x) => x.op === 'add-edge' && (x.payload as any).rel === 'stored_as' && (x.payload as any).to === 'file:gs://commons/18.01/notes.pdf'))
})

test('all catalog proposals are tagged source pdor-ingest (provenance)', () => {
  const g = buildCatalogGraph(pdor(), evaluatePdor(pdor()))
  assert.ok(g.proposals.every((p) => p.source === 'pdor-ingest'))
})

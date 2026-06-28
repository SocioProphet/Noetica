/**
 * pdor-ingest.ts — the integration capstone of the Knowledge Commons onboarding pipeline. Given an approved PDOR
 * (+ its characterization + SynapseIQ enrichment), build the CATALOG NODE and PROVENANCE EDGES for HellGraph as
 * governed proposals: asset -> PDOR -> license -> file -> Terms -> entities. This is where onboarding becomes
 * INTEGRATION — the asset enters the graph linked, classified, and accountable.
 *
 * Gated by the ingest key: nothing enters the graph unless evaluatePdor issued a key (self-certified open, or a
 * fully-approved licensed/restricted/published asset). The asset node carries the moat-safe flags
 * (brainEligible / segmented) so the brain-build can filter — a segmented asset is queryable in the graph but
 * never trained on. Pure (proposals only); the caller persists via graph-writeback.persistProposals.
 */

import { proposal } from './graph-proposals.js'
import type { GraphProposal } from './graph-proposals.js'
import { enrichmentToTriples, type SynapseEnrichment } from './synapseiq-enrich.js'
import { triplesToProposals } from './auto-kg.js'
import type { Pdor, PdorDecision } from './data-onboarding.js'
import type { Characterization } from './characterization.js'

export interface IngestInputs {
  characterization?: Characterization
  enrichment?: SynapseEnrichment
  fileUri?: string
}

export interface CatalogGraph {
  assetId: string
  proposals: GraphProposal[]
  ingested: boolean       // false when no key was issued (declined / bookmark / needs-review)
}

/**
 * Build the catalog node + provenance/linkage edges for an onboarded asset as governed proposals. Returns no
 * proposals (ingested:false) when the decision carries no ingest key — the graph never holds an un-approved asset.
 */
export function buildCatalogGraph(pdor: Pdor, decision: PdorDecision, inputs: IngestInputs = {}): CatalogGraph {
  const assetId = `asset:${pdor.id}`
  if (!decision.ingestKey) return { assetId, proposals: [], ingested: false }

  const src = 'pdor-ingest'
  const P: GraphProposal[] = []

  // 1. the asset node — carries the moat-safe brain flags + tier + license + quality.
  P.push(proposal('add-node', {
    id: assetId, kind: 'CommonsAsset', name: pdor.source.name,
    tier: decision.tier, openness: decision.openness,
    brainEligible: decision.brainEligible, segmented: decision.segmented,
    license: pdor.license.type, quality: inputs.characterization?.quality ?? null,
  }, `cataloged ${decision.tier} asset (${decision.brainEligible ? 'brain-eligible' : 'SEGMENTED'})`, src))

  // 2. the PDOR record node + provenance edge.
  const pdorNode = `pdor:${pdor.id}`
  P.push(proposal('add-node', { id: pdorNode, kind: 'PDOR', requester: pdor.requester, intent: pdor.intent, status: decision.status }, 'onboarding request record', src))
  P.push(proposal('add-edge', { from: assetId, to: pdorNode, rel: 'requested_via' }, 'asset provenance head', src))

  // 3. license node + edge (the asset is traceable to its license).
  const licNode = `license:${pdor.license.type}`
  P.push(proposal('add-edge', { from: assetId, to: licNode, rel: 'licensed_under' }, `license ${pdor.license.type}`, src))

  // 4. physical file edge (where it landed).
  if (inputs.fileUri) P.push(proposal('add-edge', { from: assetId, to: `file:${inputs.fileUri}`, rel: 'stored_as' }, 'physical file in the lake', src))

  // 5. governance rules as governed_by edges (segment-from-brain, attribute-on-use, ...).
  for (const rule of decision.rules) P.push(proposal('add-edge', { from: assetId, to: `rule:${rule}`, rel: 'governed_by' }, `governance rule`, src))

  // 6. classification Terms from characterization (geo / temporal / sensitive) → classified_as edges.
  const c = inputs.characterization
  if (c) {
    if (c.geospatial.hasGeo) P.push(proposal('add-edge', { from: assetId, to: 'term:geospatial', rel: 'classified_as' }, 'has geospatial structure', src))
    if (c.temporal.hasTemporal) P.push(proposal('add-edge', { from: assetId, to: 'term:temporal', rel: 'classified_as' }, 'has temporal structure', src))
    if (c.sensitive.hasPII) P.push(proposal('add-edge', { from: assetId, to: 'term:sensitive', rel: 'classified_as' }, 'contains sensitive data', src))
    // attach the profile summary as asset props.
    P.push(proposal('update-prop', { id: assetId, rows: c.rows, cols: c.cols, hasPII: c.sensitive.hasPII, hasGeo: c.geospatial.hasGeo, hasTemporal: c.temporal.hasTemporal }, 'characterization profile', src))
  }

  // 7. entity linkage from SynapseIQ enrichment (asset contains symbol; symbol is_a kind) — pending, governed.
  if (inputs.enrichment && inputs.enrichment.symbols.length) {
    P.push(...triplesToProposals(enrichmentToTriples(assetId, inputs.enrichment), assetId))
  }

  return { assetId, proposals: P, ingested: true }
}

/** Convenience: the full ingest record for the route response (decision + the catalog graph). */
export interface IngestRecord { decision: PdorDecision; catalog: CatalogGraph }

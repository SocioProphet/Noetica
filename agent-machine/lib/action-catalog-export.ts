// Machine-readable export of ACTION_CATALOG. Apple's AppIntelligence stack publishes
// AppIntentSchemas.sqlite — 16 domains, 203 intents, 54 entities — as a queryable table
// that any consumer can read without parsing the Swift shared cache. Our equivalent is
// this JSON export: the same catalogue the TypeScript layer holds, exported as data so
// docs, dashboards, and cross-repo consumers see the same set the runtime does. A drift
// between the TS layer and the exported JSON is caught by test-catalog-export.
//
// The exported shape drops the `preview` function (not serialisable) and mirrors the
// action-catalog-entry.schema.json shape exactly.

import { ACTION_CATALOG, type ActionDef } from './action-registry.js'

export type ActionCatalogEntry = Omit<ActionDef, 'preview'>

/** Serialise the catalog to the schema-conformant shape. Deterministic — sorted by id
 *  so the export is stable across runs (the same discipline as sealed receipts elsewhere). */
export function exportCatalog(): ActionCatalogEntry[] {
  return ACTION_CATALOG
    .map(({ preview: _preview, ...rest }) => rest)
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** Group entries by actionClass — the shape a dashboard or docs page consumes. */
export function groupByClass(entries: ActionCatalogEntry[] = exportCatalog()): Record<string, ActionCatalogEntry[]> {
  const out: Record<string, ActionCatalogEntry[]> = {}
  for (const e of entries) {
    (out[e.actionClass] ||= []).push(e)
  }
  return out
}

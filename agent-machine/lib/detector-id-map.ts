/**
 * detector-id-map — the consume-not-fork boundary that makes a detector firing in Noetica emit the
 * STANDARD id.
 *
 * The detectors in debate-detectors.ts emit ids under RULESET_SEMVER 0.1.0 (e.g. LOGFALL.ADHOMINEM.V1).
 * The epistemic-governance standard declares the canonical ids. This module is the governed bridge: it
 * translates an emitted id to its standard id and REJECTS any id that is not in the governed map (drift).
 *
 * VENDORED (do not edit by hand): a byte-faithful projection of the canonical governed map authored in
 *   SocioProphet/sociosphere: standards/epistemic-governance/detector-id-map.yaml
 *   sha256:60c560121725b64f3ef3ebc637f119a9a7dd63a50ff0e957dc7373c36ba844a9
 * Teeth for the map itself (bijection, existence, shipped-maturity, round-trip) live in sociosphere CI
 * (tools/validate_detector_id_map.py). Teeth for THIS consumer live in detector-id-map.test.ts.
 *
 * DELIBERATE NON-ALIAS: the standard id is the id at the maturity actually run (the shipped-tier id, which
 * ruleset 1.4.0 adopted), NOT the V2 successor. Emitting a V2 id for a V1 regex hit would launder a
 * not-yet-built detector as a detection that never ran. `succeedsInto()` reports the migration target; it
 * is never substituted for the emitted detection.
 */
import type { DetectorHit } from './debate-detectors.js'

interface IdMapEntry {
  standard: string
  succeedsInto: string | null
}

/** emitted id (ruleset 0.1.0) -> { canonical standard id, migration successor }. */
const DETECTOR_ID_MAP: Readonly<Record<string, IdMapEntry>> = {
  'LOGFALL.STRAWMAN.V1': { standard: 'LOGFALL.STRAWMAN.V1', succeedsInto: 'LOGFALL.STRAWMAN.V2' },
  'LOGFALL.ADHOMINEM.V1': { standard: 'LOGFALL.ADHOMINEM.V1', succeedsInto: 'LOGFALL.ADHOM.V2' },
  'LOGFALL.SLIPPERYSLOPE.V1': { standard: 'LOGFALL.SLIPPERYSLOPE.V1', succeedsInto: null },
  'LOGFALL.FALSEDICHOTOMY.V1': { standard: 'LOGFALL.FALSEDICHOTOMY.V1', succeedsInto: null },
  'LOGFALL.HASTYGEN.V1': { standard: 'LOGFALL.HASTYGEN.V1', succeedsInto: null },
  'LOGFALL.APPEALAUTHORITY.V1': { standard: 'LOGFALL.APPEALAUTHORITY.V1', succeedsInto: null },
  'LOGFALL.TUQUOQUE.V1': { standard: 'LOGFALL.TUQUOQUE.V1', succeedsInto: null },
  'LOGFALL.BANDWAGON.V1': { standard: 'LOGFALL.BANDWAGON.V1', succeedsInto: null },
  'LOGFALL.APPEALEMOTION.V1': { standard: 'LOGFALL.APPEALEMOTION.V1', succeedsInto: 'LOGFALL.EMOTION.V2' },
  'LOGFALL.CIRCULAR.V1': { standard: 'LOGFALL.CIRCULAR.V1', succeedsInto: null },
  'LOGFALL.SUNKCOST.V1': { standard: 'LOGFALL.SUNKCOST.V1', succeedsInto: null },
  'LOGFALL.FALSECAUSE.V1': { standard: 'LOGFALL.FALSECAUSE.V1', succeedsInto: 'LOGFALL.FALSECAUSE.V2' },
  'COGBIAS.CONFIRM.V1': { standard: 'COGBIAS.CONFIRM.V1', succeedsInto: null },
  'COGBIAS.ANCHOR.V1': { standard: 'COGBIAS.ANCHOR.V1', succeedsInto: 'COGBIAS.ANCHORING.V2' },
  'COGBIAS.ABSOLUTECERTAINTY.V1': { standard: 'COGBIAS.ABSOLUTECERTAINTY.V1', succeedsInto: null },
  'COGBIAS.AVAILABILITY.V1': { standard: 'COGBIAS.AVAILABILITY.V1', succeedsInto: null },
}

/** The set of governed standard ids a producer is permitted to emit. */
export const GOVERNED_STANDARD_IDS: ReadonlySet<string> = new Set(
  Object.values(DETECTOR_ID_MAP).map((e) => e.standard),
)

/** Every emitted id the runtime is governed to produce. */
export function emittedIds(): string[] {
  return Object.keys(DETECTOR_ID_MAP)
}

/**
 * Translate an emitted detector id to its canonical standard id.
 * Throws if the id is not in the governed map (unmapped / drifted) — REJECTED.
 */
export function toStandardId(emittedRuleId: string): string {
  const entry = DETECTOR_ID_MAP[emittedRuleId]
  if (entry === undefined) {
    throw new Error(
      `detector id "${emittedRuleId}" is not in the governed id map (unmapped / drifted) -> REJECTED`,
    )
  }
  return entry.standard
}

/** True iff `standardId` is a governed standard id. */
export function isGoverned(standardId: string): boolean {
  return GOVERNED_STANDARD_IDS.has(standardId)
}

/** The proposed V2 successor for a standard id (migration target), or null. Never emitted in its place. */
export function succeedsInto(standardId: string): string | null {
  const entry = Object.values(DETECTOR_ID_MAP).find((e) => e.standard === standardId)
  return entry ? entry.succeedsInto : null
}

/**
 * Reconcile a DetectorHit at the emission boundary: replace its emitted ruleId with the canonical
 * standard id. Throws on a drifted id, so an ungoverned id can never cross into a passport.
 */
export function reconcileHit(hit: DetectorHit): DetectorHit {
  return { ...hit, ruleId: toStandardId(hit.ruleId) }
}

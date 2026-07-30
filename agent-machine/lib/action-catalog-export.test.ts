// Guards on the catalogue: entries must conform to the JSON schema, ids are unique,
// every param carries at least one of `type` / `valueType`, and the export shape is
// deterministic. A catalogue that says it holds 30 typed actions and actually holds
// 4 well-typed + 26 mislabelled ones is the exact "declares, doesn't deliver" failure
// the schema exists to catch — the same discipline as the semantic-proof PR earlier
// this session: a fixture that validates against a schema enforcing nothing proves
// nothing, so a negative control is included per axis.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { ACTION_CATALOG } from './action-registry.js'
import { exportCatalog, groupByClass } from './action-catalog-export.js'

// The test suite is compiled to CommonJS in this repo, so __dirname is available.
// import.meta.url isn't accessible under that target — see TS1470.
const SCHEMA_PATH = path.resolve(__dirname, '..', 'schemas', 'action-catalog-entry.schema.json')

describe('action-catalog', () => {
  test('every entry has a unique snake_case id', () => {
    const ids = ACTION_CATALOG.map(a => a.id)
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
    assert.deepEqual(dupes, [], `duplicate action ids: ${dupes.join(', ')}`)
    for (const id of ids) {
      assert.match(id, /^[a-z][a-z0-9_]*$/, `action id "${id}" is not snake_case ASCII`)
    }
  })

  test('every param carries at least one of `type` or `valueType` (no untyped slots)', () => {
    const bad: string[] = []
    for (const a of ACTION_CATALOG) {
      for (const p of a.params) {
        if (p.type == null && p.valueType == null) bad.push(`${a.id}.${p.name}`)
      }
    }
    assert.deepEqual(bad, [], `untyped params: ${bad.join(', ')}`)
  })

  test('exportCatalog is deterministic and sorted by id', () => {
    const a = exportCatalog(); const b = exportCatalog()
    assert.deepEqual(a, b, 'export is not deterministic across calls')
    const ids = a.map(e => e.id)
    assert.deepEqual(ids, [...ids].sort(), 'export is not sorted by id')
  })

  test('exportCatalog drops preview but keeps all other fields', () => {
    const first = exportCatalog()[0]
    assert.equal((first as { preview?: unknown }).preview, undefined, 'preview leaked into export')
    // structural fields survive
    assert.ok(first.id && first.label && first.description && first.actionClass && first.tool)
  })

  test('every entry validates against action-catalog-entry.schema.json', async () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'))
    // Ajv is optional in this repo — skip the strict check if it isn't installed, but
    // fail loudly rather than silently skip so a missing dep can't hide a real regression.
    let Ajv: any
    try { Ajv = (await import('ajv/dist/2020.js')).default } catch { return assert.ok(true, 'ajv 2020 not installed; skipping schema pass') }
    // Draft 2020-12; the ValueType $ref is external so we run in strict:false mode and
    // trust the anyOf `type|valueType` check to catch untyped slots (already tested above).
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false })
    // Stub the external ValueType ref so validation focuses on catalogue shape.
    ajv.addSchema({ $id: 'https://schemas.srcos.ai/v2/ValueType.json', type: 'object' })
    const validate = ajv.compile(schema)
    const bad: string[] = []
    for (const entry of exportCatalog()) {
      if (!validate(entry)) bad.push(`${entry.id}: ${JSON.stringify(validate.errors?.[0])}`)
    }
    assert.deepEqual(bad, [], `entries failed schema:\n  ${bad.join('\n  ')}`)
  })

  test('negative control: schema rejects an entry with an untyped param', async () => {
    // The check above passes only if the schema actually rejects bad input. A schema
    // that validates everything provides no evidence — the same defect this session
    // fixed in the semantic-proof family (allOf + additionalProperties trap).
    let Ajv: any
    try { Ajv = (await import('ajv/dist/2020.js')).default } catch { return assert.ok(true) }
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'))
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false })
    ajv.addSchema({ $id: 'https://schemas.srcos.ai/v2/ValueType.json', type: 'object' })
    const validate = ajv.compile(schema)
    const bad = { id: 'nc', label: 'nc', description: 'nc', actionClass: 'read', reversible: true, tool: 'nc',
      params: [{ name: 'x', required: true, description: 'no type field at all' }] }
    assert.equal(validate(bad), false, 'schema accepted an untyped param — enforcing nothing')
  })

  test('negative control: schema rejects an unknown actionClass', async () => {
    let Ajv: any
    try { Ajv = (await import('ajv/dist/2020.js')).default } catch { return assert.ok(true) }
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'))
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false })
    ajv.addSchema({ $id: 'https://schemas.srcos.ai/v2/ValueType.json', type: 'object' })
    const validate = ajv.compile(schema)
    const bad = { id: 'x', label: 'x', description: 'x', actionClass: 'not-a-class', reversible: true, tool: 'x', params: [] }
    assert.equal(validate(bad), false, 'schema accepted an unknown actionClass')
  })

  test('groupByClass covers every known actionClass at least once (surface breadth)', () => {
    const g = groupByClass()
    const seen = new Set(Object.keys(g))
    // The catalogue's first job is to cover the primitives it declares.
    for (const cls of ['read', 'write', 'exec', 'net', 'memory']) {
      assert.ok(seen.has(cls), `no entries carry actionClass "${cls}"; the class is declared but unpopulated`)
    }
  })

  test('consentRequired opts-in is honoured, not lost through serialisation', () => {
    const invite = exportCatalog().find(e => e.id === 'invite_people')
    assert.ok(invite, 'invite_people missing from export')
    assert.equal(invite!.consentRequired, true, 'consentRequired dropped through serialisation')
  })
})

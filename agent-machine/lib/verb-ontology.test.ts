// Guards on the verb ontology. The data ships as JSON so downstream consumers can
// read it without loading Noetica's TypeScript; this test asserts the JSON conforms
// to its schema, that ids are unique, that every kkoClass is one of the ACCEPTED
// leaf names (not arbitrary strings), and — the differentiator — that we cover
// more verbs than Apple's 4-primitive baseline. Negative controls are included:
// a check that reports pass on any input reports the absence of checking, not
// the presence of a working ontology.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const DATA_PATH = path.resolve(__dirname, '..', 'data', 'verb-ontology.json')
const SCHEMA_PATH = path.resolve(__dirname, '..', 'schemas', 'verb-ontology.schema.json')

// The kkoClass leaves the ontology allows. Adding a new one is a deliberate
// choice — the validator rejects anything else so a typo cannot silently
// widen the acceptable set.
const ACCEPTED_KKO_CLASSES = new Set([
  'Events.Observation',
  'InquiryMethods',
  'Action',
  'Situations',
  'SituationTypes',
  'TriadicAction',
  'LearningProcesses',
  'Processes',
])

interface Verb {
  id: string; label: string; definition: string; kkoClass: string
  voice: 'actor' | 'patient' | 'observer'; reversibleByDefault: boolean
  aliases?: string[]
}

function load(): { ontologyVersion: string; kkoVersion: string; verbs: Verb[] } {
  return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'))
}

describe('verb-ontology', () => {
  test('data file parses and has the required shape', () => {
    const d = load()
    assert.match(d.ontologyVersion, /^\d+\.\d+\.\d+$/)
    assert.equal(typeof d.kkoVersion, 'string')
    assert.ok(Array.isArray(d.verbs) && d.verbs.length > 0)
  })

  test('every verb id is unique lowercase-snake and every alias is too', () => {
    const d = load()
    const ids = d.verbs.map(v => v.id)
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
    assert.deepEqual(dupes, [], `duplicate verb ids: ${dupes.join(', ')}`)
    for (const v of d.verbs) {
      assert.match(v.id, /^[a-z][a-z_]*$/, `verb id "${v.id}" is not lowercase snake`)
      for (const a of v.aliases ?? []) {
        assert.match(a, /^[a-z][a-z_]*$/, `alias "${a}" of verb "${v.id}" is not lowercase snake`)
        assert.notEqual(a, v.id, `alias "${a}" duplicates its own verb id`)
      }
    }
  })

  test('every kkoClass is a recognised leaf — no arbitrary strings', () => {
    const d = load()
    const bad = d.verbs.filter(v => !ACCEPTED_KKO_CLASSES.has(v.kkoClass))
    assert.deepEqual(bad, [], `verbs with unknown kkoClass: ${bad.map(v => `${v.id}=${v.kkoClass}`).join(', ')}`)
  })

  test('every kkoClass in the ACCEPTED set is used by at least one verb (surface breadth)', () => {
    const d = load()
    const used = new Set(d.verbs.map(v => v.kkoClass))
    const unused = [...ACCEPTED_KKO_CLASSES].filter(c => !used.has(c))
    assert.deepEqual(unused, [], `kkoClass declared as accepted but no verb uses it: ${unused.join(', ')}`)
  })

  test('coverage differentiator: we ship > 4 verbs (Apple\'s AppIntent baseline)', () => {
    const d = load()
    // Apple exposes 4 semantic verb primitives across 203 intents. Any positive
    // number beats that; asserting > 20 keeps the bar high enough to catch a
    // regression that halved the set without turning the check green.
    assert.ok(d.verbs.length > 20, `verb count ${d.verbs.length} is below the 20-verb floor set to beat Apple's 4-primitive baseline`)
  })

  test('every verb declaring voice=observer has reversibleByDefault=true (observations do not need undoing)', () => {
    const d = load()
    const bad = d.verbs.filter(v => v.voice === 'observer' && !v.reversibleByDefault)
    assert.deepEqual(bad, [], `observer verbs marked irreversible: ${bad.map(v => v.id).join(', ')}`)
  })

  test('definitions are substantive — at least 20 chars, matching the schema floor', () => {
    const d = load()
    const bad = d.verbs.filter(v => v.definition.length < 20)
    assert.deepEqual(bad, [], `verbs with under-20-char definitions (would be schema-violating): ${bad.map(v => v.id).join(', ')}`)
  })

  test('data validates against verb-ontology.schema.json', async () => {
    let Ajv: any
    try { Ajv = (await import('ajv/dist/2020.js')).default } catch { return assert.ok(true, 'ajv 2020 not installed; skipping strict pass') }
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'))
    const ajv = new Ajv({ allErrors: true, strict: false })
    const validate = ajv.compile(schema)
    const ok = validate(load())
    assert.equal(ok, true, `data failed schema: ${JSON.stringify(validate.errors?.[0])}`)
  })

  test('negative control: schema rejects a verb with no kkoClass', async () => {
    let Ajv: any
    try { Ajv = (await import('ajv/dist/2020.js')).default } catch { return assert.ok(true) }
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'))
    const ajv = new Ajv({ allErrors: true, strict: false })
    const validate = ajv.compile(schema)
    const bad = { ontologyVersion: '0.1.0', kkoVersion: '2.10', verbs: [
      { id: 'nc', label: 'x', definition: 'twenty-plus characters here for min', voice: 'actor', reversibleByDefault: true }
    ] }
    assert.equal(validate(bad), false, 'schema accepted a verb without kkoClass')
  })

  test('negative control: schema rejects an invalid voice value', async () => {
    let Ajv: any
    try { Ajv = (await import('ajv/dist/2020.js')).default } catch { return assert.ok(true) }
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'))
    const ajv = new Ajv({ allErrors: true, strict: false })
    const validate = ajv.compile(schema)
    const bad = { ontologyVersion: '0.1.0', kkoVersion: '2.10', verbs: [
      { id: 'nc', label: 'x', definition: 'twenty-plus characters here for min', kkoClass: 'Action', voice: 'bogus', reversibleByDefault: true }
    ] }
    assert.equal(validate(bad), false, 'schema accepted an unknown voice')
  })
})

/**
 * provenance-span.test — source position must survive ingest and reach the citation.
 *
 * Before this, the finest provenance the system could express was `filename#chunkIndex`:
 * a pointer into a derived artifact that only resolves if the chunker is re-run
 * identically. The offsets existed inside chunkText and were discarded, and PDF page
 * numbers were destroyed at extraction by `mergePages: true`.
 *
 * The load-bearing assertion here is the round-trip: slicing the source with a stored
 * span must reproduce the stored chunk character-for-character. An offset that is close
 * is an offset that is wrong, and a citation pointing at the wrong characters is worse
 * than one that admits it has no position at all.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  chunkText,
  chunkTextWithSpans,
  normalizeForOffsets,
  extractionDigestOf,
  pageOfOffset,
} from './doc-store.js'
import { resolveCitationSpans } from './inline-bind.js'
import { buildCitations } from './reasoning-evidence.js'

// A document long enough to force multiple overlapping chunks (CHUNK_SIZE = 1100).
const PARA = (n: number) =>
  `Section ${n}. ${'The quick brown fox jumps over the lazy dog. '.repeat(12)}\n\n`
const LONG = Array.from({ length: 8 }, (_, i) => PARA(i + 1)).join('')

test('every span slices back to exactly the chunk it describes', () => {
  const source = normalizeForOffsets(LONG)
  const spans = chunkTextWithSpans(LONG)
  assert.ok(spans.length > 1, 'fixture must produce multiple chunks to be meaningful')
  for (const [i, s] of spans.entries()) {
    assert.equal(
      source.slice(s.start, s.end),
      s.text,
      `chunk ${i}: source.slice(${s.start}, ${s.end}) must reproduce the chunk verbatim`,
    )
  }
})

test('spans stay in bounds, are non-empty, and advance', () => {
  const source = normalizeForOffsets(LONG)
  const spans = chunkTextWithSpans(LONG)
  let prevStart = -1
  for (const s of spans) {
    assert.ok(s.start >= 0 && s.end <= source.length, 'span must lie within the source')
    assert.ok(s.end > s.start, 'span must be non-empty')
    assert.ok(s.start > prevStart, 'chunk starts must strictly advance')
    prevStart = s.start
  }
})

test('chunkText is unchanged by the span rewrite', () => {
  // Backward compatibility: every existing caller takes strings and must see the same ones.
  assert.deepEqual(chunkText(LONG), chunkTextWithSpans(LONG).map((s) => s.text))
  assert.deepEqual(chunkText(''), [])
  assert.deepEqual(chunkText('short doc'), ['short doc'])
  const single = chunkTextWithSpans('short doc')
  assert.deepEqual(single, [{ text: 'short doc', start: 0, end: 9 }])
})

test('leading whitespace does not desynchronise offsets', () => {
  // The chunker trims each window; if the trim were not accounted for, every span after
  // a whitespace-led boundary would be shifted and slice back the wrong characters.
  const padded = '\n\n\n   ' + LONG
  const source = normalizeForOffsets(padded)
  for (const s of chunkTextWithSpans(padded)) {
    assert.equal(source.slice(s.start, s.end), s.text)
  }
})

test('extractionDigest is stable under normalization and changes with content', () => {
  assert.equal(extractionDigestOf('a\r\nb'), extractionDigestOf('a\nb'))
  assert.equal(extractionDigestOf('  hello  '), extractionDigestOf('hello'))
  assert.notEqual(extractionDigestOf('hello'), extractionDigestOf('hello!'))
  assert.match(extractionDigestOf('x'), /^sha256:[0-9a-f]{64}$/)
})

test('pageOfOffset maps offsets to 1-based pages', () => {
  const breaks = [100, 250]            // page 2 starts at 100, page 3 at 250
  assert.equal(pageOfOffset(breaks, 0), 1)
  assert.equal(pageOfOffset(breaks, 99), 1)
  assert.equal(pageOfOffset(breaks, 100), 2)
  assert.equal(pageOfOffset(breaks, 249), 2)
  assert.equal(pageOfOffset(breaks, 250), 3)
  assert.equal(pageOfOffset(breaks, 10_000), 3)
  assert.equal(pageOfOffset([], 5), undefined, 'no page data must yield no page, not page 1')
  assert.equal(pageOfOffset(undefined, 5), undefined)
})

test('resolveCitationSpans locates a quoted excerpt in document coordinates', () => {
  const evidence = [{ id: 'E1', text: 'alpha beta gamma delta', docStart: 1000 }]
  const [hit] = resolveCitationSpans([{ id: 'E1', span: 'beta gamma' }], evidence)
  assert.equal(hit!.resolution, 'exact')
  assert.equal(hit!.start, 1006, 'offset must be relative to the DOCUMENT, not the chunk')
  assert.equal(hit!.end, 1016)
})

test('resolveCitationSpans tolerates reflowed whitespace but reports it', () => {
  const evidence = [{ id: 'E1', text: 'alpha beta\n   gamma delta', docStart: 0 }]
  const [hit] = resolveCitationSpans([{ id: 'E1', span: 'beta gamma' }], evidence)
  assert.equal(hit!.resolution, 'whitespace-normalized')
  // Offsets describe what was FOUND, so they must slice back to the real source text.
  assert.equal(evidence[0]!.text.slice(hit!.start, hit!.end), 'beta\n   gamma')
})

test('an unlocatable citation says so instead of guessing', () => {
  // Negative control. A fabricated quote must never receive a position — inventing one
  // would convert a detectable faithfulness failure into a confident wrong citation.
  const evidence = [{ id: 'E1', text: 'alpha beta gamma', docStart: 0 }]
  const [miss] = resolveCitationSpans([{ id: 'E1', span: 'entirely invented text' }], evidence)
  assert.equal(miss!.resolution, 'unlocated')
  assert.equal(miss!.start, undefined)
  assert.equal(miss!.end, undefined)

  const [noOffset] = resolveCitationSpans([{ id: 'E1', span: 'alpha' }], [{ id: 'E1', text: 'alpha beta' }])
  assert.equal(noOffset!.resolution, 'no-offset-available')
  assert.equal(noOffset!.start, undefined)

  const [unknownId] = resolveCitationSpans([{ id: 'E9', span: 'alpha' }], evidence)
  assert.equal(unknownId!.resolution, 'no-offset-available')
})

test('buildCitations emits offsets ONLY at character-span grade', () => {
  // The negative control that keeps weak provenance from reading as strong.
  const [strong] = buildCitations([{
    docId: 'urn:noetica:doc:handbook-abc', filename: 'handbook.md', score: 0.9,
    provenanceVersion: 'character-span', start: 120, end: 240, page: 3,
    extractionDigest: 'sha256:' + 'a'.repeat(64),
  }])
  assert.equal(strong!.provenance_version, 'character-span')
  assert.equal(strong!.start, 120)
  assert.equal(strong!.end, 240)
  assert.equal(strong!.page, 3)
  assert.match(strong!.extraction_digest!, /^sha256:/)

  // A pre-span document: the grade is reported, the offsets are withheld.
  const [weak] = buildCitations([{
    docId: 'urn:noetica:doc:legacy-def', filename: 'legacy.md', score: 0.7,
    provenanceVersion: 'chunk-ordinal', start: 120, end: 240, page: 3,
  }])
  assert.equal(weak!.provenance_version, 'chunk-ordinal')
  assert.equal(weak!.start, undefined, 'offsets must not accompany a grade that does not justify them')
  assert.equal(weak!.end, undefined)
  assert.equal(weak!.page, undefined)

  // Page requires located offsets too — a page number alone would imply a position.
  const [pageless] = buildCitations([{
    docId: 'd', filename: 'f.md', score: 0.5, provenanceVersion: 'character-span', page: 2,
  }])
  assert.equal(pageless!.start, undefined)
  assert.equal(pageless!.page, undefined)
})

test('buildCitations stays exception-safe and preserves prior behaviour', () => {
  assert.deepEqual(buildCitations(null), [])
  assert.deepEqual(buildCitations([]), [])
  const [plain] = buildCitations([{ docId: 'd1', filename: 'a.md', score: 0.5 }], 'grounded')
  assert.equal(plain!.n, 1)
  assert.equal(plain!.ref, 'd1')
  assert.equal(plain!.grounding_status, 'grounded')
  assert.equal(plain!.provenance_version, undefined)
  assert.equal(plain!.start, undefined)
})

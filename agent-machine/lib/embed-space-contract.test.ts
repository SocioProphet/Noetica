// PR-3 drift-guard: Noetica's document-corpus embedder must land in the ONE sovereign
// vector space defined by the sourceos-spec EmbeddingRequest contract (PR #239), the
// same space prophet-platform apps/embeddings serves. If Noetica's model or dimension
// drifts from the pin, cross-corpus retrieval silently forks — this test fails loudly
// instead. It does NOT replace Noetica's embedder (bundled Ollama nomic-768 + Rust
// sidecar with dimension guards); it guards the space the doc corpus is indexed in.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { EMBED_MODEL, CORPUS_EMBED_DIM } from './ollama.js';

/** Strip // line and block comments so the source-scanning guards match CODE, not prose that happens
 *  to mention embedText/vecQuery (a comment naming a call must not trip — or defeat — a guard). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// The test suite is compiled to CommonJS in this repo, so __dirname is available;
// import.meta.url isn't accessible under that target (TS1470) — house pattern.
const HERE = __dirname;
const pin = JSON.parse(
  readFileSync(join(HERE, 'contracts/sourceos/embedding-space.pin.json'), 'utf8'),
) as { model: string; dimension: number; modelAliases?: string[] };

test('doc-corpus embedding model conforms to the sovereign EmbeddingRequest pin', () => {
  const accepted = new Set([pin.model, ...(pin.modelAliases ?? [])]);
  assert.ok(
    accepted.has(EMBED_MODEL),
    `Noetica EMBED_MODEL ${JSON.stringify(EMBED_MODEL)} is not the pinned sovereign model ` +
      `${JSON.stringify(pin.model)} (accepted aliases ${JSON.stringify(pin.modelAliases ?? [])}). ` +
      `If Noetica changed embedding models, its doc corpus has forked from the platform vector ` +
      `space — reindex the corpus into the pinned space, or update the pin if the contract changed.`,
  );
});

test('the corpus-ENFORCED dimension equals the sovereign pin', () => {
  // CORPUS_EMBED_DIM is the dims Noetica passes to embedText on the corpus/query paths,
  // so embedText's dimension contract forces a foreign-dim sidecar answer to fall through
  // to Ollama nomic-768. Asserting the *enforced* value (not a hard-coded assumption)
  // catches drift in the value that actually pins the runtime space.
  assert.equal(
    CORPUS_EMBED_DIM,
    pin.dimension,
    `Noetica CORPUS_EMBED_DIM ${CORPUS_EMBED_DIM} != pinned ${pin.dimension} — a truncated or ` +
      `foreign-dimension space is not comparable to prophet-platform apps/embeddings.`,
  );
});

test('doc-store enforces the pinned dimension on every corpus/query embed (no bare embedText)', () => {
  // The runtime space is only guaranteed if the corpus/query paths DECLARE dims — a bare
  // embedText(text) could take the Rust sidecar's (bge-384) answer and silently fork the
  // corpus. Guard against a regression that drops the dims argument on those paths.
  const docStore = stripComments(readFileSync(join(HERE, 'doc-store.ts'), 'utf8'));
  const corpusCalls = [...docStore.matchAll(/await embedText\(([^)]*)\)/g)].map((m) => m[1]);
  const offenders = corpusCalls.filter(
    (args) =>
      !/dims:\s*CORPUS_EMBED_DIM/.test(args) && // must pin the space
      !/dimension probe/.test(args), // the deliberate dimension-probe measures, so it is exempt
  );
  assert.deepEqual(
    offenders,
    [],
    `doc-store has embedText call(s) that don't pin the corpus dimension: ${JSON.stringify(offenders)} — ` +
      `pass { dims: CORPUS_EMBED_DIM } so the corpus can't silently fork to the sidecar's space.`,
  );
});

test('query paths embed in the pinned corpus space (no unpinned-reference / tier-by-text drift)', () => {
  // The dims-on-embedText guard above only sees DIRECT `await embedText(...)` calls. This outage
  // (CI retrieval "ungrounded", green locally) came from the two paths it CAN'T see, where the query
  // gets embedded in the embedder's NATIVE space (bge-384) instead of the pinned 768 corpus space:
  //   1) embedText passed BY REFERENCE as a search callback — e.g. hgSemanticSearch(q, k, embedText, …):
  //      the helper embeds the query with the bare fn, no dims → sidecar's 384 space.
  //   2) the ANN tier queried BY TEXT — vecQuery(col, { text: query }): the sidecar re-embeds the query
  //      in its own 384 space, but chunks were upserted at CORPUS_EMBED_DIM (768) → every cosine
  //      mismatches → zero hits. The tier must be queried by a pinned VECTOR, not text.
  const docStore = stripComments(readFileSync(join(HERE, 'doc-store.ts'), 'utf8'));

  const byReference = /hgSemanticSearch\([^)]*,\s*embedText\s*[,)]/.test(docStore);
  assert.ok(
    !byReference,
    'doc-store passes bare `embedText` as a search embedder (by reference) — the query would embed in ' +
      "the sidecar's native space and fork from the 768 corpus. Pass a dims-pinned wrapper " +
      '(q) => embedText(q, { dims: CORPUS_EMBED_DIM }) instead.',
  );

  const tierByText = /vecQuery\([^)]*\{\s*text:/.test(docStore);
  assert.ok(
    !tierByText,
    'doc-store queries the vector tier by { text } — the sidecar re-embeds in its native space while ' +
      'chunks are stored at CORPUS_EMBED_DIM, so every hit mismatches. Embed the query at ' +
      '{ dims: CORPUS_EMBED_DIM } and query by { vec }.',
  );
});

test('the pin itself is the sovereign nomic space (guards accidental pin edits)', () => {
  assert.equal(pin.model, 'nomic-ai/nomic-embed-text-v1.5');
  assert.equal(pin.dimension, 768);
});

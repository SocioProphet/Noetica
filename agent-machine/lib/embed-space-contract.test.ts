// PR-3 drift-guard: Noetica's document-corpus embedder must land in the ONE sovereign
// vector space defined by the sourceos-spec EmbeddingRequest contract (PR #239), the
// same space prophet-platform apps/embeddings serves. If Noetica's model or dimension
// drifts from the pin, cross-corpus retrieval silently forks — this test fails loudly
// instead. It does NOT replace Noetica's embedder (bundled Ollama nomic-768 + Rust
// sidecar with dimension guards); it guards the space the doc corpus is indexed in.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EMBED_MODEL } from './ollama.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const pin = JSON.parse(
  readFileSync(join(HERE, 'contracts/sourceos/embedding-space.pin.json'), 'utf8'),
) as { model: string; dimension: number; modelAliases?: string[] };

// The dimension Noetica embeds document chunks at. `nomic-embed-text` → 768-dim
// (lib/ollama.ts: "Embedding model for document/chunk vectors. nomic-embed-text → 768-dim").
const NOETICA_CORPUS_DIM = 768;

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

test('doc-corpus embedding dimension equals the sovereign pin (768)', () => {
  assert.equal(
    NOETICA_CORPUS_DIM,
    pin.dimension,
    `Noetica corpus dimension ${NOETICA_CORPUS_DIM} != pinned ${pin.dimension} — a truncated or ` +
      `foreign-dimension space is not comparable to prophet-platform apps/embeddings.`,
  );
});

test('the pin itself is the sovereign nomic space (guards accidental pin edits)', () => {
  assert.equal(pin.model, 'nomic-ai/nomic-embed-text-v1.5');
  assert.equal(pin.dimension, 768);
});

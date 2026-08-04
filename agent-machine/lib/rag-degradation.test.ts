import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ragDegradationMessage, RAG_DEGRADED_NOTICE } from './rag-degradation.js'

test('a retrieval error WITH documents present is a real degradation', () => {
  assert.equal(ragDegradationMessage(true, new Error('vector store down')), 'vector store down')
})

test('a non-Error throw still yields a generic degradation message', () => {
  assert.equal(ragDegradationMessage(true, 'boom'), 'document retrieval failed')
})

test('no documents present ⇒ nothing to degrade (no false "unavailable" on plain chat)', () => {
  assert.equal(ragDegradationMessage(false, new Error('vector store down')), null)
})

test('the user-facing notice is stable', () => {
  assert.match(RAG_DEGRADED_NOTICE, /without your documents/)
})

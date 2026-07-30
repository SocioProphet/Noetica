/**
 * The Claude-memory doc-id must never escape the `claude-memory/` namespace, even when the ingested file
 * is a confined-but-out-of-home path (/tmp, which realpaths to /private/tmp on macOS). See
 * claude-memory-id.ts for the traversal this closes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { claudeMemoryDocRel } from './claude-memory-id.js'

const home = '/Users/alice'

test('an out-of-home (tmp) realpath no longer yields a `..`-bearing id', () => {
  // This is exactly what `dir` under /private/tmp produced: path.relative(home, full) climbs out of home.
  const full = '/private/tmp/evil/memory/x.md'
  const rel = claudeMemoryDocRel(home, full)

  // The property that matters: no `..` segment survives, so `claude-memory/${rel}` stays in-namespace.
  assert.ok(!rel.split('/').includes('..'), `id still contains '..': ${rel}`)
  const id = `claude-memory/${rel}`
  assert.ok(!id.includes('../'), `namespace escape survived: ${id}`)
  // And it normalises to the informative in-namespace sub-path, not the raw `../../private/tmp/...`.
  assert.equal(rel, 'private/tmp/evil/memory/x.md')
  assert.notEqual(rel, path.relative(home, full)) // proves we changed the old behaviour
  assert.ok(path.relative(home, full).startsWith('..')) // ...and the old behaviour really did escape
})

test('a file genuinely under home is unchanged (no `..` to strip)', () => {
  const full = path.join(home, '.claude', 'projects', 'proj', 'memory', 'MEMORY.md')
  const rel = claudeMemoryDocRel(home, full)
  assert.equal(rel, '.claude/projects/proj/memory/MEMORY.md') // `.claude` is kept — only '.'/'..' are dropped
  assert.equal(rel, path.relative(home, full)) // identical to the old value for the in-home case
})

test('deep traversal and mixed `.`/`..` segments are all stripped', () => {
  assert.equal(claudeMemoryDocRel(home, '/etc/passwd'), 'etc/passwd')
  // path.relative() pre-collapses the internal `./` and `b/../` via resolve(); the leading `..` run it
  // then emits (climbing out of home) is what our filter strips — result is always `..`-free.
  assert.equal(claudeMemoryDocRel(home, '/private/tmp/a/./b/../c/note.md'), 'private/tmp/a/c/note.md')
})

test('degenerate case (full === home) falls back to the basename, never empty or `..`', () => {
  const rel = claudeMemoryDocRel(home, home)
  assert.equal(rel, 'alice')
  assert.ok(rel.length > 0 && !rel.includes('..'))
})

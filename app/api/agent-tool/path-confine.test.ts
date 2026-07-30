/**
 * Unit tests for the app-route copy of the confinement primitive.
 *
 * These run against SYNTHETIC roots (fresh temp dirs), never against $HOME — the predicate is
 * root-parameterised precisely so its properties can be asserted without moving HOME. The route-level
 * behaviour those properties buy is pinned separately in `route.test.ts`.
 *
 * Mirrors the assertions in `agent-machine/lib/path-confine.test.ts` (#584) for the single-root pair
 * this copy carries; see `path-confine.ts` for why the copy exists.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { isWithinRoot, realPathWithinRoot } from './path-confine'

const NO_SYMLINKS = process.platform === 'win32'

const realTmp = fs.realpathSync(os.tmpdir())
const scratch = fs.mkdtempSync(path.join(realTmp, 'app-path-confine-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

/** A fresh (root, outside) pair per test, so no test can be poisoned by another's links. */
function freshRoot(name: string): { root: string; outside: string } {
  const root = path.join(scratch, name, 'root')
  const outside = path.join(scratch, name, 'outside')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  return { root, outside }
}

test('isWithinRoot admits the root itself and strict descendants, nothing else', () => {
  assert.equal(isWithinRoot('/home/user', '/home/user'), true)
  assert.equal(isWithinRoot(path.join('/home/user', 'docs', 'a.txt'), '/home/user'), true)
  assert.equal(isWithinRoot('/home/other', '/home/user'), false)
  assert.equal(isWithinRoot('/home', '/home/user'), false)
  assert.equal(isWithinRoot('/etc/passwd', '/home/user'), false)
})

test('isWithinRoot REJECTS sibling-dir traversal (the missing path.sep bug)', () => {
  // `<root>-evil` passes an un-anchored startsWith(root). Asserted on SYNTHETIC roots on purpose:
  // deriving the hostile path from os.homedir() couples the test to where HOME happens to point.
  assert.equal(isWithinRoot('/home/user-evil/secrets', '/home/user'), false)
  assert.equal(isWithinRoot('/Users/alice-evil', '/Users/alice'), false)
})

test('realPathWithinRoot returns the REAL path of a file that exists inside the root', () => {
  const { root } = freshRoot('real-file')
  const f = path.join(root, 'notes.txt')
  fs.writeFileSync(f, 'legit')
  assert.equal(realPathWithinRoot(f, root), fs.realpathSync(f))
  assert.equal(realPathWithinRoot(root, root), fs.realpathSync(root))
})

test('realPathWithinRoot allows a NOT-YET-EXISTING path (the ENOENT trap)', () => {
  const { root } = freshRoot('enoent')
  // Requiring the full path to realpath() would break every legitimate create.
  assert.equal(realPathWithinRoot(path.join(root, 'new.txt'), root), path.join(fs.realpathSync(root), 'new.txt'))
  assert.equal(
    realPathWithinRoot(path.join(root, 'a', 'b', 'c.txt'), root),
    path.join(fs.realpathSync(root), 'a', 'b', 'c.txt'),
  )
})

test('realPathWithinRoot REFUSES a not-yet-existing file under a SYMLINKED PARENT', { skip: NO_SYMLINKS }, () => {
  const { root, outside } = freshRoot('symlinked-parent')
  fs.symlinkSync(outside, path.join(root, 'escape'))
  const implant = path.join(root, 'escape', 'implanted.txt')

  // The exact shape of the bug: lexically inside, does not exist, so an
  // `existsSync(full) ? realpath : lexical` hardening keeps the lexical value and the create escapes.
  assert.equal(fs.existsSync(implant), false)
  assert.equal(isWithinRoot(implant, root), true)
  assert.equal(realPathWithinRoot(implant, root), null)
})

test('realPathWithinRoot REFUSES a symlinked leaf pointing outside the root', { skip: NO_SYMLINKS }, () => {
  const { root, outside } = freshRoot('symlinked-leaf')
  const secret = path.join(outside, 'secret.txt')
  fs.writeFileSync(secret, 'top secret')
  fs.symlinkSync(secret, path.join(root, 'leaf'))
  assert.equal(realPathWithinRoot(path.join(root, 'leaf'), root), null)
})

test('realPathWithinRoot REFUSES a DANGLING symlink (target unverifiable)', { skip: NO_SYMLINKS }, () => {
  const { root, outside } = freshRoot('dangling')
  fs.symlinkSync(path.join(outside, 'never-created'), path.join(root, 'dangle'))
  assert.equal(realPathWithinRoot(path.join(root, 'dangle'), root), null)
  // ...and through a dangling directory link, too.
  fs.symlinkSync(path.join(outside, 'no-such-dir'), path.join(root, 'dangledir'))
  assert.equal(realPathWithinRoot(path.join(root, 'dangledir', 'x.txt'), root), null)
})

test('realPathWithinRoot REFUSES a lexical escape before touching the filesystem', () => {
  const { root } = freshRoot('lexical')
  assert.equal(realPathWithinRoot(path.resolve(root, '..', 'outside', 'x'), root), null)
  assert.equal(realPathWithinRoot('/etc/passwd', root), null)
})

test('realPathWithinRoot resolves the ROOT too, so a symlinked root is not a false refusal', { skip: NO_SYMLINKS }, () => {
  // `/tmp` → `/private/tmp` on macOS and `$TMPDIR` under `/var/folders`: comparing a realpath'd target
  // against an unresolved root would reject perfectly legitimate paths.
  const { root } = freshRoot('symlinked-root')
  const realDir = path.join(root, 'real')
  fs.mkdirSync(realDir)
  fs.writeFileSync(path.join(realDir, 'f.txt'), 'x')
  const linkedRoot = path.join(root, 'linked')
  fs.symlinkSync(realDir, linkedRoot)

  const viaLink = path.join(linkedRoot, 'f.txt')
  assert.equal(realPathWithinRoot(viaLink, linkedRoot), fs.realpathSync(viaLink))
  assert.ok(realPathWithinRoot(path.join(linkedRoot, 'not-yet.txt'), linkedRoot))
})

test('realPathWithinRoot allows a symlink that stays INSIDE the root, resolved to its real target', { skip: NO_SYMLINKS }, () => {
  const { root } = freshRoot('inner-link')
  const realDir = path.join(root, 'real-dir')
  fs.mkdirSync(realDir)
  fs.symlinkSync(realDir, path.join(root, 'inner'))
  assert.equal(
    realPathWithinRoot(path.join(root, 'inner', 'new.txt'), root),
    path.join(fs.realpathSync(realDir), 'new.txt'),
  )
})

test('realPathWithinRoot REFUSES a component it cannot RESOLVE, instead of assuming it is absent', {
  // Permission bits do not bind uid 0, so under root the fixture is not hostile and this would pass
  // while proving nothing. Declare that rather than run a decorative assertion.
  skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'needs a non-root POSIX uid' : false,
}, () => {
  const { root } = freshRoot('eacces')
  const opaque = path.join(root, 'opaque')
  fs.mkdirSync(opaque)
  fs.writeFileSync(path.join(opaque, 'inner.txt'), 'x')
  const target = path.join(opaque, 'inner.txt')
  fs.chmodSync(opaque, 0o000)
  try {
    // The fixture must genuinely be unresolvable, or the assertion below is vacuous.
    assert.throws(
      () => fs.realpathSync(target),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'EACCES',
      'the fixture must actually be unreadable',
    )
    // Walking up on EACCES would realpath the parent, re-attach `inner.txt` and hand back a path
    // that was never validated. "I could not look" is not "it is not there".
    assert.equal(realPathWithinRoot(target, root), null)
  } finally {
    fs.chmodSync(opaque, 0o700)
  }
})

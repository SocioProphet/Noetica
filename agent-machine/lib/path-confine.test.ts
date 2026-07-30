/** Tests for the file-path confinement predicate — esp. the sibling-dir traversal it must reject. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as os from 'node:os'
import * as path from 'node:path'
import { isConfinedToHomeOrTmp, isWithinRoot, confinementRoots } from './path-confine.js'

const home = path.resolve(os.homedir())

test('allows the home dir and files strictly inside it', () => {
  assert.equal(isConfinedToHomeOrTmp(home), true)
  assert.equal(isConfinedToHomeOrTmp(path.join(home, 'docs', 'a.txt')), true)
})

test('allows /tmp and the OS tmpdir', () => {
  assert.equal(isConfinedToHomeOrTmp('/tmp'), true)
  assert.equal(isConfinedToHomeOrTmp('/tmp/x'), true)
  assert.equal(isConfinedToHomeOrTmp(path.join(path.resolve(os.tmpdir()), 'y')), true)
})

test('REJECTS sibling-dir traversal (the missing path.sep bug)', () => {
  // `<root>-evil` and `/tmpfoo` used to pass the un-anchored startsWith(root).
  //
  // Asserted on SYNTHETIC roots on purpose. Deriving the hostile path from os.homedir() — the way this
  // test used to — silently couples it to where HOME points: under a sandbox HOME like /tmp/sandbox,
  // `<home>-evil` lands inside the /tmp root, is legitimately confined, and the assertion fails against
  // a predicate that is behaving exactly as specified.
  assert.equal(isWithinRoot('/home/user-evil/secrets', '/home/user'), false)
  assert.equal(isWithinRoot('/Users/alice-evil', '/Users/alice'), false)
  assert.equal(isWithinRoot('/tmpfoo/passwd', '/tmp'), false)
  assert.equal(isWithinRoot('/private/tmpfoo', '/private/tmp'), false)
})

test('isWithinRoot admits the root itself and strict descendants, nothing else', () => {
  assert.equal(isWithinRoot('/home/user', '/home/user'), true)
  assert.equal(isWithinRoot(path.join('/home/user', 'docs', 'a.txt'), '/home/user'), true)
  assert.equal(isWithinRoot('/home/other', '/home/user'), false)
  assert.equal(isWithinRoot('/home', '/home/user'), false)
  assert.equal(isWithinRoot('/etc/passwd', '/home/user'), false)
})

test('the roots are a UNION that may nest — a home sibling inside another root stays confined', () => {
  // Pins the contract that made the old assertion environment-dependent, so the next reader does not
  // "fix" the predicate to reject a path that is genuinely inside an allowed root.
  assert.equal(isWithinRoot('/tmp/sandbox-evil/secrets', '/tmp/sandbox'), false)
  assert.equal(isWithinRoot('/tmp/sandbox-evil/secrets', '/tmp'), true)
})

test('the real roots include home and the tmp dirs', () => {
  const roots = confinementRoots()
  assert.ok(roots.includes(home))
  assert.ok(roots.includes('/tmp'))
  assert.ok(roots.includes(path.resolve(os.tmpdir())))
})

test('rejects an unrelated absolute path', () => {
  assert.equal(isConfinedToHomeOrTmp('/etc/passwd'), false)
})

// TEMPORARY — CI gate proof. This asserts something false on purpose to demonstrate that the
// required "agent-machine build and test" check actually executes lib/path-confine.test.ts and
// goes red on a failing assertion. Reverted in the next commit.
test('CI-GATE-PROOF deliberate failure — must be reverted', () => {
  assert.equal(isWithinRoot('/home/user/inside', '/home/user'), false)
})

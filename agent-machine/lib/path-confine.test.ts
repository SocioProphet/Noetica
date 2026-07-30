/** Tests for the file-path confinement predicate — esp. the sibling-dir traversal it must reject. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  isConfinedToHomeOrTmp,
  isWithinRoot,
  confinementRoots,
  confinedRealPath,
  realPathWithinRoot,
} from './path-confine.js'

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

// ─────────────────────────────────────────────────────────────────────────────
// Symlink escape — the hole the LEXICAL predicate above cannot close.
//
// A link INSIDE an allowed root that points OUTSIDE it satisfies every lexical check, so
// `HOME=/tmp/symhome; ln -s /etc /tmp/symhome/escape` made `~/escape/passwd` an arbitrary read
// through the model-driven read_file/write_file tools and the CORS-open ingest routes.
//
// These run under a SANDBOX HOME. Ground truth for "the real home" is `os.userInfo().homedir`,
// which reads the passwd database and ignores $HOME — so a test that moves HOME cannot fake a pass.
// ─────────────────────────────────────────────────────────────────────────────

const NO_SYMLINKS = process.platform === 'win32' // creating links needs privilege there

/** Run `fn` with HOME pointed at a fresh sandbox dir, restoring the real HOME afterwards. */
function withSandboxHome(fn: (sandbox: string) => void): void {
  const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'path-confine-'))
  const priorHome = process.env['HOME']
  process.env['HOME'] = sandbox
  try {
    // The sandbox must actually be the confinement root, or these assertions prove nothing.
    assert.equal(path.resolve(os.homedir()), sandbox)
    fn(sandbox)
  } finally {
    if (priorHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = priorHome
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
}

test('confinedRealPath REFUSES a symlink inside the root that points outside it', { skip: NO_SYMLINKS }, () => {
  withSandboxHome((sandbox) => {
    fs.symlinkSync('/etc', path.join(sandbox, 'escape'))
    fs.symlinkSync('/etc/passwd', path.join(sandbox, 'leaf'))

    const viaParent = path.join(sandbox, 'escape', 'passwd')
    const viaLeaf = path.join(sandbox, 'leaf')

    // The lexical predicate still says yes — that is precisely the hole, and it must stay visible
    // here so nobody "simplifies" the call sites back to it.
    assert.equal(isConfinedToHomeOrTmp(viaParent), true)
    assert.equal(isConfinedToHomeOrTmp(viaLeaf), true)

    assert.equal(confinedRealPath(viaParent), null)
    assert.equal(confinedRealPath(viaLeaf), null)
  })
})

test('confinedRealPath allows a real file inside the root, returning its REAL path', { skip: NO_SYMLINKS }, () => {
  withSandboxHome((sandbox) => {
    const f = path.join(sandbox, 'notes.txt')
    fs.writeFileSync(f, 'legit')
    assert.equal(confinedRealPath(f), fs.realpathSync(f))
    assert.equal(confinedRealPath(sandbox), fs.realpathSync(sandbox))
  })
})

test('confinedRealPath allows a NOT-YET-EXISTING file whose parent exists (the ENOENT trap)', { skip: NO_SYMLINKS }, () => {
  withSandboxHome((sandbox) => {
    // write_file / edit_file CREATE files. realpath()ing the full path throws ENOENT, so the fix
    // resolves the nearest EXISTING ancestor instead. Break this and every legitimate write breaks.
    const fresh = path.join(sandbox, 'brand-new.txt')
    assert.equal(confinedRealPath(fresh), path.join(fs.realpathSync(sandbox), 'brand-new.txt'))

    // ...and several missing segments deep, which is what mkdirSync({recursive}) then creates.
    const deep = path.join(sandbox, 'a', 'b', 'c.txt')
    assert.equal(confinedRealPath(deep), path.join(fs.realpathSync(sandbox), 'a', 'b', 'c.txt'))

    // The returned path must be writable for real — this is the regression that would be reverted.
    const target = confinedRealPath(deep)
    assert.ok(target)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'created')
    assert.equal(fs.readFileSync(target, 'utf8'), 'created')
  })
})

test('confinedRealPath REFUSES a new file under a SYMLINKED PARENT directory', { skip: NO_SYMLINKS }, () => {
  withSandboxHome((sandbox) => {
    fs.symlinkSync('/etc', path.join(sandbox, 'escape'))
    const implant = path.join(sandbox, 'escape', 'implanted.txt')

    // An `existsSync(full) ? realpath(full) : lexical` hardening MISSES this: the full path does not
    // exist, so it keeps the lexical value and the create lands in /etc. Resolving the nearest
    // existing ancestor is what catches it.
    assert.equal(fs.existsSync(implant), false)
    assert.equal(isConfinedToHomeOrTmp(implant), true)
    assert.equal(confinedRealPath(implant), null)
  })
})

test('confinedRealPath REFUSES a dangling symlink (target unverifiable)', { skip: NO_SYMLINKS }, () => {
  withSandboxHome((sandbox) => {
    fs.symlinkSync('/etc/no-such-file-here', path.join(sandbox, 'dangle'))
    // It lstat()s but does not realpath(), and a create through it lands at the link target.
    assert.equal(confinedRealPath(path.join(sandbox, 'dangle')), null)
  })
})

test('moving HOME cannot reach the REAL home — ground truth is os.userInfo().homedir', { skip: NO_SYMLINKS }, () => {
  const realHome = os.userInfo().homedir // reads the passwd db; $HOME cannot forge it
  withSandboxHome((sandbox) => {
    assert.notEqual(path.resolve(realHome), sandbox) // the sandbox really is somewhere else
    fs.symlinkSync(realHome, path.join(sandbox, 'realhome'))
    assert.equal(confinedRealPath(path.join(sandbox, 'realhome', '.ssh', 'id_rsa')), null)
  })
})

test('realPathWithinRoot confines an arbitrary root (the /api/workspace/read case)', { skip: NO_SYMLINKS }, () => {
  withSandboxHome((sandbox) => {
    const base = path.join(sandbox, '.noetica', 'workspaces', 'ws')
    fs.mkdirSync(base, { recursive: true })
    fs.writeFileSync(path.join(base, 'ok.txt'), 'inside')
    fs.symlinkSync('/etc/passwd', path.join(base, 'out'))
    fs.symlinkSync('/etc', path.join(base, 'outdir'))

    // Allowed: a real file inside, and a path not created yet.
    assert.equal(realPathWithinRoot(path.join(base, 'ok.txt'), base), fs.realpathSync(path.join(base, 'ok.txt')))
    assert.ok(realPathWithinRoot(path.join(base, 'not-yet.txt'), base))

    // Refused: lexical escape, symlinked leaf, symlinked parent dir.
    assert.equal(realPathWithinRoot(path.resolve(base, '..', '..', 'secret'), base), null)
    assert.equal(realPathWithinRoot(path.join(base, 'out'), base), null)
    assert.equal(realPathWithinRoot(path.join(base, 'outdir', 'passwd'), base), null)
  })
})

test('realPathWithinRoot resolves the ROOT too, so a symlinked root is not a false refusal', { skip: NO_SYMLINKS }, () => {
  withSandboxHome((sandbox) => {
    // `/tmp` → `/private/tmp` on macOS and `$TMPDIR` → `/private/var/folders/...`: comparing a
    // realpath'd target against an unresolved root would reject perfectly legitimate paths.
    const realDir = path.join(sandbox, 'real')
    fs.mkdirSync(realDir)
    fs.writeFileSync(path.join(realDir, 'f.txt'), 'x')
    const linkedRoot = path.join(sandbox, 'linked')
    fs.symlinkSync(realDir, linkedRoot)

    const viaLink = path.join(linkedRoot, 'f.txt')
    assert.equal(realPathWithinRoot(viaLink, linkedRoot), fs.realpathSync(viaLink))
    assert.ok(confinedRealPath(viaLink))
  })
})

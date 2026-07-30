/**
 * Regression tests for the agent-tool route's path confinement, exercised through the REAL handler.
 *
 * The defect these pin: `resolvePath` ran the lexical `path.relative` barrier and then re-validated
 * with `fs.realpathSync` only `if (fs.existsSync(resolved))`. A path that does not exist YET kept the
 * lexical value, so a symlinked PARENT directory escaped: with `~/escape` → somewhere outside the home
 * tree, `write_file` to `~/escape/new.txt` had a nonexistent full path, `existsSync` was false, and
 * `fs.writeFileSync` followed the link and wrote outside the root. Reads of EXISTING files were caught
 * (realpath ran); this was specifically the CREATE path.
 *
 * These assert through POST() rather than against the helper, because the helper being correct is not
 * the claim — the claim is that nothing lands outside the root.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Creating symlinks needs privilege on Windows.
const NO_SYMLINKS = process.platform === 'win32'

// Ground truth for the REAL home is `os.userInfo().homedir` — it reads the passwd database and ignores
// $HOME, so a test that moves HOME cannot fake a pass by pointing at itself.
const REAL_HOME = path.resolve(os.userInfo().homedir)

// `route.ts` captures `ROOT = fs.realpathSync(os.homedir())` at MODULE LOAD, so HOME must point at the
// sandbox BEFORE the module is imported — hence the deferred dynamic import below rather than a static
// one. Mutating HOME is contained: `node --test` gives every test FILE its own process, so this cannot
// leak into another suite (and no test here writes anywhere near the real home tree).
const realTmp = fs.realpathSync(os.tmpdir())
const sandboxHome = fs.mkdtempSync(path.join(realTmp, 'agent-tool-home-'))
// A WRITABLE directory outside the root. Deliberately not `/etc`: an unwritable escape target makes
// "nothing landed outside" pass on permissions alone, so the test would stay green against the bug.
const outside = fs.mkdtempSync(path.join(realTmp, 'agent-tool-outside-'))

const priorHome = process.env['HOME']
process.env['HOME'] = sandboxHome
assert.equal(path.resolve(os.homedir()), sandboxHome, 'sandbox HOME did not take effect')
assert.notEqual(sandboxHome, REAL_HOME, 'sandbox must not be the real home')
assert.equal(path.relative(sandboxHome, outside).startsWith('..'), true, 'escape target must be outside')

// Imported lazily rather than at the top level: tsx compiles these `.ts` files as CJS (the root package
// is not `"type": "module"`), so a top-level await will not transform. The import must still happen
// AFTER the HOME assignment above, which it does — nothing calls this until the first test body runs.
let routeModule: typeof import('./route') | null = null
async function loadRoute(): Promise<typeof import('./route')> {
  if (routeModule === null) routeModule = await import('./route')
  return routeModule
}

after(() => {
  if (priorHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = priorHome
  // rmSync unlinks symlinks rather than following them, so this cannot reach through `escape`.
  fs.rmSync(sandboxHome, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

async function callTool(
  tool: string,
  input: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, string> }> {
  const { POST } = await loadRoute()
  const res = await POST(
    new Request('http://localhost/api/agent-tool', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool, input }),
    }),
  )
  return { status: res.status, body: (await res.json()) as Record<string, string> }
}

// ─── 1. the hole: a new file under a symlinked parent ────────────────────────

test('write_file REFUSES a new file under a SYMLINKED PARENT, and nothing lands outside the root', {
  skip: NO_SYMLINKS,
}, async () => {
  fs.symlinkSync(outside, path.join(sandboxHome, 'escape'))
  const escapeTarget = path.join(outside, 'PROOF.txt')

  // The precondition that made the old code fail open: the FULL path does not exist, so `existsSync`
  // was false and the realpath re-check never ran.
  assert.equal(fs.existsSync(path.join(sandboxHome, 'escape', 'PROOF.txt')), false)

  const { status, body } = await callTool('write_file', {
    path: '~/escape/PROOF.txt',
    content: 'implanted',
  })

  // Assert the ABSENCE first. The return value is not the security property, and ordering matters for
  // more than style: with the fix reverted the call returns 200, so a status-first assertion aborts
  // before proving anything about the filesystem. This ordering makes the red run say "a file was
  // implanted outside the root", which is the actual claim.
  assert.equal(fs.existsSync(escapeTarget), false, 'a file was implanted OUTSIDE the root')
  assert.deepEqual(fs.readdirSync(outside), [], 'something landed OUTSIDE the root')

  assert.equal(status, 500)
  assert.match(body['error'] ?? '', /escapes the permitted root/)
})

test('write_file REFUSES the same escape spelled as an absolute path', { skip: NO_SYMLINKS }, async () => {
  // `~/` expansion is not the barrier; the absolute spelling must be refused identically.
  const { status, body } = await callTool('write_file', {
    path: path.join(sandboxHome, 'escape', 'ABS.txt'),
    content: 'implanted',
  })
  assert.equal(fs.existsSync(path.join(outside, 'ABS.txt')), false, 'implanted OUTSIDE the root')
  assert.equal(status, 500)
  assert.match(body['error'] ?? '', /escapes the permitted root/)
})

test('write_file REFUSES a new file SEVERAL segments below a symlinked parent', { skip: NO_SYMLINKS }, async () => {
  // mkdirSync({recursive:true}) would have created the whole chain inside the escape target.
  const { status } = await callTool('write_file', { path: '~/escape/x/y/DEEP.txt', content: 'implanted' })
  assert.equal(fs.existsSync(path.join(outside, 'x')), false, 'a directory tree was created OUTSIDE the root')
  assert.deepEqual(fs.readdirSync(outside), [], 'something landed OUTSIDE the root')
  assert.equal(status, 500)
})

// ─── 2. the ENOENT trap: creating under a REAL parent must still work ────────

test('write_file still CREATES a new file whose parent exists', async () => {
  const { status, body } = await callTool('write_file', { path: '~/brand-new.txt', content: 'created' })
  assert.equal(status, 200)
  const landed = path.join(sandboxHome, 'brand-new.txt')
  assert.equal(body['result'], `Written: ${landed}`)
  assert.equal(fs.readFileSync(landed, 'utf8'), 'created')
})

test('write_file still CREATES several nonexistent segments deep', async () => {
  // The realpath-the-nearest-existing-ancestor walk has to climb four levels here. A hardening that
  // demanded the full path resolve would break every legitimate write; this is what that looks like.
  const { status, body } = await callTool('write_file', {
    path: '~/a/b/c/d/notes.txt',
    content: 'deep create',
  })
  assert.equal(status, 200)
  const landed = path.join(sandboxHome, 'a', 'b', 'c', 'd', 'notes.txt')
  assert.equal(body['result'], `Written: ${landed}`)
  assert.equal(fs.readFileSync(landed, 'utf8'), 'deep create')
})

test('write_file still CREATES through a symlinked directory that stays INSIDE the root', { skip: NO_SYMLINKS }, async () => {
  // Not every symlink is an escape. A link inside the root pointing inside the root is legitimate, and
  // the write must land at the link's REAL target.
  const realDir = path.join(sandboxHome, 'real-dir')
  fs.mkdirSync(realDir)
  fs.symlinkSync(realDir, path.join(sandboxHome, 'inner-link'))

  const { status } = await callTool('write_file', { path: '~/inner-link/via-link.txt', content: 'ok' })
  assert.equal(status, 200)
  assert.equal(fs.readFileSync(path.join(realDir, 'via-link.txt'), 'utf8'), 'ok')
})

// ─── 3. reads inside the root are untouched ──────────────────────────────────

test('read_file still reads an existing file inside the root', async () => {
  fs.writeFileSync(path.join(sandboxHome, 'inside.txt'), 'legit contents')
  const { status, body } = await callTool('read_file', { path: '~/inside.txt' })
  assert.equal(status, 200)
  assert.equal(body['result'], 'legit contents')
})

test('list_directory still lists a real directory inside the root', async () => {
  const dir = path.join(sandboxHome, 'listable')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'entry.txt'), 'x')
  const { status, body } = await callTool('list_directory', { path: '~/listable' })
  assert.equal(status, 200)
  assert.match(body['result'] ?? '', /entry\.txt/)
})

// ─── regressions the OLD code already caught — keep them caught ──────────────

test('read_file still REFUSES a symlinked leaf pointing outside the root', { skip: NO_SYMLINKS }, async () => {
  const secret = path.join(outside, 'secret.txt')
  fs.writeFileSync(secret, 'top secret')
  fs.symlinkSync(secret, path.join(sandboxHome, 'leaf'))
  try {
    const { status, body } = await callTool('read_file', { path: '~/leaf' })
    assert.equal(status, 500)
    assert.match(body['error'] ?? '', /escapes the permitted root/)
    assert.notEqual(body['result'], 'top secret')
  } finally {
    fs.rmSync(path.join(sandboxHome, 'leaf'), { force: true })
    fs.rmSync(secret, { force: true })
  }
})

test('read_file still REFUSES a lexical `..` escape', async () => {
  const { status, body } = await callTool('read_file', { path: path.join(sandboxHome, '..', 'elsewhere.txt') })
  assert.equal(status, 500)
  assert.match(body['error'] ?? '', /escapes the permitted root/)
})

test('list_directory REFUSES a symlinked directory pointing outside the root', { skip: NO_SYMLINKS }, async () => {
  const { status, body } = await callTool('list_directory', { path: '~/escape' })
  assert.equal(status, 500)
  assert.match(body['error'] ?? '', /escapes the permitted root/)
})

// ─── dangling symlinks: the create target is unprovable ──────────────────────

test('write_file REFUSES a DANGLING symlink — the create target cannot be proven', { skip: NO_SYMLINKS }, async () => {
  // It lstat()s but does not realpath(), so where a create through it would land is unknowable from
  // the path alone; the kernel would follow it to the (outside) target.
  const dangleTarget = path.join(outside, 'not-there-yet.txt')
  fs.symlinkSync(dangleTarget, path.join(sandboxHome, 'dangle'))

  const { status, body } = await callTool('write_file', { path: '~/dangle', content: 'implanted' })
  assert.equal(fs.existsSync(dangleTarget), false, 'a write followed a dangling symlink OUT of the root')
  assert.equal(status, 500)
  assert.match(body['error'] ?? '', /escapes the permitted root/)
})

// ─── the sandbox cannot be used to reach the real home ───────────────────────

test('moving HOME cannot reach the REAL home — ground truth is os.userInfo().homedir', { skip: NO_SYMLINKS }, async () => {
  fs.symlinkSync(REAL_HOME, path.join(sandboxHome, 'realhome'))
  // Probing a name that cannot exist rather than a real secret: the point is that the confinement
  // REFUSES (500) instead of dereferencing into the real home (404 = "followed the link, found
  // nothing"), and a reverted run must never actually open an operator's file to make that point.
  const { status, body } = await callTool('read_file', {
    path: '~/realhome/.ssh/noetica-confinement-probe-nonexistent',
  })
  assert.equal(status, 500)
  assert.match(body['error'] ?? '', /escapes the permitted root/)
})

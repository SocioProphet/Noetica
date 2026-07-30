import { NextResponse } from 'next/server'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { realPathWithinRoot } from './path-confine'

export const runtime = 'nodejs'

// This route is reachable over local HTTP with an untrusted body, so a user-
// supplied absolute path or `..` escape would otherwise let it read/write ANY
// file on the machine (js/path-injection). Confine every tool path to the
// user's home tree and reject anything that resolves outside it.
const ROOT = fs.realpathSync(os.homedir())

function resolvePath(p: string): string {
  if (!p) return ''
  const requested = p.startsWith('~/') ? path.join(ROOT, p.slice(2)) : p
  const resolved = path.resolve(ROOT, requested)
  // Lexical containment barrier FIRST — before ANY filesystem access — so nothing
  // touches an unvalidated user path. A `path.relative(...)` that starts with '..'
  // (or is absolute) is the containment barrier CodeQL recognizes for js/path-injection.
  const rel = path.relative(ROOT, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('path escapes the permitted root')
  }
  // `resolved` is now LEXICALLY confined to ROOT, which is not the same as actually confined: a
  // symlink inside ROOT that points outside it satisfies every lexical check.
  //
  // This used to read `if (fs.existsSync(resolved)) { ...realpath... }` and otherwise keep the lexical
  // value. That guarded reads of EXISTING files and left the CREATE path wide open: with `~/escape`
  // symlinked to somewhere outside the home tree, `write_file` to `~/escape/new.txt` has a full path
  // that does not exist, so `existsSync` was false, the lexical value survived, and `writeFileSync`
  // followed the symlinked PARENT and wrote outside ROOT.
  //
  // `realPathWithinRoot` resolves the nearest EXISTING ancestor instead of requiring the whole path to
  // exist, so the symlinked parent is caught while a genuine create still resolves. It is a verbatim
  // mirror of `agent-machine/lib/path-confine.ts` (#584) — see that file's header for the duplication
  // rationale and the drift risk.
  const real = realPathWithinRoot(resolved, ROOT)
  if (real === null) {
    throw new Error('path escapes the permitted root')
  }
  return real
}

export async function POST(request: Request) {
  const body = (await request.json()) as { tool?: string; input?: Record<string, unknown> }
  const { tool, input = {} } = body

  try {
    if (tool === 'read_file') {
      const filePath = resolvePath((input.path as string | undefined) ?? '')
      if (!filePath) return NextResponse.json({ error: 'path is required' }, { status: 400 })
      // Single fd for stat + read so there is no check-then-use race (js/file-system-race).
      let fd: number
      try {
        fd = fs.openSync(filePath, 'r')
      } catch {
        return NextResponse.json({ error: `File not found: ${filePath}` }, { status: 404 })
      }
      try {
        const stat = fs.fstatSync(fd)
        if (stat.size > 2 * 1024 * 1024) return NextResponse.json({ error: `File too large (${stat.size} bytes). Max 2 MB.` }, { status: 413 })
        const content = fs.readFileSync(fd, 'utf-8')
        return NextResponse.json({ result: content })
      } finally {
        fs.closeSync(fd)
      }
    }

    if (tool === 'write_file') {
      const filePath = resolvePath((input.path as string | undefined) ?? '')
      const content = (input.content as string | undefined) ?? ''
      if (!filePath) return NextResponse.json({ error: 'path is required' }, { status: 400 })
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, content, 'utf-8')
      return NextResponse.json({ result: `Written: ${filePath}` })
    }

    if (tool === 'list_directory') {
      const dirPath = resolvePath((input.path as string | undefined) ?? '')
      if (!dirPath) return NextResponse.json({ error: 'path is required' }, { status: 400 })
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        return NextResponse.json({ error: `Not a directory: ${dirPath}` }, { status: 404 })
      }
      const entries = fs.readdirSync(dirPath).map((name) => {
        const full = path.join(dirPath, name)
        const stat = fs.statSync(full)
        return stat.isDirectory() ? `d  ${name}/` : `f  ${name}  (${stat.size} bytes)`
      })
      return NextResponse.json({ result: entries.length ? entries.join('\n') : '(empty directory)' })
    }

    return NextResponse.json({ error: `Unknown tool: ${tool}` }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

/**
 * store-path-guard — the shared detector for a data-destructive test hazard.
 *
 * THE SHAPE. A `~/.noetica` path frozen into a module-load constant:
 *
 *     const STORE = path.join(os.homedir(), '.noetica', 'a2a-trust.json')   // ← evaluated at IMPORT
 *
 * plus a write call, plus reachability from `lib/*.test.ts`. `npm test` then writes the OPERATOR'S REAL
 * STATE. This is not theoretical: a full suite run on 2026-07-29 rewrote six real stores —
 * collections.json, open-chats.json, privacy-policy.json, routing-decisions.jsonl, exhaust.jsonl,
 * exhaust-needs.jsonl — and on the A2A federation ledger it was worse than lossy. A wiped record falls
 * back to `fresh()` at score 0.64, above TRUST_FLOOR 0.45, so running the tests SILENTLY RESTORED
 * AUTHORITY TO REVOKED PEERS. The defect appeared eighteen times in one directory.
 *
 * WHY A MODULE-SCOPE `const` IS THE BUG, even with an env override. `scope-d.ts` already read
 * `process.env['SCOPED_EVENTS'] ?? …` — at import. An override read once at import cannot be set by a
 * test, because a test's `before()` hook runs AFTER the module graph has loaded. Same trap with HOME:
 * `open-chat-index.test.ts` set `process.env.HOME` in `before()` and the redirect silently missed,
 * while `agent-registry.test.ts` did the identical thing and worked — only because `agent-registry.ts`
 * happens to wrap its path in an arrow function. The two test files look the same. The difference is in
 * the module. That is why sandboxing HOME is not a fix and this guard does not accept one.
 *
 * THE FIX SHAPE (PR #581's `_storePath()`): resolve on every access, with a per-module env override.
 *
 *     export function _storePath(): string {
 *       return process.env['NOETICA_X_STORE'] || path.join(os.homedir(), '.noetica', 'x.json')
 *     }
 *
 * GROUND TRUTH IS `os.userInfo().homedir`, NOT `os.homedir()`. os.homedir() honours $HOME, so a test
 * that moves HOME could "pass" while still aimed at the real file. userInfo() reads the passwd database
 * and ignores $HOME — it cannot be talked out of the truth.
 *
 * This module is pure: it reads source text and returns findings. It never writes.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** The operator's REAL sovereign data dir, from the passwd database — immune to a moved $HOME.
 *  NOTE: this is itself an eager module-scope `.noetica` binding, so `scanBindings()` MATCHES THIS FILE.
 *  That is deliberate — it keeps the scanner's self-exclusion load-bearing instead of decorative, and
 *  `store-path-guard.test.ts` asserts the match still happens so the exclusion cannot rot into a no-op. */
export const REAL_NOETICA_DIR = path.join(os.userInfo().homedir, '.noetica')

/** True when `p` resolves inside the operator's real ~/.noetica. Containment, not string-prefix. */
export function isInsideRealNoetica(p: string): boolean {
  const rel = path.relative(REAL_NOETICA_DIR, path.resolve(p))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** A homedir lookup in any of the forms used across lib/. */
const HOME_CALL = /(?:\bos\s*\.\s*homedir\s*\(\s*\))|(?:\bhomedir\s*\(\s*\))|(?:userInfo\s*\(\s*\)\s*\.\s*homedir)/
/** A literal '.noetica' path segment. */
const NOETICA_LIT = /['"`]\.noetica['"`]/
/** Anything that mutates the filesystem. Deliberately broad — a false positive costs a lazy accessor,
 *  a false negative costs the operator's data. */
const WRITE_CALL =
  /\bwriteFileSync\b|\bappendFileSync\b|\bcreateWriteStream\b|\bwriteJson\b|\bappendJsonl\b|\bmkdirSync\b|\brmSync\b|\bunlinkSync\b|\brenameSync\b|\bcopyFileSync\b|\brmdirSync\b|\.writeFile\s*\(|\.appendFile\s*\(|\bwriteFile\s*\(/

/** A module-scope declaration whose right-hand side is evaluated AT IMPORT (not wrapped in a function). */
const DECL = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+?)?=\s*(.+)$/
const LAZY_RHS = /^\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+?)?=>|[A-Za-z_$][\w$]*\s*=>)/

export interface Binding { file: string; line: number; name: string; text: string }

/**
 * Does this ONE line bind a `~/.noetica` path to an eagerly-evaluated module-scope constant?
 * Exported so the test can sanity-check the detector against known positives AND known negatives
 * before trusting a zero — a mangled regex silently returns "no hazards found", which is exactly the
 * false-negative that let this class survive.
 */
export function isEagerHomeBinding(line: string): boolean {
  if (/^\s/.test(line)) return false                       // module top level only
  if (!NOETICA_LIT.test(line) || !HOME_CALL.test(line)) return false
  const m = DECL.exec(line)
  if (!m) return false
  return !LAZY_RHS.test(m[2] as string)
}

/** Every eager module-scope `~/.noetica` binding in `libDir`. Includes THIS FILE — callers exclude it. */
export function scanBindings(libDir: string): Binding[] {
  const st = fs.statSync(libDir)
  if (!st.isDirectory()) throw new Error(`scanBindings expects a DIRECTORY, got: ${libDir}`)
  const out: Binding[] = []
  for (const file of fs.readdirSync(libDir).filter((f) => f.endsWith('.ts')).sort()) {
    const src = fs.readFileSync(path.join(libDir, file), 'utf8')
    src.split('\n').forEach((line, i) => {
      const m = DECL.exec(line)
      if (isEagerHomeBinding(line)) out.push({ file, line: i + 1, name: (m?.[1] ?? '?'), text: line.trim() })
    })
  }
  return out
}

/** Files in `libDir` that contain at least one filesystem-mutating call. */
export function writingFiles(libDir: string): Set<string> {
  const out = new Set<string>()
  for (const file of fs.readdirSync(libDir).filter((f) => f.endsWith('.ts'))) {
    if (WRITE_CALL.test(fs.readFileSync(path.join(libDir, file), 'utf8'))) out.add(file)
  }
  return out
}

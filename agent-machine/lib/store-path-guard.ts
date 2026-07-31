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
import * as ts from 'typescript'

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
/** A per-module env override used AS THE FALLBACK for the path — the seam's escape hatch
 *  (`process.env['NOETICA_X'] || …` / `process.env.NOETICA_HOME ?? …`). Its PRESENCE on a lazy home
 *  binding is what makes it safe: the sandbox preload sets that var and a late-resolving reader picks it
 *  up. Its ABSENCE on an otherwise-lazy raw-homedir binding is the hazard the lazy tooth (below) adds.
 *
 *  This requires the env read to be used AS A VALUE (assigned, returned, or `||`/`??`-fallen-back to the
 *  path) — NOT a flag COMPARISON. A resolver that touches `process.env` for an unrelated reason
 *  (`process.env.SANDBOX_EXEC === '0'`, a feature flag) while still resolving its path from raw
 *  `homedir()` is NOT redirectable by the preload, and the old `/process\.env\b/` waved it through; but a
 *  resolver that does `const dir = process.env.NOETICA_X; if (dir) return dir; return join(homedir()…)`
 *  IS redirectable even though the override is not on the same `||` line. The discriminator is therefore
 *  "env read not immediately compared to a literal". The var name is intentionally unconstrained (not
 *  `NOETICA_*`-only) — `scope-d.ts` legitimately overrides with `SCOPED_EVENTS`. */
const ENV_OVERRIDE = /process\s*\.\s*env\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*['"`][^'"`]+['"`]\s*\])(?!\s*[!=]==?)/

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

/**
 * The blind spot `isEagerHomeBinding` deliberately leaves: a module-scope LAZY resolver (arrow or
 * `function`) that reads a RAW home call for a `~/.noetica` path and carries NO env override.
 *
 * WHY LATE-RESOLVING IS NOT ENOUGH HERE. The eager ratchet passes on lazy shapes because "resolve on every
 * access" is half the fix (PR #581). But the OTHER half is the sandbox preload (test-store-sandbox.ts),
 * and it redirects `NOETICA_HOME` (+ per-store vars) — it deliberately does NOT move `$HOME`. So a lazy
 * resolver that reads raw `homedir()` re-resolves late to the SAME real `~/.noetica` every time, and
 * `npm test` writes the operator's real store. swarm-volume.ts (`const ROOT = () => join(homedir(),
 * '.noetica', …)`) and cloud-provision.ts (`const FLEET = () => join(homedir(), '.noetica', …)`) were
 * exactly this — lazy, so the eager ratchet was green while the suite kept rewriting fleet/inventory.json
 * and swarm-volumes/.
 *
 * NOT flagged (the two safe shapes): `() => process.env['NOETICA_X'] || join(homedir(), '.noetica', …)`
 * carries an override, and `() => join(noeticaHome(), …)` reads neither a raw home call nor a '.noetica'
 * literal. The discriminator is the env override, not eager-vs-lazy.
 */
export function isLazyRawHomeBinding(line: string): boolean {
  if (/^\s/.test(line)) return false                       // module top level only
  if (!NOETICA_LIT.test(line) || !HOME_CALL.test(line)) return false
  if (ENV_OVERRIDE.test(line)) return false                // reads a NOETICA_* override → the seam, safe
  const m = DECL.exec(line)
  if (m) return LAZY_RHS.test(m[2] as string)              // const/let/var whose RHS is an arrow/function
  return /^(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*/.test(line) // top-level `function name(){…}`
}

/**
 * The AUTHORITATIVE detectors. `isEagerHomeBinding` / `isLazyRawHomeBinding` above are single-LINE sanity
 * checks (the test pins them against known snippets); the scanners below parse each file's real
 * module-scope AST, so a binding SPLIT ACROSS SEVERAL LINES, or a top-level declaration that happens to be
 * indented, is classified by its actual scope and its WHOLE initializer — not by one line's text. The
 * `.split('\n')` walk this replaces missed exactly those shapes: a
 *
 *     const ROOT = () => join(
 *       homedir(), '.noetica', 'swarm-volumes')     // homedir() and '.noetica' on different lines
 *
 * had no single line carrying both `homedir()` and `'.noetica'`, so the line scanner reported it clean.
 */
type Want = 'eager' | 'lazy-raw'

/** Classify a binding from its initializer/body text + whether that initializer is a function (lazy). */
function classifyBinding(rhs: string, lazy: boolean): Want | null {
  if (!NOETICA_LIT.test(rhs) || !HOME_CALL.test(rhs)) return null
  if (!lazy) return 'eager'
  if (ENV_OVERRIDE.test(rhs)) return null            // lazy but redirectable by the preload → the safe seam
  return 'lazy-raw'
}

function scanModuleScope(libDir: string, want: Want): Binding[] {
  const st = fs.statSync(libDir)
  if (!st.isDirectory()) {
    const fn = want === 'eager' ? 'scanBindings' : 'scanLazyRawBindings'
    throw new Error(`${fn} expects a DIRECTORY, got: ${libDir}`)
  }
  const out: Binding[] = []
  for (const file of fs.readdirSync(libDir).filter((f) => f.endsWith('.ts')).sort()) {
    const src = fs.readFileSync(path.join(libDir, file), 'utf8')
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TS)
    const consider = (node: ts.Node, name: string, rhs: string, display: string, lazy: boolean) => {
      if (classifyBinding(rhs, lazy) !== want) return
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      out.push({ file, line, name, text: (display.split('\n')[0] ?? '').trim() })
    }
    // sf.statements is MODULE SCOPE by construction — a local inside a function is not here, so the old
    // leading-whitespace "top level only" heuristic (which also skipped every continuation line of a
    // multi-line binding) is gone.
    for (const stmt of sf.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (!d.initializer) continue
          const lazy = ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)
          consider(d, d.name.getText(sf), d.initializer.getText(sf), stmt.getText(sf), lazy)
        }
      } else if (ts.isFunctionDeclaration(stmt) && stmt.body) {
        consider(stmt, stmt.name?.getText(sf) ?? '?', stmt.body.getText(sf), stmt.getText(sf), true)
      }
    }
  }
  return out
}

/** Every eager module-scope `~/.noetica` binding in `libDir`. Includes THIS FILE — callers exclude it. */
export function scanBindings(libDir: string): Binding[] {
  return scanModuleScope(libDir, 'eager')
}

/** Every module-scope LAZY-raw `~/.noetica` binding in `libDir` — the seam-evading shape `scanBindings`
 *  misses. This file's only `~/.noetica` binding is the eager REAL_NOETICA_DIR, which classifies as
 *  'eager', not 'lazy-raw', so there is nothing here to self-exclude. */
export function scanLazyRawBindings(libDir: string): Binding[] {
  return scanModuleScope(libDir, 'lazy-raw')
}

/** Files in `libDir` that contain at least one filesystem-mutating call. */
export function writingFiles(libDir: string): Set<string> {
  const out = new Set<string>()
  for (const file of fs.readdirSync(libDir).filter((f) => f.endsWith('.ts'))) {
    if (WRITE_CALL.test(fs.readFileSync(path.join(libDir, file), 'utf8'))) out.add(file)
  }
  return out
}

/**
 * path-confine (app-route copy) — symlink-safe confinement for user-supplied file paths.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS A DELIBERATE SECOND COPY. Read this before editing.
 *
 * The canonical implementation is `agent-machine/lib/path-confine.ts` (PR #582/#584). The three
 * functions below are copied from it VERBATIM — same names, same bodies, same semantics — because the
 * Next.js app CANNOT import from `agent-machine/`:
 *
 *   • the root `tsconfig.json` lists `agent-machine` in `exclude`, so those files are not even in the
 *     app's TypeScript program;
 *   • `agent-machine` is a separate npm package (`@noetica/agent-machine`) with its own
 *     `package.json` / `package-lock.json` / `tsconfig.json`, and is bundled independently by esbuild.
 *     It is not a workspace member of the root package, so `@/agent-machine/...` resolves to nothing
 *     the app build can compile;
 *   • it resolves modules as NodeNext ESM (`./path-confine.js` specifiers) while the app is
 *     `moduleResolution: "bundler"`.
 *
 * DRIFT RISK — the honest cost of the copy: a fix applied to one copy does not reach the other, and a
 * security primitive with two independent copies is exactly how this estate ended up with two format
 * validators that had opposite blind spots. The right end state is ONE module both sides import (a
 * small shared package, or a top-level module the agent-machine build is pointed at). That extraction
 * is deliberately NOT done here: `agent-machine/lib/path-confine.ts` and `agent-machine/server.ts` are
 * both open, in-flight work (#582 → #584) and rewriting them from this lane would collide head-on.
 *
 * If you change ANYTHING below, change `agent-machine/lib/path-confine.ts` in the same commit.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IS OMITTED, AND WHY: the canonical module also exports `confinementRoots()`,
 * `isConfinedToHomeOrTmp()` and `confinedRealPath()`, which allow the home dir OR the tmp dirs. This
 * route allows the home tree ONLY. Importing that wider policy would silently broaden the route's
 * reachable surface, so only the single-root pair is mirrored here. Mirror the MECHANISM, keep the
 * narrower POLICY.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * True iff `resolved` is exactly `root` or strictly inside it. Both must already be `path.resolve`d.
 *
 * The separator anchor is the entire point: a bare `resolved.startsWith(root)` admits siblings, because
 * `/Users/alice-evil` really does start with `/Users/alice`.
 */
export function isWithinRoot(resolved: string, root: string): boolean {
  return resolved === root || resolved.startsWith(root + path.sep)
}

/**
 * `fs.realpathSync(p)`, but tolerant of a path that does not exist YET.
 *
 * This is the whole difficulty of symlink-hardening a WRITE path. `write_file` creates files, so
 * `realpathSync` on the full path throws ENOENT and a naive hardening breaks every legitimate write.
 * So: walk up to the nearest ancestor that DOES resolve, realpath that, and re-attach the
 * not-yet-existing tail to the real ancestor. `~/newdir/new.txt` under a real `~` yields
 * `<realhome>/newdir/new.txt`; `~/link-to-etc/new.txt` yields `/private/etc/new.txt` — which the caller
 * then rejects. Checking only `existsSync(full)` and falling back to the lexical value (the shape this
 * route used to have) misses exactly that second case: a symlinked PARENT directory.
 *
 * Returns null if a component is a DANGLING symlink — it lstat()s but does not realpath(), so we cannot
 * prove where a create through it would land, and it would land at the link target, not inside the root.
 */
function realPathOfNearestExisting(p: string): string | null {
  const tail: string[] = []
  let probe = p
  for (;;) {
    try {
      return tail.length ? path.join(fs.realpathSync(probe), ...tail) : fs.realpathSync(probe)
    } catch {
      /* `probe` does not exist (yet) — keep walking up. */
    }
    try {
      if (fs.lstatSync(probe).isSymbolicLink()) return null // dangling link: unverifiable target
    } catch {
      /* genuinely absent, which is fine — it is the path being created. */
    }
    const parent = path.dirname(probe)
    if (parent === probe) return null // walked off the filesystem root without resolving anything
    tail.unshift(path.basename(probe))
    probe = parent
  }
}

/**
 * The symlink-safe form of `isWithinRoot`: returns the REAL path to operate on, or null if it escapes.
 *
 * Order matters. The lexical barrier runs FIRST, so nothing touches the filesystem on an unvalidated
 * path (this is also the shape CodeQL recognises as a barrier for `js/path-injection`). Only then do we
 * resolve symlinks and re-check. `root` is realpath'd too: a root is itself frequently a link
 * (`/tmp` → `/private/tmp` on macOS, `$TMPDIR` under `/var/folders` → `/private/var/folders`), so
 * comparing a resolved target against an unresolved root would reject legitimate paths.
 *
 * CALLERS MUST OPERATE ON THE RETURNED PATH, not the one they passed in — the caller's spelling is the
 * attacker's spelling. This is a check-then-use predicate, so it cannot close a TOCTOU race where a
 * symlink is planted between the check and the open; that is inherent to the canonical design and is
 * out of scope for this fix.
 */
export function realPathWithinRoot(resolved: string, root: string): string | null {
  if (!isWithinRoot(resolved, root)) return null
  const real = realPathOfNearestExisting(resolved)
  if (real === null) return null
  const realRoot = realPathOfNearestExisting(root)
  if (realRoot === null) return null
  return isWithinRoot(real, realRoot) ? real : null
}

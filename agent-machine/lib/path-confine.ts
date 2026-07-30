/**
 * path-confine — the ONE confinement predicate for user-supplied file paths.
 *
 * Three sites (the read_file/write_file tools, /api/ingest/path, /api/graph/from-image) each inlined
 * `resolved.startsWith(home) || resolved.startsWith('/tmp')`. Without a trailing separator that admits
 * SIBLINGS: `/Users/alice-evil/...` passes the `/Users/alice` prefix, and `/tmpfoo/...` passes `/tmp`.
 * Anchoring on `path.sep` (and matching the exact root) closes the traversal-confinement gap.
 *
 * SCOPE: `isConfinedToHomeOrTmp` / `isWithinRoot` are purely LEXICAL. They do not resolve symlinks, so
 * a link *inside* an allowed root that points outside it still passes them. Any caller that goes on to
 * OPEN the path must use `confinedRealPath` / `realPathWithinRoot` below, which run the lexical barrier
 * first and then re-validate through `fs.realpathSync`.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * True iff `resolved` is exactly `root` or strictly inside it. Both must already be `path.resolve`d.
 *
 * The separator anchor is the entire point of this module: a bare `resolved.startsWith(root)` admits
 * siblings, because `/Users/alice-evil` really does start with `/Users/alice`. Exported standalone so
 * the anchoring property can be tested against SYNTHETIC roots — asserting it through
 * `isConfinedToHomeOrTmp` instead makes the test depend on where HOME happens to point (see below).
 */
export function isWithinRoot(resolved: string, root: string): boolean {
  return resolved === root || resolved.startsWith(root + path.sep)
}

/** The allowed roots: the home dir and the OS temp dir, plus conventional /tmp and macOS /private/tmp. */
export function confinementRoots(): string[] {
  return [path.resolve(os.homedir()), path.resolve(os.tmpdir()), '/tmp', '/private/tmp']
}

/**
 * True iff `resolved` (an already-`path.resolve`d absolute path) is one of the allowed roots or strictly
 * inside one.
 *
 * The roots are a UNION and they can NEST: under a sandbox HOME such as `/tmp/sandbox` (routine in CI
 * containers and agent sandboxes) the sibling `/tmp/sandbox-evil` is outside the home root but genuinely
 * inside the `/tmp` root, so it is confined and this returns true. That is the contract, not a leak —
 * but it is why a test must not derive an "outside" path by string-appending to `os.homedir()`.
 */
export function isConfinedToHomeOrTmp(resolved: string): boolean {
  return confinementRoots().some((r) => isWithinRoot(resolved, r))
}

/**
 * `fs.realpathSync(p)`, but tolerant of a path that does not exist YET.
 *
 * This is the whole difficulty of symlink-hardening a WRITE path. `write_file` and `edit_file` create
 * files, so `realpathSync` on the full path throws ENOENT and a naive hardening breaks every legitimate
 * write. So: walk up to the nearest ancestor that DOES resolve, realpath that, and re-attach the
 * not-yet-existing tail to the real ancestor. `~/newdir/new.txt` under a real `~` yields
 * `<realhome>/newdir/new.txt`; `~/link-to-etc/new.txt` yields `/private/etc/new.txt` — which the caller
 * then rejects. Checking only `existsSync(full)` and falling back to the lexical value (the shape in
 * `app/api/agent-tool/route.ts`) misses exactly that second case: a symlinked PARENT directory.
 *
 * Returns null if a component is a DANGLING symlink — it lstat()s but does not realpath(), so we cannot
 * prove where a create through it would land, and it would land at the link target, not inside the root.
 * Returns null, too, for any component that fails to resolve for a reason OTHER than absence (see
 * `isAbsent`): "I could not look" is not the same claim as "it is not there".
 */

/**
 * Does this error mean "the component is not there YET" — the one condition that justifies walking
 * further up? Everything else (EACCES, ELOOP, EPERM, ENAMETOOLONG, EIO) means we could not PROVE where
 * the path lands. Treating those as "absent" and re-attaching the tail hands back a path that was never
 * validated, through components we were unable to inspect. A confinement primitive that cannot prove
 * must REFUSE. The fail-CLOSED app copy (app/api/agent-tool/path-confine.ts) already carries this gate;
 * #584's hardening was dropped from THIS canonical copy when it was relanded — this restores parity.
 */
function isAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function realPathOfNearestExisting(p: string): string | null {
  const tail: string[] = []
  let probe = p
  for (;;) {
    try {
      return tail.length ? path.join(fs.realpathSync(probe), ...tail) : fs.realpathSync(probe)
    } catch (err) {
      if (!isAbsent(err)) return null // unresolvable ⇒ unprovable ⇒ refuse
      /* `probe` does not exist (yet) — keep walking up. */
    }
    try {
      if (fs.lstatSync(probe).isSymbolicLink()) return null // dangling link: unverifiable target
    } catch (err) {
      if (!isAbsent(err)) return null // cannot even lstat it ⇒ cannot rule out a link ⇒ refuse
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
 * resolve symlinks and re-check. `root` is realpath'd too: an allowed root is itself frequently a link
 * (`/tmp` → `/private/tmp` on macOS, `$TMPDIR` under `/var/folders` → `/private/var/folders`), so
 * comparing a resolved target against an unresolved root would reject legitimate paths.
 */
export function realPathWithinRoot(resolved: string, root: string): string | null {
  if (!isWithinRoot(resolved, root)) return null
  const real = realPathOfNearestExisting(resolved)
  if (real === null) return null
  const realRoot = realPathOfNearestExisting(root)
  if (realRoot === null) return null
  return isWithinRoot(real, realRoot) ? real : null
}

/**
 * The symlink-safe form of `isConfinedToHomeOrTmp`: returns the REAL path to operate on, or null.
 *
 * `isConfinedToHomeOrTmp` alone is bypassable — a symlink INSIDE an allowed root that points outside it
 * passes a lexical check, so `~/escape → /etc` turned `~/escape/passwd` into an arbitrary read. Callers
 * must use the returned path for the actual fs operation; the lexical one is the attacker's spelling.
 */
export function confinedRealPath(resolved: string): string | null {
  if (!isConfinedToHomeOrTmp(resolved)) return null // lexical barrier FIRST — no fs access before this
  const real = realPathOfNearestExisting(resolved)
  if (real === null) return null
  return confinementRoots()
    .map(realPathOfNearestExisting)
    .some((r) => r !== null && isWithinRoot(real, r))
    ? real
    : null
}

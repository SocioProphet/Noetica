/**
 * path-confine — the ONE confinement predicate for user-supplied file paths.
 *
 * Three sites (the read_file/write_file tools, /api/ingest/path, /api/graph/from-image) each inlined
 * `resolved.startsWith(home) || resolved.startsWith('/tmp')`. Without a trailing separator that admits
 * SIBLINGS: `/Users/alice-evil/...` passes the `/Users/alice` prefix, and `/tmpfoo/...` passes `/tmp`.
 * Anchoring on `path.sep` (and matching the exact root) closes the traversal-confinement gap.
 *
 * SCOPE: this is a purely LEXICAL containment check. It does not resolve symlinks, so a link *inside*
 * an allowed root that points outside it still passes. Callers that go on to open the path need
 * `fs.realpathSync` re-validation on top — see `app/api/agent-tool/route.ts` for that pattern.
 */
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

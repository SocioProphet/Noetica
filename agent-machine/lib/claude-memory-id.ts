/**
 * claude-memory-id — a namespace-SAFE document id for an ingested Claude-memory file.
 *
 * `/api/ingest/claude-memory` confines each file to the home tree OR /tmp (a real confinement root), then
 * derived the brain document id from `path.relative(os.homedir(), full)`. For a file under /tmp that is
 * fine lexically but NOT relative to home: on macOS a confined realpath resolves /tmp → /private/tmp, so
 * `path.relative(home, full)` climbs out of home with leading `..` segments and
 *
 *     claude-memory/${rel}  ⟶  claude-memory/../../private/tmp/…/x.md
 *
 * — an id that escapes the `claude-memory/` namespace (and, anywhere an id is later treated as a path,
 * its store). The confinement check upstream is intact; this is purely about the id STRING derived after.
 *
 * Fix: normalise the relative path to a clean sub-path — drop every '.'/'..'/empty segment so no id can
 * climb out of the namespace. A file genuinely under home is unaffected (its relative path has no `..`).
 * Falls back to the basename if normalisation empties the path (e.g. `full === home`).
 */
import * as path from 'node:path'

/**
 * The namespace-safe RELATIVE portion of a Claude-memory doc id — caller prefixes it with
 * `claude-memory/`. Guaranteed to contain no `.`/`..` segment, so `claude-memory/${result}` cannot
 * traverse above the namespace root.
 */
export function claudeMemoryDocRel(homeDir: string, full: string): string {
  const rel = path.relative(homeDir, full)
  const safe = rel
    .split(/[/\\]+/)
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/')
  return safe || path.basename(full)
}

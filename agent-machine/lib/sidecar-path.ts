/**
 * sidecar-path — locate a bundled Rust sidecar binary, on every platform.
 *
 * Tauri's externalBin strips the target triple but KEEPS the extension, so
 * `binaries/noetica-embed-x86_64-pc-windows-msvc.exe` installs beside the app as
 * `noetica-embed.exe`. Both call sites used to probe the bare name, which is never a real
 * file on Windows — so the embedder and the operator were silently "unavailable" on every
 * Windows install: embeddings fell back to Ollama on the hot path, and verified compute
 * quietly degraded. Nothing errored, which is exactly why it went unnoticed.
 *
 * One resolver so a third sidecar can't reintroduce the same platform-blind lookup.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Executable suffix for this platform — '' everywhere except win32. */
export const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : ''

/**
 * Resolve a sidecar binary by name.
 *   • `name`     — bare binary name, no extension (e.g. 'noetica-embed')
 *   • `devDir`   — the sidecar's source dir for the cargo build output (e.g. 'embed-sidecar')
 *   • `fromDir`  — the caller's __dirname, for the dev-tree lookup
 * Returns an absolute path, or null when the binary isn't present (callers degrade).
 */
export function resolveSidecarBinary(name: string, devDir: string, fromDir: string): string | null {
  const file = `${name}${EXE_SUFFIX}`
  // prod: shipped next to the agent-machine binary in the .app / install dir (Tauri externalBin)
  const beside = path.join(path.dirname(process.execPath), file)
  if (fs.existsSync(beside)) return beside
  // dev: the cargo target
  for (const p of [
    path.resolve(process.cwd(), `${devDir}/target/release/${file}`),
    path.resolve(fromDir, `../../${devDir}/target/release/${file}`),
  ]) { if (fs.existsSync(p)) return p }
  return null
}

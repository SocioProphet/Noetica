/**
 * python-resolve — find a USABLE Python interpreter across platforms.
 *
 * `python3` is a POSIX-ism. On Windows the interpreter is `python.exe` or the registry-
 * backed launcher `py.exe` — and if Python came from the Microsoft Store (or the App
 * Execution Alias is on), %LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe exists as a
 * zero-byte reparse stub: spawn sees a file, execs it, and it ENOENTs or opens the Store
 * page. "python3 exists" and "spawn finds a usable python3" are independent facts, so we
 * PROBE each candidate by asking it for sys.executable and reject WindowsApps stubs.
 *
 * Order matters on win32: `py -3` resolves through HKLM\SOFTWARE\Python\PythonCore, so
 * it's immune to PATH ordering and alias breakage. HELLGRAPH_PYTHON (the existing knob)
 * or NOETICA_PYTHON always wins as the escape hatch.
 */
import { execFileSync } from 'node:child_process'

export interface ResolvedPython { cmd: string; args: string[]; exe?: string }

const CANDIDATES: Array<[string, string[]]> = process.platform === 'win32'
  ? [['py', ['-3']], ['python', []], ['python3', []]]
  : [['python3', []], ['python', []]]

let cached: ResolvedPython | null | undefined

/** Ask a candidate for sys.executable. Returns null when it can't run. */
function probe(cmd: string, pre: string[]): string | null {
  try {
    return execFileSync(cmd, [...pre, '-c', 'import sys;print(sys.executable)'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null
  } catch { return null }
}

export function resolvePython(): ResolvedPython | null {
  if (cached !== undefined) return cached
  const overrideVar = process.env['HELLGRAPH_PYTHON'] ? 'HELLGRAPH_PYTHON' : 'NOETICA_PYTHON'
  const override = process.env['HELLGRAPH_PYTHON'] || process.env['NOETICA_PYTHON']
  if (override) {
    // PROBE the override too. It used to be trusted blindly, so a stale path — an uninstalled
    // 3.10 still listed in the registry, a typo, a moved venv — sailed through here and failed
    // later as an opaque `uv_spawn ENOENT` from whichever sidecar spawned first. That reads as
    // "the app can't find Python" when the truth is "the path you set is wrong", which sends
    // people hunting the wrong bug. Fail loudly, at the point of the lie.
    const exe = probe(override, [])
    if (exe) { cached = { cmd: override, args: [], exe }; return cached }
    console.warn(
      `[python-resolve] ${overrideVar}='${override}' is set but could not be executed — ignoring it ` +
      `and falling back to auto-detection. Point it at a real python executable, or unset it.`,
    )
    // fall through to auto-detection rather than dying on a bad hint
  }
  for (const [cmd, pre] of CANDIDATES) {
    const exe = probe(cmd, pre)
    if (exe && !/\\WindowsApps\\/i.test(exe)) { cached = { cmd, args: pre, exe }; return cached }
  }
  cached = null
  return null
}

/** One honest line for startup logs when no interpreter is usable. */
export function pythonUnavailableHint(): string {
  return process.platform === 'win32'
    ? 'no usable Python found (tried py -3, python, python3; Store-alias stubs rejected) — install from python.org or set NOETICA_PYTHON'
    : 'no usable Python found (tried python3, python) — install Python 3 or set NOETICA_PYTHON'
}

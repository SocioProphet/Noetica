// Progress-chip bookkeeping for files being read / ingested in the composer.
//
// The composer shows a "…" chip per in-flight file (Gus #8). The browser/drag path drove
// this; the Tauri native file-picker path did NOT, so in the shipping desktop app a native
// attach showed nothing until ingestion finished (B1-8). Both paths now share this immutable
// helper so the feedback is identical everywhere and the list arithmetic is unit-tested.

/** Add chips for the given files. */
export function enqueueAttaching(list: readonly string[], names: readonly string[]): string[] {
  return [...list, ...names]
}

/**
 * Remove ONE occurrence — so two files with the same name each clear their own chip as
 * they finish, rather than one completion wiping both.
 */
export function dequeueAttaching(list: readonly string[], name: string): string[] {
  const i = list.indexOf(name)
  return i === -1 ? [...list] : [...list.slice(0, i), ...list.slice(i + 1)]
}

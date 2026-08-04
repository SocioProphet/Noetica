/**
 * Document RAG is best-effort — but a retrieval FAILURE must not be silent when the user
 * actually has documents. In that case the answer proceeds ungrounded and looks identical
 * to a grounded one; the turn should say so. When no documents are present there is
 * nothing to degrade, so no warning is raised (avoiding a false "unavailable" on every
 * plain chat).
 *
 * Returns the operator-log message for a real degradation, or null when there's nothing
 * to signal. Pure so the "only when docs present" gate is unit-tested.
 */
export function ragDegradationMessage(docsPresent: boolean, err: unknown): string | null {
  if (!docsPresent) return null
  return err instanceof Error ? err.message : 'document retrieval failed'
}

/** The user-facing line shown on the retrieve step and knowledge boundary when degraded. */
export const RAG_DEGRADED_NOTICE = 'retrieval unavailable — answered without your documents'

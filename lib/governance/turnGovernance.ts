import type { GovernanceTrace } from '@/lib/types/governance'

/**
 * Merge the model-sovereignty fields carried on the streaming `meta` event with the
 * governance fields rebuilt from the final `done` result.
 *
 * Why this exists: the `done` result does NOT re-send `model_requested`, `model_honored`,
 * or `route_overrides` — those are computed and emitted once, on `meta`. The client rebuilds
 * `governance` from `done` at end-of-turn and merges it shallowly into the message, so unless
 * the meta fields are carried forward here they are clobbered before render, and the
 * "you selected … honoured / overridden" + route-changes rows show nothing even though the
 * sovereignty trail was fully computed server-side.
 *
 * `done` wins on overlap: it carries the final, authoritative routed model and evidence hashes.
 * The meta-only sovereignty fields survive because `done` never sets them.
 */
export function mergeTurnGovernance(
  meta: GovernanceTrace | undefined,
  done: GovernanceTrace,
): GovernanceTrace {
  // done is the complete, authoritative end-of-turn trace; meta only adds the
  // sovereignty fields it uniquely carried. done wins on every overlapping key.
  return { ...(meta ?? {}), ...done }
}

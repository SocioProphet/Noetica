/**
 * budget.ts — make `budget_ref` mean something.
 *
 * `budget_ref` was declared on both ModelRouteRequest and ModelRouteDecision, copied
 * from one to the other by the adapter, and read by nothing. A caller could set it,
 * see it echoed back in the decision, and reasonably conclude a spend ceiling was
 * being enforced. None was.
 *
 * `config/schemas/limit-receipt.schema.json` described exactly the artifact such an
 * enforcement should emit — limitType, limitValue, observedValue, rollbackTaken —
 * and had zero code references anywhere in the repo. A schema and a field, each
 * describing half of a mechanism that did not exist.
 *
 * This is that mechanism. It is deliberately small: a declared ceiling, an observed
 * total, a refusal when the projected spend would cross it, and a receipt recording
 * the refusal. `executionPerformed` is pinned false in the schema because a limit
 * receipt exists to record that something did NOT happen.
 */

export type LimitType = 'daily-external-egress-usd' | 'daily-external-egress-tokens' | 'run-external-egress-usd'

export interface Budget {
  ref: string
  limitType: LimitType
  /** The ceiling. A budget without one cannot refuse anything. */
  limitValue: number
  /** Spend already attributed to this budget in the current window. */
  observedValue: number
  windowStartedAt: string
}

/** Conforms to config/schemas/limit-receipt.schema.json. */
export interface LimitReceipt {
  schemaVersion: '0.1.0'
  receiptId: string
  limitType: string
  limitValue: number
  observedValue: number
  enforcedAt: string
  agentRef: string
  engagementRef: string
  rollbackTaken: boolean
  executionPerformed: false
}

export interface BudgetConsult {
  allowed: boolean
  /** Present only on refusal — a limit receipt records a spend that did not occur. */
  receipt?: LimitReceipt
  reason?: string
}

const _budgets = new Map<string, Budget>()

export function declareBudget(b: Budget): void {
  _budgets.set(b.ref, { ...b })
}

/** Reference name of the default hosted-egress budget wired from environment. */
export const DEFAULT_HOSTED_BUDGET_REF = 'noetica:hosted-daily-usd'

/** Idempotent wiring: read `NOETICA_DAILY_HOSTED_USD_CEILING` and declare a default
 *  hosted-egress budget. Called at chat/route.ts module load so the ceiling exists
 *  by the time the FIRST request lands (a budget declared later would let the
 *  earliest hosted spend through unchecked — the exact defect this exists to fix,
 *  reproduced by a race). Silently no-ops when the env var is unset (dev/tests),
 *  and never resets an existing budget's observed spend on re-import.
 *
 *  This is the caller wiring the reviewer asked for: `declareBudget` and
 *  `recordSpend` used to be dead exports; the whole flow — declare-on-boot,
 *  consult-before-egress, record-after-response — is now traceable end to end. */
export function wireDefaultHostedBudget(): string | undefined {
  const raw = process.env.NOETICA_DAILY_HOSTED_USD_CEILING
  const ceiling = raw ? Number(raw) : NaN
  if (!raw || !Number.isFinite(ceiling) || ceiling <= 0) return undefined
  if (!_budgets.has(DEFAULT_HOSTED_BUDGET_REF)) {
    declareBudget({
      ref: DEFAULT_HOSTED_BUDGET_REF,
      limitType: 'daily-external-egress-usd',
      limitValue: ceiling,
      observedValue: 0,
      windowStartedAt: new Date().toISOString(),
    })
  }
  return DEFAULT_HOSTED_BUDGET_REF
}

export function getBudget(ref: string): Budget | undefined {
  const b = _budgets.get(ref)
  return b ? { ...b } : undefined
}

export function resetBudgets(): void {
  _budgets.clear()
}

function receiptId(ref: string): string {
  // Schema pattern: ^limit-receipt:[a-z0-9-]+$
  const slug = ref.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'unref'
  return `limit-receipt:${slug}-${Date.now().toString(36)}`
}

/**
 * Decide whether `projected` additional spend may proceed against `ref`.
 *
 * An unknown ref is NOT treated as unlimited. A budget reference that resolves to
 * nothing is the condition this module exists to eliminate, and silently allowing
 * it would reproduce the original defect with extra steps — the caller would again
 * believe a ceiling applied when none did.
 */
export function consultBudget(
  ref: string | undefined,
  projected: number,
  ctx?: { agentRef?: string; engagementRef?: string },
): BudgetConsult {
  if (!ref) return { allowed: true, reason: 'no budget declared for this request' }

  const budget = _budgets.get(ref)
  if (!budget) {
    return {
      allowed: false,
      reason: `budget_ref '${ref}' does not resolve to a declared budget; refusing rather than treating an unresolvable reference as unlimited`,
    }
  }

  const observed = budget.observedValue + Math.max(0, projected)
  if (observed <= budget.limitValue) return { allowed: true }

  return {
    allowed: false,
    reason: `${budget.limitType} would reach ${observed} against a ceiling of ${budget.limitValue}`,
    receipt: {
      schemaVersion: '0.1.0',
      receiptId: receiptId(ref),
      limitType: budget.limitType,
      limitValue: budget.limitValue,
      observedValue: observed,
      enforcedAt: new Date().toISOString(),
      agentRef: ctx?.agentRef ?? 'urn:noetica:agent:model-router',
      engagementRef: ctx?.engagementRef ?? ref,
      rollbackTaken: false,   // nothing ran, so there is nothing to roll back
      executionPerformed: false,
    },
  }
}

/** Attribute realised spend to a budget. Only called for spend that actually occurred. */
export function recordSpend(ref: string | undefined, amount: number): void {
  if (!ref) return
  const b = _budgets.get(ref)
  if (!b) return
  b.observedValue += Math.max(0, amount)
}

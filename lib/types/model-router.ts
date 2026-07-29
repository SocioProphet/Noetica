import type { LimitReceipt } from '@/lib/governance/budget'
import type { ExternalModelProviderRouteEvidence } from '@/lib/types/agentplane'
import type { Provider, SteeringCapability } from '@/lib/types/model'

export type NoeticaModelRouteSchemaVersion = 'noetica.model_route.v0.1'
export type ModelRouteStatus = 'stubbed' | 'routed' | 'blocked' | 'requires-policy'
export type ModelRouteTarget = 'base-local' | 'personal-local' | 'quality-local' | 'hosted' | 'deny'
export type ModelRouteCostClass = 'no-model' | 'local-cheap' | 'cheap' | 'standard' | 'high-end' | 'pro'
export type PromptEgressDecision = 'deny' | 'allow-with-policy' | 'allow'

export interface ModelRouteRequest {
  schema_version: NoeticaModelRouteSchemaVersion
  request_id: string
  session_id: string
  agent_id: 'noetica'
  mode: 'standalone' | 'sourceos'
  task_class: 'standalone-chat' | 'sourceos-chat' | 'steering' | 'comparison'
  model_hint?: string
  provider_hint?: Provider
  // Providers for which the caller has valid API keys — used for live routing decisions
  available_providers?: Provider[]
  prompt_hash?: string
  tool_grant_refs?: string[]
  steering_required?: SteeringCapability
  policy_ref?: string
  /** Reference to a declared spend ceiling. Consulted by the router BEFORE any hosted
   *  route is returned; an unresolvable ref is refused rather than treated as unlimited. */
  budget_ref?: string
  /** Estimated USD this request would add to the budget, used for the pre-egress check. */
  projected_cost_usd?: number
  privacy_ref?: string
}

export interface ModelRouteDecision {
  schema_version: NoeticaModelRouteSchemaVersion
  status: ModelRouteStatus
  request_id: string
  route_decided_at: string
  authority: 'SocioProphet/model-router'
  live_route_performed: boolean
  model_hint?: string
  model_routed: string
  provider: Provider
  model_overridden: boolean
  route_target: ModelRouteTarget
  cost_class: ModelRouteCostClass
  prompt_egress: PromptEgressDecision
  policy_ref?: string
  budget_ref?: string
  privacy_ref?: string
  evidence_required: string[]
  route_evidence_ref?: string
  provider_route_evidence?: ExternalModelProviderRouteEvidence
  blocked_reason?: string
  /** Present when the refusal was caused by a spend ceiling. Conforms to
   *  config/schemas/limit-receipt.schema.json, whose executionPerformed is pinned
   *  false: a limit receipt records that something did NOT run. */
  limit_receipt?: LimitReceipt
  degradation_reason?: string
  notes: string[]
}

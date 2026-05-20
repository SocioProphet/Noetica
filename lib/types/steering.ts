export interface SteeringConfig {
  feature_id: string
  layer: string
  strength: number
  preset?: string
}

export interface SteeringResult {
  baseline: string
  steered: string
  diff_summary: string
  feature_id: string
  layer: string
  strength: number
}

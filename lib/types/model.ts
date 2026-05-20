export type Provider = 'neuronpedia' | 'anthropic' | 'openai' | 'google' | 'meta' | 'mistral' | 'xai'

export interface ModelConfig {
  id: string
  label: string
  provider: Provider
  steering_eligible: boolean
  local_capable: boolean
  context_window: number
  description: string
}

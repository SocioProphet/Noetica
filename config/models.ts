import type { ModelConfig } from '@/lib/types/model'

export const models: ModelConfig[] = [
  {
    id: 'gpt-4.1-mini',
    label: 'GPT-4.1 mini',
    provider: 'openai',
    steering_eligible: false,
    local_capable: false,
    context_window: 1047576,
    description: 'Standalone OpenAI model for fast governed chat trials.'
  },
  {
    id: 'claude-3-5-sonnet-latest',
    label: 'Claude 3.5 Sonnet',
    provider: 'anthropic',
    steering_eligible: false,
    local_capable: false,
    context_window: 200000,
    description: 'Standalone Anthropic model for dense reasoning and drafting.'
  },
  {
    id: 'gemma-2-9b-it-neuronpedia',
    label: 'Gemma 2 9B IT + Neuronpedia',
    provider: 'neuronpedia',
    steering_eligible: true,
    local_capable: true,
    context_window: 8192,
    description: 'Open model target for SAE steering experiments.'
  },
  {
    id: 'llama-3.1-8b-instruct',
    label: 'Llama 3.1 8B Instruct',
    provider: 'meta',
    steering_eligible: true,
    local_capable: true,
    context_window: 131072,
    description: 'Local-capable open model candidate for SourceOS routing.'
  },
  {
    id: 'mistral-large-latest',
    label: 'Mistral Large',
    provider: 'mistral',
    steering_eligible: false,
    local_capable: false,
    context_window: 128000,
    description: 'Mistral provider placeholder for post-M1 implementation.'
  },
  {
    id: 'gemini-1.5-pro',
    label: 'Gemini 1.5 Pro',
    provider: 'google',
    steering_eligible: false,
    local_capable: false,
    context_window: 1000000,
    description: 'Google provider placeholder for post-M1 implementation.'
  }
]

export const defaultModelId = models[0]?.id ?? 'gpt-4.1-mini'

# M2a Standalone Smoke

This smoke test verifies the M2a live standalone provider path without requiring SourceOS or Neuronpedia.

## Preconditions

Run the app with at least one live provider key configured:

- `OPENAI_API_KEY` for OpenAI models.
- `ANTHROPIC_API_KEY` for Anthropic models.

Optional provider model overrides are available when provider aliases move:

- `OPENAI_MODEL_ID`
- `ANTHROPIC_MODEL_ID`

`NEURONPEDIA_API_KEY` is not required for M2a.

## Run

Terminal 1:

```bash
npm install && npm run dev
```

Terminal 2:

```bash
SMOKE_MODEL_ID=gpt-4o npm run smoke:standalone
```

Or, for Anthropic:

```bash
SMOKE_MODEL_ID=claude-sonnet-4-6 npm run smoke:standalone
```

If the provider model alias has moved, set the corresponding runtime override while selecting the UI-facing model:

```bash
ANTHROPIC_MODEL_ID=<current-provider-model-id> SMOKE_MODEL_ID=claude-sonnet-4-6 npm run smoke:standalone
```

## Pass condition

The script exits `0` and prints JSON containing:

- `ok: true`
- `model_routed`
- `provider`
- positive `latency_ms`
- 64-character `request_hash`
- 64-character `evidence_hash`
- at least one streamed delta
- a non-empty response preview

## Boundary

This smoke verifies standalone provider streaming and local Noetica tamper-evidence. It does not verify real SAE steering, SourceOS routing, memory-mesh persistence, or agentplane evidence persistence.

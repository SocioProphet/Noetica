# Noetica — Agent Instructions

Noetica is the governed chat surface for the SocioProphet / SourceOS stack.
It sits at the same tier as TurtleTerm, BearBrowser, and AgentTerm.

## Stack

- Next.js 14 App Router
- TypeScript
- Tailwind CSS
- Zustand

## Key boundaries

- Noetica does NOT own memory. Memory is memory-mesh's authority.
- Noetica does NOT own model routing. That is model-router's authority.
- Noetica does NOT own policy admission. That is guardrail-fabric's authority.
- Noetica DOES own: the chat surface, the steering UX, the governance trail display,
  the provider abstraction layer, and the Superconscious adapter interface.

## Modes

- standalone: direct provider API calls, no Superconscious dependency
- sourceos: submit NoeticaTaskInput to Superconscious adapter

## Steering

SAE steering via Neuronpedia applies to steering_eligible models only.
Always show steered vs baseline diff. Never hide what was changed.

## Palette

```css
--noetica-blue: #2563EB;
--noetica-blue-light: #EFF6FF;
--noetica-blue-mid: #BFDBFE;
```

White backgrounds. No warm tones. Sharp, crisp, technical.

## Authority references

- Superconscious: github.com/SocioProphet/superconscious
- Model Router: github.com/SocioProphet/model-router
- Memory Mesh: github.com/SocioProphet/memory-mesh
- Agent Machine: github.com/SourceOS-Linux/agent-machine
- Agentplane: github.com/SocioProphet/agentplane

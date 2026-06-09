# Risk Aversion Outcome Observatory

Noetica measures how an AI interaction changes as risk pressure accumulates across turns.

This is not hidden-neuron analysis for closed hosted models. It is behavioral evidence analysis: user framing, risk pressure, observed steering mode, deflection delta, and outcome impact.

## Core equation

```text
input turn -> risk vector -> steering / response mode -> deflection delta -> outcome card
```

## Why this exists

AI systems do not only answer the user's topic. They also manage perceived risk. When a conversation moves from technical observation into culpability, attribution, cybercrime, legal exposure, or public evidence packaging, the response can shift.

That shift can be appropriate. It can reduce unsupported claims.

It can also distort an investigation. It can slow down direct analysis, soften language, avoid attribution, increase evidence demands, or reframe the user's request into a safer model.

Noetica records that transition.

## First implementation

The first slice is deterministic and local:

- `lib/risk/riskAversion.ts` defines the contracts.
- `lib/risk/riskAversionScorer.mjs` scores a turn or corpus.
- `scripts/score-risk-aversion.mjs` exposes scoring through npm.
- `scripts/validate-risk-aversion-fixtures.mjs` validates accepted/rejected fixtures.
- `examples/risk-aversion/` contains the first bounded corpus fixtures.

## Commands

Score a corpus fixture:

```bash
npm run risk:score -- --file examples/risk-aversion/chatgpt-crash-corpus.accepted.json
```

Validate fixtures:

```bash
npm run risk:validate-fixtures
```

## Risk dimensions

The first scorer tracks:

- liability risk;
- attribution risk;
- defamation risk;
- privacy risk;
- platform-abuse risk;
- reputational risk;
- evidence-quality risk;
- medical/legal/financial risk;
- self-harm or violence risk;
- security-misuse risk;
- model-uncertainty risk.

## Steering modes

The first scorer detects observable response modes:

- direct answer;
- qualify causality;
- request more evidence;
- avoid attribution;
- separate proof from hypothesis;
- shift to hazard model;
- refuse or boundary;
- artifact production;
- counterfactual replay;
- safe redirect.

## Interpretation discipline

Use this language:

- observed risk-aversion pressure;
- observed steering or response-mode transition;
- observed deflection delta;
- supported gate hypothesis;
- counterfactual replay required.

Avoid this language unless direct evidence exists:

- hidden neuron activation in a closed hosted model;
- proven intent;
- proven party culpability;
- direct access to provider-side policy or routing state.

## Next implementation slices

1. Add graph generation for risk-aversion transition graphs.
2. Attach risk traces to exported `SourceOSInteractionEvent` payloads.
3. Add a Noetica UI card for turn-level risk vectors and deflection deltas.
4. Add counterfactual replay fixtures for neutral, forensic, culpability-framed, and attribution-framed prompts.

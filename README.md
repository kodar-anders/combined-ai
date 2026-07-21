# combined-ai

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520.3-339933.svg)](https://nodejs.org/)

**Multi-model consensus, pipeline, ensemble, broadcast, and panel for TypeScript.**

Most AI libraries hand you one model at a time. combined-ai makes several models
**work together on a single prompt** — consensus, sequential refinement, a vote
on structured output, a role-based expert panel, or a plain fan-out that returns
every model's answer — behind one tiny interface. Single-provider calls
(`complete`/`stream`) are included too.

```ts
import { ProviderRegistry } from "combined-ai";

const registry = new ProviderRegistry({
  anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
  openai: { apiKey: process.env.OPENAI_API_KEY! },
  google: { apiKey: process.env.GEMINI_API_KEY! },
});

// Three models draft, critique each other, and one synthesizes the best answer.
const result = await registry.combine({
  messages: [{ role: "user", content: "Design a rate limiter." }],
  participants: ["anthropic", "openai", "google"],
});

console.log(result.text);
```

## Installation

```bash
npm install combined-ai
# or: yarn add combined-ai / pnpm add combined-ai
```

Requires **Node.js ≥ 20.3** (uses the global `fetch`/`ReadableStream`/`AbortSignal.any`).
The published package is dual ESM + CJS with TypeScript types, so any package
manager works as a consumer. The library **never reads environment variables** —
you always pass API keys in explicitly via the registry config.

## Contents

- [Why combine?](#why-combine)
- [Combining providers](#combining-providers) — the five strategies
- [Single-provider usage](#single-provider-usage)
- [Reference documentation](#reference-documentation) (deep-dive pages)
- [Public API](#public-api)

## Why combine?

A single model gives you one answer with no second opinion. combined-ai runs
several models on the same prompt, with five strategies for five shapes of
problem:

| Strategy      | Shape                                         | Use it when…                                                    |
| ------------- | --------------------------------------------- | --------------------------------------------------------------- |
| `"consensus"` | draft → critique → synthesize                 | you want one well-reasoned answer that survived peer review.    |
| `"pipeline"`  | sequential refinement (a conveyor belt)       | each model should improve the previous one's answer in turn.    |
| `"ensemble"`  | parallel structured answers → field-wise vote | you need extraction/classification **with a confidence score**. |
| `"broadcast"` | parallel fan-out, every raw answer returned   | you want each model's answer side by side, with no combining.   |
| `"panel"`     | role-based experts → integrate                | you want distinct expert perspectives merged into one answer.   |

All five share one interface: configure a `ProviderRegistry`, then call
`registry.combine({ participants, messages, strategy })`. Participants can be
different providers, or the **same provider with different models**.

## Combining providers

```ts
const result = await registry.combine({
  messages: [{ role: "user", content: "Design a rate limiter." }],
  participants: ["anthropic", "openai", "google"],
  strategy: "consensus", // optional; default
});
```

`combine()` accepts the same request fields as `complete()` (`messages`,
`system`, `model`, `maxTokens`, `signal`, `retry`, `timeoutMs`) — applied to every
participant unless a participant overrides them — plus:

| Field             | Type                                                                        | Notes                                                                                                    |
| ----------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `participants`    | `ParticipantSpec[]`                                                         | Required, non-empty. A bare `ProviderName`, or `{ provider, model?, maxTokens?, label?, instruction? }`. |
| `strategy`        | `"consensus"` \| `"pipeline"` \| `"ensemble"` \| `"broadcast"` \| `"panel"` | Optional. Defaults to `"consensus"`.                                                                     |
| `synthesizer`     | `string` (participant id)                                                   | _Consensus & panel._ Who writes the final answer. Defaults to the first participant.                     |
| `attribution`     | `"attributed"` \| `"anonymized"`                                            | _Consensus only._ Default `"anonymized"` (Answer A/B/C) reduces bias.                                    |
| `minParticipants` | `number`                                                                    | _Consensus only._ Minimum drafts required to proceed (default 2).                                        |
| `crossExamine`    | `boolean`                                                                   | _Panel only._ Run a review round before synthesis (default `false`).                                     |
| `responseFormat`  | `ResponseFormat`                                                            | _Ensemble only (required there)._ The shared JSON Schema every model answers under.                      |

**Two ways to call it.** Use a per-strategy method — `registry.consensus(req)`,
`.pipeline(req)`, `.ensemble(req)`, `.broadcast(req)`, `.panel(req)` — to get that
strategy's **concrete** result type, or the generic `registry.combine(request)`
dispatcher (which returns the concrete type for a literal `strategy` and the
`CombineResult` union for a dynamic one). Both share one engine and the same
validation.

### Consensus

The default. Every participant drafts in parallel, each critiques all drafts
(anonymized by default to neutralize bias), then the `synthesizer` writes the one
final answer.

```ts
const result = await registry.combine({
  messages: [{ role: "user", content: "Design a rate limiter." }],
  participants: ["anthropic", "openai", "google"],
  synthesizer: "anthropic", // optional; defaults to the first participant
});

console.log(result.text); // the final synthesized answer
```

→ [Consensus details](./docs/strategies.md#consensus)

### Pipeline

A conveyor belt: each participant refines the previous one's answer, in
participant order. The first writes an initial answer; each later stage improves
it; the **last stage to produce an answer wins**.

```ts
const result = await registry.pipeline({
  messages: [{ role: "user", content: "Design a rate limiter." }],
  participants: ["anthropic", "openai", "google"], // the conveyor order
});

console.log(result.text); // the final, refined answer
console.log(result.finalParticipant); // id of the last stage that produced one
```

→ [Pipeline details](./docs/strategies.md#pipeline)

### Ensemble

A multi-model vote on **structured output** — the thing one provider can't give
you. Every participant answers under the same JSON Schema, the typed objects are
merged **mechanically** (no model adjudicates), and you get an **agreement score**.

```ts
const result = await registry.ensemble({
  messages: [{ role: "user", content: "Extract the city and country: ..." }],
  participants: ["anthropic", "openai", "google"],
  responseFormat: {
    type: "json_schema",
    schema: {
      type: "object",
      properties: { city: { type: "string" }, country: { type: "string" } },
      required: ["city", "country"],
      additionalProperties: false,
    },
  },
});

console.log(result.merged); // e.g. { city: "Paris", country: "France" }
console.log(result.agreement.overall); // 0–1: how much the models agreed
console.log(result.agreement.byField); // e.g. { city: 1, country: 0.67 }
```

→ [Ensemble details](./docs/strategies.md#ensemble)

### Broadcast

The simplest strategy: send the prompt to every participant in parallel and get
**all** of their answers back, unchanged. No critique, synthesis, or vote — use
it to compare models side by side or drive your own selection over the raw
outputs.

```ts
const result = await registry.broadcast({
  messages: [{ role: "user", content: "Name a good book on databases." }],
  participants: ["anthropic", "openai", "google"],
});

for (const response of result.responses) {
  if (response.status === "ok")
    console.log(`${response.id}: ${response.result.text}`);
  else console.log(`${response.id} failed: ${response.error.message}`);
}
```

`BroadcastResult` has **no `text`** field — read `result.responses`.

→ [Broadcast details](./docs/strategies.md#broadcast)

### Panel

A role-based panel: each participant answers through its own `instruction` (a
role/persona), then one participant **integrates** the perspectives into a single
answer. The diversity comes from the instruction, so you can run the **same model
several times** as different experts.

```ts
const result = await registry.panel({
  messages: [{ role: "user", content: "Should we migrate to microservices?" }],
  participants: [
    {
      provider: "openai",
      label: "architect",
      instruction:
        "You are a systems architect. Focus on scalability and coupling.",
    },
    {
      provider: "openai",
      label: "sre",
      instruction: "You are an SRE. Focus on operability and failure modes.",
    },
  ],
  synthesizer: "architect", // integrates the perspectives; defaults to the first participant
  crossExamine: true, // optional: each role reviews the others before synthesis (default false)
});

console.log(result.text); // the integrated answer
result.answers; // each role's raw answer (participant order)
```

→ [Panel details](./docs/strategies.md#panel)

### Reading results

Every outcome carries both an `id` (the participant label) and `provider` (the
actual provider it ran on); `result.usage` aggregates token usage across **every**
model call the run made. `text` is present on every strategy **except** broadcast.

**Partial failures are tolerated.** A participant that errors — or returns empty/
invalid output — is recorded in the result and dropped from the rest of the round;
the run proceeds with the survivors and throws only when too few remain. `combine()`
also validates the request up front (participants, unique ids, non-empty messages,
`responseFormat` for ensemble, …).

For the full result-narrowing guide, per-participant models, progress events, and
the optional **semantic-agreement** signals (`embedding` option), see
[Combine strategies](./docs/strategies.md). To price a run or cap its spend, see
[`combineCost` and budgets](./docs/cost-and-caching.md#combine-cost--budgets).

## Single-provider usage

The same registry talks to one provider at a time. Every provider implements one
contract, so the calling code is identical whichever you pick. The concrete
provider classes are intentionally not exported — you never construct them
yourself.

```ts
const provider = registry.select("anthropic"); // throws if not configured

// Non-streaming: get the full response text.
const result = await provider.complete({
  messages: [{ role: "user", content: "Say hello in one short sentence." }],
});
console.log(result.text, result.model);

// Streaming: consume text deltas as they arrive.
for await (const delta of provider.stream({
  messages: [{ role: "user", content: "Count to five." }],
})) {
  process.stdout.write(delta);
}
```

You can also inspect what's configured — `registry.has("openai")` and
`registry.names()`.

### Provider configuration

Pass an entry for each provider you want; omit one to leave it out.

```ts
new ProviderRegistry({
  anthropic: {
    apiKey: "sk-ant-...", // required
    model: "claude-opus-4-8", // optional; default
    baseUrl: "https://api.anthropic.com", // optional; default
    retry: { maxRetries: 2, baseDelayMs: 500 }, // optional; defaults
  },
  openai: {
    apiKey: "sk-...",
    model: "gpt-5.6-terra", // optional; default
    headers: { "x-trace": "..." }, // optional; merged into every request
  },
  google: {
    apiKey: "...",
    model: "gemini-3.5-flash", // optional; default
  },
});
```

### Custom & gateway providers

Beyond the three built-ins you can register extra providers under names you
choose, via a `custom` map:

- **`openai-compatible`** — point the OpenAI provider at any Chat Completions
  endpoint (OpenRouter, Together, Groq, Ollama, a local server, …). `baseUrl`
  (excluding the request path) and `model` are required; `headers`/`retry` optional.
- **`provider`** — bring your own object implementing the `Provider` interface.

```ts
const registry = new ProviderRegistry({
  anthropic: { apiKey: "sk-ant-..." },
  custom: {
    groq: {
      kind: "openai-compatible",
      apiKey: process.env.GROQ_API_KEY!,
      baseUrl: "https://api.groq.com/openai",
      model: "llama-3.3-70b-versatile",
    },
    mine: { kind: "provider", provider: myProviderInstance },
  },
});

registry.select("groq"); // a normal Provider
registry.combine({ participants: ["anthropic", "groq"], messages }); // mix freely
```

A custom name that collides with a built-in throws at construction. Custom
providers work everywhere a built-in does.

For **request/result fields, structured output, tool calling, multimodal input,
and embeddings**, see the [Single-provider reference](./docs/single-provider.md).

## Reference documentation

Deep-dive pages under [`docs/`](./docs/):

- **[Combine strategies](./docs/strategies.md)** — per-strategy behavior, semantic
  comparison, per-participant models, reading results, and progress events.
- **[Single-provider reference](./docs/single-provider.md)** — request/result
  fields, structured output, tool calling, multimodal input, embeddings.
- **[Cost, pricing & caching](./docs/cost-and-caching.md)** — `costOf`,
  `combineCost`, budgets, and Anthropic prompt caching.
- **[Errors, retries & fallback](./docs/errors-retries-fallback.md)** —
  `ProviderError`, retry/timeout behavior, and fallback chains.
- **[Testing](./docs/testing.md)** — the network-free `MockProvider` on the
  `combined-ai/test` subpath.

## Public API

Exported from the package entry point:

- `ProviderRegistry` — the single entry point: `select()`, `has()`, `names()`,
  `fallback()`, the strategy dispatcher `combine()`, the per-strategy methods
  `consensus()`, `pipeline()`, `ensemble()`, `broadcast()`, `panel()`, and the
  embedding methods `embed()` / `embedMany()`.
- Config types: `ProviderRegistryConfig`, `ProviderName`, `BuiltInProviderName`,
  `CustomProviderConfig`, `CustomProviderInstance`, `OpenAICompatibleConfig`,
  `AnthropicProviderOptions`, `OpenAIProviderOptions`, `GoogleProviderOptions`,
  `RetryOptions`.
- Contract types: `Provider`, `Message`, `Role`, `ContentPart`, `TextPart`,
  `ImagePart`, `FilePart`, `MediaSource`, `ToolUsePart`, `ToolResultPart`,
  `CompletionRequest`, `CompletionResult`, `ResponseFormat`, `ToolDefinition`,
  `ToolChoice`, `ToolCall`, `FinishReason`, `Usage`, `CacheControl`,
  `SystemPrompt`, `EmbeddingRequest`, `EmbeddingOptions`, `EmbeddingResult`.
- Combine request types: `CombineRequest` (the dispatcher's broad type),
  `CombineRequestBase`, and the per-strategy `ConsensusRequest`,
  `PipelineRequest`, `EnsembleRequest` (`responseFormat` required),
  `BroadcastRequest`, `PanelRequest`; plus `ParticipantSpec`.
- Combine result types: `CombineResult` (= `ConsensusResult` | `PipelineResult` |
  `EnsembleResult` | `BroadcastResult` | `PanelResult`), `EnsembleAgreement`,
  `SemanticComparison`, `CombineUsage`, `CallUsage`, `ParticipantOutcome`,
  `StrategyName`, `CombineOptions`, `CombineBudget`, `CombineEmbedding`,
  `CombineEvent`, and the strategy-generic utilities `StrategyRequest<S>` /
  `ResultFor<S>`.
- `ProviderError` (a value — usable with `instanceof`) and `ProviderErrorKind`.
- Fallback types: `FallbackSpec`, `FallbackOptions`, `FallbackEvent`.
- Cost & pricing: `costOf`, `costOfUsage`, `combineCost`, `findModel`,
  `listModels`, `PRICING_VERIFIED_ON` (values) and `CostBreakdown`, `CombineCost`,
  `CostOptions`, `ModelInfo`, `ModelPricing` (types).
- Embeddings: `cosineSimilarity` (value).

The concrete provider classes (`AnthropicProvider`, `OpenAIProvider`,
`GoogleProvider`) are **not** exported — the registry constructs them internally.
The `combined-ai/test` subpath additionally exports `MockProvider` (plus
`MockProviderOptions`, `MockResponse`, `MockResponder`) and re-exports
`ProviderError` — see [Testing](./docs/testing.md).

## Roadmap

Planned, roughly in priority order (subject to change):

- **Token counting** before send.
- **Streaming in `combine`** — incremental progress across phases.
- **Standard Schema support** — pass Zod/Valibot/etc. for structured output, no
  added dependency.
- **Minority-veto consensus** policy.
- **More providers** — Amazon Bedrock; possibly Azure OpenAI. (OpenAI-compatible
  APIs are already supported via custom providers.)
- **Model capability metadata** — per-model `contextWindow`, `maxOutputTokens`,
  `supportsVision`, `supportsTools`.

## Contributing & development

Build/test/lint setup, the development loop, and the live integration-test gating
live in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Changelog

Notable changes are recorded in [CHANGELOG.md](./CHANGELOG.md), following the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## License

[MIT](./LICENSE) © Anders Jansson

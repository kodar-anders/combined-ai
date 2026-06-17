# combined-ai

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933.svg)](https://nodejs.org/)

**Multi-model consensus, pipeline, ensemble, and broadcast for TypeScript.**

Most AI libraries hand you one model at a time. combined-ai makes several models
**work together on a single prompt** — consensus, sequential refinement, a vote
on structured output, or a plain fan-out that returns every model's answer —
behind one tiny interface. Single-provider calls (`complete`/`stream`) are
included too.

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

## Contents

- [Why combine?](#why-combine)
- [Requirements](#requirements)
- [Installation](#installation)
- [Combining providers](#combining-providers)
  - [Consensus](#consensus)
  - [Pipeline](#pipeline)
  - [Ensemble](#ensemble)
  - [Broadcast](#broadcast)
  - [Per-participant models](#per-participant-models)
  - [Reading the result](#reading-the-result)
  - [Progress events](#progress-events)
- [Single-provider usage](#single-provider-usage)
  - [Provider configuration](#provider-configuration)
  - [Custom & gateway providers](#custom--gateway-providers)
  - [Request options](#request-options)
  - [Result fields](#result-fields)
  - [Cost & pricing](#cost--pricing)
  - [Structured output](#structured-output)
  - [Tool calling](#tool-calling)
  - [Multimodal input](#multimodal-input)
  - [Error handling](#error-handling)
  - [Retries & cancellation](#retries--cancellation)
- [Public API](#public-api)
- [Development](#development)
- [Changelog](#changelog)
- [License](#license)

## Why combine?

A single model gives you one answer with no second opinion. combined-ai runs
several models on the same prompt, with four strategies for four shapes of
problem:

| Strategy      | Shape                                         | Use it when…                                                    |
| ------------- | --------------------------------------------- | --------------------------------------------------------------- |
| `"consensus"` | draft → critique → synthesize                 | you want one well-reasoned answer that survived peer review.    |
| `"pipeline"`  | sequential refinement (a conveyor belt)       | each model should improve the previous one's answer in turn.    |
| `"ensemble"`  | parallel structured answers → field-wise vote | you need extraction/classification **with a confidence score**. |
| `"broadcast"` | parallel fan-out, every raw answer returned   | you want each model's answer side by side, with no combining.   |

All four share one interface: configure a `ProviderRegistry`, then call
`registry.combine({ participants, messages, strategy })`. Participants can be
different providers, or the **same provider with different models**.

## Requirements

- Node.js ≥ 20 (uses the global `fetch`, `ReadableStream`, `TextDecoder`).

## Installation

```bash
npm install combined-ai
# or: yarn add combined-ai / pnpm add combined-ai
```

The published package is dual ESM + CJS with TypeScript types — any package
manager works as a consumer. (This repo uses Yarn 4 with Plug'n'Play for
development only; see [Development](#development).)

The library never reads environment variables — you always pass API keys in
explicitly via the registry config.

## Combining providers

```ts
const registry = new ProviderRegistry({
  anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
  openai: { apiKey: process.env.OPENAI_API_KEY! },
  google: { apiKey: process.env.GEMINI_API_KEY! },
});

const result = await registry.combine({
  messages: [{ role: "user", content: "Design a rate limiter." }],
  participants: ["anthropic", "openai", "google"],
  strategy: "consensus", // optional; default
});
```

`combine()` accepts the same request fields as `complete()` (`messages`,
`system`, `model`, `maxTokens`, `signal`) — they apply to every participant
unless a participant overrides them — plus:

| Field             | Type                                                           | Notes                                                                                      |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `participants`    | `ParticipantSpec[]`                                            | Required, non-empty. A bare `ProviderName`, or `{ provider, model?, maxTokens?, label? }`. |
| `strategy`        | `"consensus"` \| `"pipeline"` \| `"ensemble"` \| `"broadcast"` | Optional. Defaults to `"consensus"`.                                                       |
| `synthesizer`     | `string` (participant id)                                      | _Consensus only._ Who writes the final answer. Defaults to the first participant.          |
| `attribution`     | `"attributed"` \| `"anonymized"`                               | _Consensus only._ Default `"anonymized"` (Answer A/B/C) reduces bias.                      |
| `minParticipants` | `number`                                                       | _Consensus only._ Minimum drafts required to proceed (default 2).                          |
| `responseFormat`  | `ResponseFormat`                                               | _Ensemble only (required there)._ The shared JSON Schema every model answers under.        |

**Two ways to call it.** When you know the strategy at the call site, prefer the
per-strategy method — `registry.consensus(req)`, `.pipeline(req)`,
`.ensemble(req)`, `.broadcast(req)` — each takes that strategy's request type and
returns its **concrete** result (`ConsensusResult`, `PipelineResult`, …), so you
never narrow a union. `registry.combine(request)` is the dispatcher and is generic over the strategy:
pass a literal `strategy` and it returns that strategy's concrete result; pass a
`strategy` only known at runtime and it returns the full `CombineResult` union to
narrow. The two share one engine and the same validation. See
[Reading the result](#reading-the-result).

### Consensus

The default. Best when you want a single, well-reasoned answer that has been
checked by other models.

1. **Draft** — every participant answers the prompt in parallel.
2. **Critique** — every participant sees all drafts and critiques them, arguing
   for the best one and ending with a structured verdict.
3. **Synthesize** — the _synthesizer_ reads the drafts and critiques and writes
   the single final answer.

```ts
const result = await registry.combine({
  messages: [{ role: "user", content: "Design a rate limiter." }],
  participants: ["anthropic", "openai", "google"],
  synthesizer: "anthropic", // optional; defaults to the first participant
});

console.log(result.text); // the final synthesized answer
```

Behavior worth knowing:

- **Anonymized by default.** Critics and the synthesizer see `Answer A`/`B`/`C`
  rather than model names, to neutralize brand and self-preference bias (pass
  `attribution: "attributed"` to opt out). The result still records each
  outcome's `id` and `provider`.
- **Correctness over popularity.** The synthesizer is told to adopt a lone
  correct answer rather than average it away, not to favor its own (anonymized)
  draft, and to flag genuine disagreement instead of papering over it. The final
  answer is written fresh — it never alludes to the drafts, critiques, or
  internal labels (a final sanitizing pass strips any leftover meta-commentary).
- **Lean inter-model messages.** The draft and critique text passed between
  models drops greetings and filler but keeps reasoning and caveats, so critics
  can check the _why_. The user-facing synthesis is unconstrained.
- **A single participant** with a successful draft degrades to a plain completion
  (no critique/synthesis); if that lone draft fails or is empty, the run throws.

### Pipeline

A conveyor belt: each participant refines the previous one's answer, in
**participant order**. The first writes an initial answer; each subsequent stage
gets the question plus the running answer and improves it; the **last stage to
produce an answer wins**.

```ts
const result = await registry.combine({
  messages: [{ role: "user", content: "Design a rate limiter." }],
  participants: ["anthropic", "openai", "google"], // the conveyor order
  strategy: "pipeline",
});

console.log(result.text); // the final, refined answer
console.log(result.finalParticipant); // id of the last stage that produced one
```

- **Refiners preserve, not rewrite.** Each stage treats the current answer as a
  strong baseline — fix errors, fill gaps, sharpen wording, but keep what's
  correct (there's no downstream synthesizer to catch a regression).
- **The final answer is sanitized** when a refining stage actually changed it, to
  strip "I improved the previous answer…" narration. A first-stage answer or an
  unchanged passthrough is returned as-is (no wasted call).
- `synthesizer`, `attribution`, and `minParticipants` are consensus-specific and
  ignored here.

### Ensemble

A multi-model vote on **structured output** — the thing one provider can't give
you. Every participant answers the prompt independently under the same JSON
Schema, the typed objects are merged **mechanically** (no model adjudicates), and
you get an **agreement score** telling you how strongly the models concurred.

```ts
const result = await registry.combine({
  messages: [{ role: "user", content: "Extract the city and country: ..." }],
  participants: ["anthropic", "openai", "google"],
  strategy: "ensemble",
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

How the merge works (field-wise over the union of top-level keys):

- **Every field is a majority vote** — the most common value by deep equality,
  ties broken by participant order. The merged value is always one a model
  actually returned (never synthesized or averaged), so it stays within the
  schema's types.
- **Agreement** per field is the share of **all** valid responses that voted for
  the merged value; `overall` is the mean across fields. A field most models
  omitted scores low — a low score flags it for review.

Notes:

- **`responseFormat` is required** for ensemble and **rejected** for the other
  strategies. Its schema must have an **object** root (the field-wise vote needs
  named fields).
- **The merge is shallow** — nested objects/arrays are voted on as whole values.
  Keep schemas to flat fields for the most useful per-field agreement.

### Broadcast

The simplest strategy: send the prompt to every participant **in parallel** and
get **all** of their answers back, unchanged. There is no critique, synthesis, or
vote — broadcast deliberately does **not** combine. Use it to compare models side
by side, or to drive your own selection/UI over the raw outputs.

```ts
const result = await registry.combine({
  messages: [{ role: "user", content: "Name a good book on databases." }],
  participants: ["anthropic", "openai", "google"],
  strategy: "broadcast",
});

for (const response of result.responses) {
  if (response.status === "ok") {
    console.log(`${response.id}: ${response.result.text}`);
  } else {
    console.log(`${response.id} failed: ${response.error.message}`);
  }
}
```

- **No single answer**, so `BroadcastResult` has **no `text`** field — read
  `result.responses` (one outcome per participant, in participant order).
- **Each model answers the raw prompt** (no shaped framing) — you get the
  unmodified per-model reply.
- **Fails only when every participant fails**; one or more failures are recorded
  in `responses` and the run still returns the successes. An empty-text answer
  still counts as a success (broadcast returns what each model gave back).
- **No structured output:** `responseFormat` is rejected (it's the
  [ensemble](#ensemble) strategy's job); `synthesizer`, `attribution`, and
  `minParticipants` are consensus-specific and ignored.

### Per-participant models

Each participant is identified by an **id** (its label). A bare provider name has
an id equal to the provider name; the object form derives `<provider>-<model>`
when you set a model (or set `label` yourself). This lets one combine mix cheap
drafters with a strong synthesizer — and even run the **same provider twice**
with different models:

```ts
await registry.combine({
  messages,
  participants: [
    { provider: "google", model: "gemini-2.5-flash" }, // id "google-gemini-2.5-flash"
    { provider: "openai", model: "gpt-4.1-mini" }, //     id "openai-gpt-4.1-mini"
    { provider: "openai", model: "gpt-4.1" }, //          id "openai-gpt-4.1" (same provider, different model)
    { provider: "anthropic" }, //                         id "anthropic" (default model)
  ],
  synthesizer: "anthropic", // a strong model adjudicates the cheap drafts
});
```

Two participants that resolve to the same id are rejected unless you give one an
explicit `label`. A participant's `model`/`maxTokens` take precedence over the
request-wide values.

### Reading the result

Every outcome carries both an `id` (the participant label) and `provider` (the
actual provider it ran on); `usage` is aggregated across **every** model call the
run made (the true multi-call cost), keyed by `id`.

If you call a per-strategy method, the result type is already concrete — no
narrowing:

```ts
const result = await registry.pipeline({ messages, participants });
result.finalParticipant; // typed PipelineResult — `stages`, `text`, … all in scope
```

`combine()` with a **literal** `strategy` is just as precise (it's generic over
the strategy, inferring the result type from `strategy`). You only narrow when the
strategy is dynamic, in which case `combine()` returns the `CombineResult` union
discriminated on `strategy`:

```ts
const strategy = pickStrategyAtRuntime(); // : StrategyName
const result = await registry.combine({ messages, participants, strategy });

result.usage; // { total, byParticipant } — aggregated token usage, or undefined

if (result.strategy === "consensus") {
  result.text; // the final synthesized answer
  result.synthesizer; // id of the participant that wrote the final answer
  result.drafts; // each participant's first-pass answer (has .id, .provider)
  result.critiques; // each participant's critique
} else if (result.strategy === "pipeline") {
  result.text; // the final, refined answer
  result.finalParticipant; // id of the last stage that produced an answer
  result.stages; // each stage in conveyor order (ok/failed)
} else if (result.strategy === "ensemble") {
  result.text; // the merged object serialized as JSON
  result.merged; // the voted object
  result.agreement; // { overall, byField }
  result.responses; // each participant's structured answer (ok/failed)
} else if (result.strategy === "broadcast") {
  // No `text` — broadcast returns every raw answer, not one combined answer.
  result.responses; // each participant's raw answer in order (ok/failed)
}
```

`text` is present on every strategy **except** `broadcast` (which has no single
answer), so narrow on `result.strategy` before reading it.

**Partial failures are tolerated.** A participant that errors — or succeeds but
returns empty/invalid output — is recorded in the result and dropped from the
rest of the round; the run proceeds with the survivors. It throws only when too
few survive: consensus needs `minParticipants` drafts, pipeline needs at least
one advancing stage, ensemble needs at least one valid object, and broadcast needs
at least one participant to succeed. `combine()` also
validates the request up front and throws on bad input (no participants,
duplicate ids, empty `messages`, an out-of-range `minParticipants`, a
`synthesizer` that isn't a participant id, an unknown `strategy`, or a missing /
non-object `responseFormat` for ensemble).

### Progress events

`combine()` takes an optional second argument with an `onEvent` callback that
fires as the run progresses — handy for a status display. Events are status only
(no token streaming); the answer is still the resolved
result.

```ts
await registry.combine(
  { messages, participants: ["anthropic", "openai"] },
  {
    onEvent: (event) => {
      switch (event.type) {
        case "phase":
          console.log(`→ ${event.phase}`); // consensus phase boundary
          break;
        case "draft":
        case "critique": // consensus
        case "stage": // pipeline (has .index)
        case "response": // ensemble, broadcast
          console.log(`  ${event.provider}: ${event.status}`); // "ok" | "failed"
          break;
      }
    },
  },
);
```

Errors thrown from `onEvent` are swallowed so a listener can't break the run, and
there is no terminal event (the result is the return value).

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

You can also inspect what's configured:

```ts
registry.has("openai"); // -> false if not configured
registry.names(); // -> the configured provider names
registry.select("openai"); // -> throws: No provider "openai" configured. Configured: anthropic
```

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
    model: "gpt-4.1", // optional; default
    headers: { "x-trace": "..." }, // optional; merged into every request
  },
  google: {
    apiKey: "...",
    model: "gemini-2.5-pro", // optional; default
  },
});
```

### Custom & gateway providers

Beyond the three built-ins you can register extra providers under names you
choose, via a `custom` map. Two forms:

- **`openai-compatible`** — point the OpenAI provider at any Chat Completions
  endpoint (OpenRouter, Together, Groq, Ollama, a local server, …). `baseUrl`
  (excluding the `/v1/chat/completions` path) and `model` are required; `headers`
  and `retry` are optional.
- **`provider`** — bring your own object implementing the `Provider` interface,
  for an API the library doesn't speak natively or to wrap one with
  instrumentation.

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

A custom name that collides with a built-in (`anthropic`/`openai`/`google`)
throws at construction. Custom providers work everywhere a built-in does —
`select()`, `combine()` participants, and results.

### Request options

Both `complete()` and `stream()` (and `combine()`) take a `CompletionRequest`:

| Field            | Type               | Notes                                                                                          |
| ---------------- | ------------------ | ---------------------------------------------------------------------------------------------- |
| `messages`       | `Message[]`        | Required. `{ role: "user" \| "assistant"; content: string \| ContentPart[] }`                  |
| `system`         | `string`           | Optional system prompt.                                                                        |
| `model`          | `string`           | Optional per-request model override.                                                           |
| `maxTokens`      | `number`           | Optional output cap (defaults: 16000 complete / 64000 stream).                                 |
| `responseFormat` | `ResponseFormat`   | Optional. Constrain the output to a JSON Schema — see [Structured output](#structured-output). |
| `tools`          | `ToolDefinition[]` | Optional. Tools the model may call — see [Tool calling](#tool-calling).                        |
| `toolChoice`     | `ToolChoice`       | Optional. `"auto" \| "any" \| "none" \| { name }`.                                             |
| `signal`         | `AbortSignal`      | Optional. Aborts the request (and an in-flight `stream()` read) when it fires.                 |

> **Gemini note:** Gemini 2.5 models are _thinking_ models, and their internal
> thinking tokens count against `maxTokens`. A very small cap can be consumed
> entirely by thinking, leaving the visible answer empty or truncated — give
> Gemini ample headroom (`gemini-2.5-pro` can't fully disable thinking).

### Result fields

`complete()` resolves to a `CompletionResult`:

| Field             | Type           | Notes                                                                                              |
| ----------------- | -------------- | -------------------------------------------------------------------------------------------------- |
| `text`            | `string`       | The full answer.                                                                                   |
| `model`           | `string`       | The model that actually produced the response.                                                     |
| `finishReason`    | `FinishReason` | Normalized stop reason: `"stop"` \| `"length"` \| `"content_filter"` \| `"tool_use"` \| `"other"`. |
| `rawFinishReason` | `string`       | The provider's exact stop-reason string.                                                           |
| `refusal`         | `string`       | The refusal message when the model declined.                                                       |
| `usage`           | `Usage`        | Token usage (`inputTokens`/`outputTokens`/`totalTokens`), or `undefined` if none reported.         |
| `parsed`          | `unknown`      | The parsed structured output when `responseFormat` was given.                                      |
| `toolCalls`       | `ToolCall[]`   | The tool calls the model requested, when it called any.                                            |

`finishReason` lets you tell a truncated/refused answer apart from a genuinely
empty one instead of just seeing `text: ""`. A `"length"` reason with empty
`text` on Gemini usually means the cap was spent on thinking tokens. `refusal` is
populated by OpenAI and Anthropic, and a set `refusal` always pairs with
`"content_filter"`; Gemini has no refusal-text field, so it signals a refusal via
`finishReason: "content_filter"` alone (the block reason lands in
`rawFinishReason`).

```ts
const { text, finishReason, refusal } = await provider.complete({ messages });
if (finishReason === "length") {
  // raise maxTokens and retry
} else if (refusal !== undefined) {
  console.warn(`Model declined: ${refusal}`);
}
```

### Cost & pricing

`costOf(result)` turns the token `usage` a completion reports into a dollar
`CostBreakdown`, using a tiny built-in pricing registry:

```ts
import { costOf } from "combined-ai";

const result = await registry.select("anthropic").complete({ messages });
const cost = costOf(result);
// → { model: "claude-opus-4-8", inputCost, outputCost, totalCost } | undefined
if (cost) console.log(`$${cost.totalCost.toFixed(4)}`);
```

It returns `undefined` (never throws) when the model isn't in the registry or the
result carries no `usage` — both normal for custom/gateway providers. `costOfUsage(usage, model)`
is the same calculation from a raw `Usage` + model id.

The registry resolves dated snapshots and Gemini `modelVersion` strings to their
base entry (e.g. `gpt-4.1-2025-04-14` → `gpt-4.1`), and bills Gemini thinking
tokens at the output rate. Costs are raw floating-point USD — round at display.

**Prices are best-effort and hand-maintained** (a small table of the most common
models across the three providers, not an exhaustive catalog), dated by
`PRICING_VERIFIED_ON`. Correct a stale price or add your own model with
`options.models` — no library release needed:

```ts
costOf(result, {
  models: { "my-model": { inputPerMTok: 0.5, outputPerMTok: 1.5 } },
});
```

`findModel(id)` and `listModels()` expose the registry directly.

### Structured output

Pass `responseFormat` with a **plain JSON Schema** (no Zod, no runtime
dependency) to constrain a single provider's output. The model returns JSON in
`text`, and `complete()` also gives you the parsed value on `result.parsed`:

```ts
const result = await registry.select("openai").complete({
  messages: [{ role: "user", content: "Where is the Eiffel Tower?" }],
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

const place = result.parsed as { city: string; country: string };
// result.parsed is `undefined` if the output wasn't valid JSON; raw is in result.text.
```

Each provider maps the schema to its native mechanism. For one schema to work
across all three, keep it simple: every object sets `additionalProperties: false`
and every property is `required` with a single non-null `type`. Avoid
optional/nullable fields, recursive schemas, `$ref`, and numeric/length
constraints. (The [ensemble](#ensemble) strategy uses this same field across
multiple models.)

### Tool calling

Declare `tools` and the model can ask to call them. When it does, `complete()`
returns `result.toolCalls` (and `finishReason === "tool_use"`); you run the tools
and feed the results back by appending the call and its result to the
conversation, then call again. You own the loop.

```ts
const provider = registry.select("anthropic");
const tools = [
  {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
  },
];

const messages = [{ role: "user", content: "What's the weather in Paris?" }];
const first = await provider.complete({ messages, tools });

if (first.toolCalls) {
  messages.push({
    role: "assistant",
    content: first.toolCalls.map((call) => ({ type: "tool_use", ...call })),
  });
  messages.push({
    role: "user",
    content: first.toolCalls.map((call) => ({
      type: "tool_result",
      toolUseId: call.id,
      name: call.name, // Gemini matches results by name
      content: runTool(call.name, call.input), // your code; returns a string
    })),
  });

  const final = await provider.complete({ messages, tools });
  console.log(final.text);
}
```

- **`input` is always a parsed object** (OpenAI's JSON-string arguments are
  parsed for you).
- **Set both `toolUseId` and `name`** on a tool result for portability — OpenAI
  matches by id, Gemini by name (each throws if its key is missing).
- **`complete()`-only**, and intentionally **not** part of `combine()` (a
  multi-model tool loop has no coherent shared state) — use `select()` for it.

### Multimodal input

A message's `content` can be a `ContentPart[]` carrying images and documents
(PDFs) alongside text, as base64 bytes or a URL:

```ts
await registry.select("anthropic").complete({
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What's in this image?" },
        {
          type: "image",
          source: { kind: "base64", mediaType: "image/png", data: pngBase64 },
        },
      ],
    },
  ],
});
```

A `ContentPart` is a `TextPart`, `ImagePart`, or `FilePart`; `source` is either
`{ kind: "base64"; mediaType; data }` or `{ kind: "url"; url; mediaType? }`.
Provider support varies — OpenAI's Chat Completions has no URL file source, and
Gemini resolves a URL only from a Files API / `gs://` URI — so prefer base64 for
portability. The mapper throws on an unsupported combination.

### Error handling

A failed call rejects (`complete()`) or throws on the first iteration
(`stream()`) with a `ProviderError` — branch on its fields rather than the
message string:

| Field      | Type                     | Notes                                                                               |
| ---------- | ------------------------ | ----------------------------------------------------------------------------------- |
| `kind`     | `"api"` \| `"transport"` | `"api"` = the provider returned an error; `"transport"` = the request never landed. |
| `provider` | `ProviderName`           | Which provider failed.                                                              |
| `status`   | `number \| undefined`    | HTTP status for `kind: "api"`; `undefined` for transport failures.                  |
| `code`     | `string \| undefined`    | Machine code from the body, where the provider sends one.                           |
| `type`     | `string \| undefined`    | Error category from the body.                                                       |
| `body`     | `string \| undefined`    | The raw error body, for `kind: "api"`.                                              |
| `cause`    | `unknown`                | The underlying `fetch` rejection, for `kind: "transport"`.                          |

```ts
import { ProviderError } from "combined-ai";

try {
  const result = await provider.complete({ messages });
} catch (err) {
  if (err instanceof ProviderError) {
    if (err.status === 401) throw err; // bad key — unrecoverable
    if (err.kind === "transport") {
      /* never reached the provider */
    }
  }
  throw err;
}
```

`complete()` also throws (`kind: "api"`, `status: 200`) if a provider or proxy
returns HTTP 200 with an `{ error }` body, rather than yielding a silently empty
result. For `combine()`, individual provider failures are recorded rather than
thrown — see [Reading the result](#reading-the-result).

### Retries & cancellation

Each provider automatically retries the routine retryable statuses — **429**,
**503**, and **529** — with bounded exponential backoff (honoring `Retry-After`),
for both `complete()` and `stream()`. Transport failures are **not** retried.
Configure per provider with `retry` (defaults: 2 retries, 500ms base); set
`maxRetries: 0` to disable.

```ts
new ProviderRegistry({
  anthropic: { apiKey: key, retry: { maxRetries: 4, baseDelayMs: 1000 } },
  openai: { apiKey: key, retry: { maxRetries: 0 } }, // no retry
});
```

Pass a `signal` to bound or cancel a call. For a timeout use
`AbortSignal.timeout(ms)`; to cancel manually use an `AbortController`. An aborted
call rejects with a transport `ProviderError` whose `cause` is the abort reason.
The backoff respects the signal too, and `combine()` threads one signal into
every participant call, so aborting it cancels the whole run.

```ts
await provider.complete({ messages, signal: AbortSignal.timeout(30_000) });
```

## Public API

Exported from the package entry point:

- `ProviderRegistry` — the single entry point: `select()`, the strategy
  dispatcher `combine()`, and the per-strategy methods `consensus()`,
  `pipeline()`, `ensemble()`, `broadcast()`.
- Config types: `ProviderRegistryConfig`, `ProviderName`, `BuiltInProviderName`,
  `CustomProviderConfig`, `CustomProviderInstance`, `OpenAICompatibleConfig`,
  `AnthropicProviderOptions`, `OpenAIProviderOptions`, `GoogleProviderOptions`,
  `RetryOptions`.
- Contract types: `Provider`, `Message`, `Role`, `ContentPart`, `TextPart`,
  `ImagePart`, `FilePart`, `MediaSource`, `ToolUsePart`, `ToolResultPart`,
  `CompletionRequest`, `CompletionResult`, `ResponseFormat`, `ToolDefinition`,
  `ToolChoice`, `ToolCall`, `FinishReason`, `Usage`.
- Combine request types: `CombineRequest` (the dispatcher's broad type),
  `CombineRequestBase`, and the per-strategy `ConsensusRequest`,
  `PipelineRequest`, `EnsembleRequest` (`responseFormat` required),
  `BroadcastRequest`; plus `ParticipantSpec`.
- Combine result types: `CombineResult` (= `ConsensusResult` | `PipelineResult` |
  `EnsembleResult` | `BroadcastResult`), `EnsembleAgreement`, `CombineUsage`,
  `ParticipantOutcome`, `StrategyName`, `CombineOptions`, `CombineEvent`, and the
  strategy-generic utilities `StrategyRequest<S>` / `ResultFor<S>`.
- `ProviderError` (a value — usable with `instanceof`) and `ProviderErrorKind`.
- Cost & pricing: `costOf`, `costOfUsage`, `findModel`, `listModels`,
  `PRICING_VERIFIED_ON` (values) and `CostBreakdown`, `CostOptions`, `ModelInfo`,
  `ModelPricing` (types).

The concrete provider classes (`AnthropicProvider`, `OpenAIProvider`,
`GoogleProvider`) are **not** exported — the registry constructs them internally.

## Development

Uses **Yarn 4 (Plug'n'Play)** — always use `yarn`, never `npm`, for local work.

```bash
yarn build              # bundle to dist/ (ESM + CJS + types) via tsup
yarn typecheck          # tsc --noEmit
yarn test               # Jest (mocked unit tests; never makes network calls)
yarn test:integration   # live API tests — see below
yarn lint               # ESLint
yarn format             # Prettier --write
```

### Live integration tests

`yarn test:integration` runs tests against the real provider APIs. They are
double-gated and skipped by default — each provider's suite runs only when both
`RUN_LIVE_TESTS=1` (set by the script) and that provider's key are present
(`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`). To enable them:

```bash
cp .env.example .env
# edit .env and set your key(s)
yarn test:integration                       # all integration tests
yarn test:integration openai.integration     # just one provider's suite
yarn test:integration consensus.integration  # a combine suite (needs all three keys)
```

The combine suites (`consensus.integration`, `pipeline.integration`,
`ensemble.integration`, `broadcast.integration`) are **triple-gated** on all
three keys, since they exercise the full multi-model flow. Live tests use cheap models and a small token
cap, so cost is negligible. `.env` is gitignored and loaded automatically.

## Roadmap

Planned, roughly in priority order (subject to change):

- **Combine budgets** — per-combine cost totals (`combineCost`, pricing each participant's calls) and an optional budget cap that aborts remaining participants when exceeded.
- **Prompt caching** — surface provider-native prompt caching and cached-token usage, with cached reads priced at the discounted rate in `costOf`.
- **Embeddings** — unified `embed` / `embedMany` (plus `cosineSimilarity`).
- **Test utilities** — a public `MockProvider` with simulated streaming.
- **Fallback chains** — try the next provider on failure.
- **Per-request retry & timeout** overrides.
- **Token counting** before send.
- **Streaming in `combine`** — incremental progress across phases.
- **Standard Schema support** — pass Zod/Valibot/etc. for structured output, no added dependency.
- **Minority-veto consensus** policy.
- **More providers** — Amazon Bedrock (distinct API, enterprise reach); possibly Azure OpenAI. (OpenAI-compatible APIs are already supported via custom providers.)
- **Model capability metadata** — extend the registry with per-model `contextWindow`, `maxOutputTokens`, `supportsVision`, `supportsTools`.

## Changelog

Notable changes are recorded in [CHANGELOG.md](./CHANGELOG.md), following the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## License

[MIT](./LICENSE) © Anders Jansson
</content>
</invoke>

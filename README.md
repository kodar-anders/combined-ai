# combined-ai

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933.svg)](https://nodejs.org/)

A small TypeScript library that combines several AI providers behind one
interface. It lets you talk to a provider through a single, consistent contract
today, and is being built toward **combining multiple providers on one prompt**.

> **Status: early.** The core abstraction and three providers (Anthropic /
> Claude, OpenAI, and Google Gemini) are in place, with completion and streaming,
> plus a registry to select a provider by name. Multi-provider combination has
> landed with three strategies, **consensus**, **pipeline**, and **ensemble** —
> see [Combining providers](#combining-providers) and [Roadmap](#roadmap).

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
  - [Provider configuration](#provider-configuration)
  - [Inspecting the registry](#inspecting-the-registry)
  - [Error handling](#error-handling)
  - [Retries](#retries)
  - [Combining providers](#combining-providers)
    - [Consensus](#consensus)
    - [Pipeline](#pipeline)
    - [Ensemble](#ensemble)
  - [Combine progress events](#combine-progress-events)
  - [Request options](#request-options)
- [Public API](#public-api)
- [Development](#development)
- [Roadmap](#roadmap)
- [Changelog](#changelog)
- [License](#license)

## Features

- One provider-agnostic contract (`Provider`) for every backend.
- `complete()` — run a prompt, get the full text back.
- `stream()` — run a prompt, receive text deltas as they arrive.
- Multimodal input — message content can carry images and documents (PDFs)
  alongside text, as base64 bytes or a URL, mapped to each provider's wire format.
- Structured output — constrain a response to a JSON Schema (`responseFormat`);
  the parsed object comes back on `result.parsed`. Plain JSON Schema, no Zod.
- **Anthropic (Claude)**, **OpenAI**, and **Google Gemini** providers, talking
  to their HTTP APIs directly over the global `fetch` — no SDK dependency.
- `ProviderRegistry` — a single point of access: configure your providers, then
  select one by name.
- Automatic retry with exponential backoff on 429/503/529 (honoring
  `Retry-After`), configurable per provider.
- `finishReason` on every `complete()` result — tells truncation/refusal apart
  from a genuinely empty answer instead of returning a bare `text: ""`.
- Token usage accounting — `usage` on every `complete()` result, and aggregated
  per-participant + total `usage` on a `combine()` result so you can see the
  several-times-one-call cost of a combine.
- `registry.combine()` — make several providers **cooperate** on one prompt
  using a strategy: **consensus** (draft → critique → synthesize), **pipeline**
  (a conveyor belt of providers refining one answer in sequence), or **ensemble**
  (every model answers under one JSON Schema, then a mechanical field-wise vote
  with an agreement score — multi-model structured extraction with confidence).
- Dual ESM + CJS package with TypeScript types.

## Requirements

- Node.js ≥ 20 (uses the global `fetch`, `ReadableStream`, `TextDecoder`).

## Installation

```bash
npm install combined-ai
# or
yarn add combined-ai
# or
pnpm add combined-ai
```

The published package is plain dual ESM + CJS in `dist/` — any package manager
works as a consumer. (This repo uses Yarn 4 with Plug'n'Play for **development
only**; you don't need it to install or use the library.)

## Usage

The library is a single point of access to its providers: you configure a
`ProviderRegistry` with the providers you want, then `select()` one by name. The
concrete provider classes are intentionally not exported — you never construct
them yourself.

The library never reads environment variables — you always pass the API keys in
explicitly via the config.

```ts
import { ProviderRegistry } from "combined-ai";

const registry = new ProviderRegistry({
  anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
  openai: { apiKey: process.env.OPENAI_API_KEY! },
  gemini: { apiKey: process.env.GEMINI_API_KEY! },
});

const provider = registry.select("anthropic"); // throws if not configured

// Non-streaming: get the full response text.
const result = await provider.complete({
  messages: [{ role: "user", content: "Say hello in one short sentence." }],
});
console.log(result.text); // -> "Hello! Nice to meet you."
console.log(result.model); // -> the model that produced the response

// Streaming: consume text deltas as they arrive.
for await (const delta of provider.stream({
  messages: [{ role: "user", content: "Count to five." }],
})) {
  process.stdout.write(delta);
}
```

Every provider returned by `select()` implements the same `Provider` contract,
so the calling code is identical no matter which one you pick.

### Provider configuration

Pass an entry for each provider you want to register. Omit a provider to leave
it out; `select()`/`has()` reflect only what you configured.

```ts
new ProviderRegistry({
  anthropic: {
    apiKey: "sk-ant-...", // required
    model: "claude-opus-4-8", // optional; this is the default
    baseUrl: "https://api.anthropic.com", // optional; this is the default
    retry: { maxRetries: 2, baseDelayMs: 500 }, // optional; these are the defaults
  },
  openai: {
    apiKey: "sk-...", // required
    model: "gpt-4.1", // optional; this is the default
    baseUrl: "https://api.openai.com", // optional; this is the default
  },
  gemini: {
    apiKey: "...", // required
    model: "gemini-2.5-pro", // optional; this is the default
    baseUrl: "https://generativelanguage.googleapis.com", // optional; this is the default
  },
});
```

### Inspecting the registry

```ts
const registry = new ProviderRegistry({ anthropic: { apiKey: key } });

registry.has("openai"); // -> false (not configured)
registry.names(); // -> the configured provider names, e.g. ["anthropic"]
registry.select("openai");
// throws: No provider "openai" configured. Configured: anthropic
```

`select()` only accepts a known provider name
(`"anthropic"` | `"openai"` | `"gemini"`), so typos are caught at compile time;
selecting a name you didn't configure throws at runtime.

### Error handling

A failed call rejects (for `complete()`) or throws when you start iterating (for
`stream()`) with a `ProviderError` — branch on its fields rather than matching
the message string:

| Field      | Type                     | Meaning                                                                                     |
| ---------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| `kind`     | `"api"` \| `"transport"` | `"api"` = the provider returned an error response; `"transport"` = the request never landed |
| `provider` | `"anthropic" \| …`       | Which provider failed.                                                                      |
| `status`   | `number \| undefined`    | HTTP status for `kind: "api"`; `undefined` for transport failures.                          |
| `code`     | `string \| undefined`    | Machine code from the body, where the provider sends one (e.g. `"invalid_api_key"`).        |
| `type`     | `string \| undefined`    | Error category from the body (Anthropic/OpenAI `type`, Gemini `status`).                    |
| `body`     | `string \| undefined`    | The raw error body, for `kind: "api"`.                                                      |
| `cause`    | `unknown`                | The underlying `fetch` rejection, for `kind: "transport"`.                                  |

```ts
import { ProviderError } from "combined-ai";

try {
  const result = await provider.complete({
    messages: [{ role: "user", content: "Hello." }],
  });
  console.log(result.text);
} catch (err) {
  if (err instanceof ProviderError) {
    if (err.status === 401) throw err; // bad key — unrecoverable
    if (err.kind === "transport") {
      // never reached the provider (network/DNS/abort)
    }
  }
  throw err;
}
```

Streaming throws the same `ProviderError` on the first iteration if the request
fails. `complete()` also throws a `ProviderError` (`kind: "api"`, `status: 200`)
if a provider or proxy returns HTTP 200 with an `{ error }` body, rather than
yielding a silently empty result.

For `combine()`, individual provider failures are tolerated rather than thrown —
each failed participant's `error` (a `ProviderError`) is recorded in the result;
see [the failure policy](#combining-providers) below.

### Retries

Each provider automatically retries the routine retryable statuses — **429**
(rate limit), **503** (unavailable), and **529** (Anthropic overloaded) — with
bounded exponential backoff, for both `complete()` and `stream()`. A
`Retry-After` response header is honored when present; otherwise the nth retry
waits `baseDelayMs * 2 ** n`. The backoff respects the request's `AbortSignal`,
so cancelling during a wait stops it. Transport failures (the request never
landed) are **not** retried.

Configure per provider with the `retry` option (defaults: 2 retries, 500ms
base); set `maxRetries: 0` to disable:

```ts
new ProviderRegistry({
  anthropic: { apiKey: key, retry: { maxRetries: 4, baseDelayMs: 1000 } },
  openai: { apiKey: key, retry: { maxRetries: 0 } }, // no retry
});
```

### Combining providers

Beyond selecting one provider, you can make several **cooperate** on a single
prompt with `registry.combine()`. Pick a strategy with `strategy` (defaults to
`"consensus"`):

| Strategy      | Shape                          | Final answer                        |
| ------------- | ------------------------------ | ----------------------------------- |
| `"consensus"` | draft → critique → synthesize  | written by the _synthesizer_        |
| `"pipeline"`  | sequential refinement (a belt) | the last stage to produce an answer |

`combine()` accepts the same `CompletionRequest` fields as `complete()`
(`messages`, `system`, `model`, `maxTokens`) — they apply to every participant —
plus:

| Field             | Type                             | Notes                                                                                                                                |
| ----------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `participants`    | `ProviderName[]`                 | Required. Must be configured, non-empty, and unique; validated like `select()`. For `pipeline`, the order is the conveyor order.     |
| `strategy`        | `"consensus"` \| `"pipeline"`    | Optional. Defaults to `"consensus"`.                                                                                                 |
| `synthesizer`     | `ProviderName`                   | _Consensus only._ Must be a participant. Defaults to the first. Ignored by `pipeline`.                                               |
| `attribution`     | `"attributed"` \| `"anonymized"` | _Consensus only._ Default `"anonymized"` (Answer A/B/C) reduces bias; `"attributed"` shows provider names. Ignored by `pipeline`.    |
| `minParticipants` | `number`                         | _Consensus only._ Minimum drafts required to proceed (default 2). A positive integer ≤ the participant count. Ignored by `pipeline`. |

`combine()` returns a `CombineResult` **discriminated on `strategy`** — narrow on
`result.strategy` to reach the strategy-specific fields:

```ts
const result = await registry.combine({ messages, participants });
if (result.strategy === "consensus") {
  result.synthesizer; // who wrote the final answer
  result.drafts; // each participant's first-pass answer (or failure)
  result.critiques; // each participant's critique (or failure)
} else {
  result.finalProvider; // the last stage that produced an answer
  result.stages; // each stage in conveyor order (or failure)
}
```

#### Consensus

The default strategy:

1. **Draft** — the prompt goes to every participant in parallel; each writes its
   own answer.
2. **Critique** — every participant sees all the drafts and critiques them,
   arguing for the best answer.
3. **Synthesize** — one participant (the _synthesizer_) reads all the drafts and
   critiques and writes the single final answer.

```ts
const result = await registry.combine({
  messages: [{ role: "user", content: "Design a rate limiter." }],
  participants: ["anthropic", "openai", "gemini"], // who takes part
  synthesizer: "anthropic", // optional; defaults to the first participant
  // strategy: "consensus",                          // optional; the default
  // attribution: "attributed",                     // optional; default "anonymized"
});

console.log(result.text); // the final synthesized answer
```

Behavior notes:

- **No token streaming, but live progress.** combine uses `complete()` under the
  hood, so the final answer isn't streamed token-by-token — but you can pass an
  `onEvent` callback for status updates as the run progresses (see
  [Combine progress events](#combine-progress-events)).
- **Inter-provider messages drop ceremony but keep reasoning.** The draft and
  critique phases — the text one provider passes to another — skip greetings,
  sign-offs, and preamble (saving tokens) while keeping their reasoning,
  assumptions, and caveats, so critics can check the _why_, not just the
  conclusion. The user-facing synthesis is not constrained.
- **Drafts are anonymized to the other providers by default.** Critics and the
  synthesizer see `Answer A`/`B`/`C` rather than provider names, to neutralize
  brand and self-preference bias (pass `attribution: "attributed"` to opt out).
  `result.drafts` / `result.critiques` always keep provider names.
- **Critics vote; the synthesizer adjudicates on correctness.** Each critique
  ends with a structured pick (best answer, key fix, confidence). The synthesizer
  is told to judge on correctness over popularity — adopting a lone correct
  answer rather than averaging it away — to not favor its own (anonymized) draft,
  and to flag genuinely unresolved disagreement instead of papering over it. The
  drafts and critiques are framed as private input material, so the final answer
  is written as if answering the user fresh — it never alludes to the drafts, the
  critiques, the selection process, or internal labels like `Answer A`. Because
  prompt instructions alone aren't fully reliable at suppressing that narration, a
  final **sanitizing pass** rewrites the answer to strip any leftover meta-commentary
  (one extra model call per combine; on failure it returns the un-sanitized answer).
- **Bad requests throw early.** `combine()` validates before doing any work and
  throws on: no participants, duplicate participant names, an empty `messages`
  array, a `minParticipants` that isn't a positive integer or exceeds the
  participant count, a `synthesizer` that isn't a participant, or an unknown
  `strategy`.
- **Partial failures are tolerated.** A provider that fails to draft — or
  succeeds but returns empty text — is recorded in `result.drafts` and dropped
  from the rest of the round; the round proceeds with the survivors as long as
  at least
  `minParticipants` produced a draft (otherwise `combine()` throws). Failed
  critiques are likewise non-fatal. If the chosen synthesizer fails **or returns
  empty text**, it falls back to the next surviving participant.
- **A single participant** degrades to a plain completion (no critique/synthesis).
- **Token usage is aggregated.** `result.usage` sums every model call the run made
  (drafts, critiques, synthesis, and the sanitize pass) into a `total` plus a
  per-participant `byParticipant` breakdown — `undefined` if no provider reported
  usage.

#### Pipeline

A conveyor belt: each participant refines the previous one's answer, in order.
The first participant writes an initial answer; each subsequent participant gets
the question plus the current running answer and improves it; the **last stage to
produce an answer is the final answer**.

```ts
const result = await registry.combine({
  messages: [{ role: "user", content: "Design a rate limiter." }],
  participants: ["anthropic", "openai", "gemini"], // the conveyor order
  strategy: "pipeline",
});

console.log(result.text); // the final, refined answer
console.log(result.finalProvider); // the last stage that produced an answer
console.log(result.stages); // every stage in order (each "ok" or "failed")
```

Behavior notes:

- **Order is the conveyor order.** `participants[0]` writes first; each later
  participant refines what it received. You control the belt by ordering them.
- **Refiners preserve, not rewrite.** Each refining stage is told to treat the
  current answer as a strong baseline — fix errors, fill gaps, sharpen wording,
  but keep what's correct and return it unchanged if it can't improve it. There is
  no downstream synthesizer to catch a regression, so the framing guards against
  one.
- **Partial failures carry the answer forward.** A stage that fails or returns
  empty text is recorded in `result.stages` (as `status: "failed"`) and the
  previous running answer moves to the next stage unchanged. The run throws only
  if **no** stage produces an answer. A leading run of failed stages just means a
  later stage writes the first answer.
- **The final answer is sanitized** (the same pass consensus uses) when a
  refining stage actually changed it, to strip any "I improved the previous
  answer…" narration — one extra model call; on failure it returns the
  un-sanitized answer. A lone first-stage answer, or a refiner that returned the
  text unchanged, is returned as-is (no wasted call).
- `synthesizer`, `attribution`, and `minParticipants` are consensus-specific and
  ignored.
- **Token usage is aggregated.** `result.usage` sums every stage (plus the
  sanitize pass) into a `total` and a per-participant `byParticipant` breakdown —
  `undefined` if no provider reported usage.

#### Ensemble

A multi-model vote on **structured output**. Every participant answers the prompt
independently under the same JSON Schema (`responseFormat`, required for this
strategy), then the typed objects are merged **mechanically** — no model
adjudicates — and you get an **agreement score** telling you how strongly the
models concurred. This is the thing a single provider can't give you: extraction
and classification with built-in confidence.

```ts
const result = await registry.combine({
  messages: [{ role: "user", content: "Extract the city and country: ..." }],
  participants: ["anthropic", "openai", "gemini"],
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
console.log(result.agreement.overall); // 0–1: how much the models agreed overall
console.log(result.agreement.byField); // e.g. { city: 1, country: 0.67 }
console.log(result.responses); // each participant's structured answer (ok/failed)
```

Merge policy (field-wise over the union of top-level keys):

- **every field → majority vote**: the most common value by deep equality, ties
  broken by participant order. The merged value is always one a model actually
  returned — never a synthesized or averaged value — so it stays within the
  schema's types and `agreement` describes the exact value you get back.
- **agreement** per field is the share of **all** the valid responses that voted
  for the merged value; `overall` is the mean across fields. Because the
  denominator is every response (not just the ones that returned the field), a
  field most models omitted scores low — a low score flags a field (disagreement
  or sparse coverage) to route for review.

Behavior notes:

- **`responseFormat` is required** for ensemble and **rejected** for
  consensus/pipeline (where it has no meaning and would be silently ignored). Its
  schema must have an **object** root (the field-wise vote needs named fields); an
  array- or scalar-root schema is rejected up front with a clear error.
- **Failures and invalid responses are dropped from the vote** but still recorded
  in `result.responses`: a provider that errored, returned non-JSON, or didn't
  return an object doesn't count. The run throws only if **no** participant
  returns a valid object.
- **The merge is shallow** — nested objects/arrays are voted on as whole values,
  not merged recursively. Keep schemas to flat fields for the most useful
  per-field agreement.
- **Token usage is aggregated** into `result.usage`, as with the other strategies.

### Combine progress events

`combine()` takes an optional second argument (`CombineOptions`) with an
`onEvent` callback that fires as the run progresses — useful for a status display
during a multi-call run. The final answer is still the resolved `CombineResult`;
events are status only (no token streaming).

```ts
await registry.combine(
  {
    messages: [{ role: "user", content: "…" }],
    participants: ["anthropic", "openai"],
  },
  {
    onEvent: (event) => {
      switch (event.type) {
        case "phase":
          console.log(`→ ${event.phase}`); // consensus: "drafting" | "critiquing" | "synthesizing"
          break;
        case "draft":
        case "critique":
          console.log(`  ${event.provider}: ${event.status}`); // consensus; "ok" | "failed"
          break;
        case "stage":
          console.log(
            `  stage ${event.index} ${event.provider}: ${event.status}`,
          ); // pipeline
          break;
      }
    },
  },
);
```

`CombineEvent` is a discriminated union on `type`:

| `type`       | Fields                        | When                                                                        |
| ------------ | ----------------------------- | --------------------------------------------------------------------------- |
| `"phase"`    | `phase`                       | _Consensus._ At each phase boundary (drafting / critiquing / synthesizing). |
| `"draft"`    | `provider`, `status`          | _Consensus._ As each participant's draft settles.                           |
| `"critique"` | `provider`, `status`          | _Consensus._ As each survivor's critique settles.                           |
| `"stage"`    | `provider`, `status`, `index` | _Pipeline._ As each stage settles, in conveyor order (`index` 0-based).     |

Consensus `draft`/`critique` events arrive in completion order (which may differ
from participant order); pipeline `stage` events arrive in conveyor order. There
is no terminal event (the result is the return value), and errors thrown from
`onEvent` are swallowed so a listener can't break the run.

### Request options

Both `complete()` and `stream()` take a `CompletionRequest`:

| Field            | Type             | Notes                                                                                          |
| ---------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| `messages`       | `Message[]`      | Required. `{ role: "user" \| "assistant"; content: string \| ContentPart[] }`                  |
| `system`         | `string`         | Optional system prompt.                                                                        |
| `model`          | `string`         | Optional per-request model override.                                                           |
| `maxTokens`      | `number`         | Optional output cap (defaults: 16000 complete / 64000 stream).                                 |
| `responseFormat` | `ResponseFormat` | Optional. Constrain the output to a JSON Schema — see [Structured output](#structured-output). |
| `signal`         | `AbortSignal`    | Optional. Aborts the request (and an in-flight `stream()` read) when it fires.                 |

> **Message content:** `content` accepts a plain `string` (shorthand for a single
> text part) or a `ContentPart[]` for multimodal input. A `ContentPart` is a
> `TextPart` (`{ type: "text"; text }`), an `ImagePart` (`{ type: "image"; source }`),
> or a `FilePart` (`{ type: "file"; source; filename? }`) — a document such as a
> PDF. The `source` is either base64 bytes (`{ kind: "base64"; mediaType; data }`)
> or a URL (`{ kind: "url"; url; mediaType? }`). Provider support varies: OpenAI's
> Chat Completions has no URL file source (that combination throws), and Gemini
> resolves a URL source only from a Files API / `gs://` URI, not an arbitrary
> public web URL — use a base64 source for Gemini portability.
>
> ```ts
> const result = await registry.select("anthropic").complete({
>   messages: [
>     {
>       role: "user",
>       content: [
>         { type: "text", text: "What's in this image?" },
>         {
>           type: "image",
>           source: { kind: "base64", mediaType: "image/png", data: pngBase64 },
>         },
>       ],
>     },
>   ],
> });
> ```

> **Timeouts & cancellation:** pass a `signal` to bound or cancel a call. For a
> timeout, use `AbortSignal.timeout(ms)`; to cancel manually, use an
> `AbortController`. An aborted call rejects with a transport `ProviderError`
> (`err.kind === "transport"`) whose `cause` is the abort reason.
>
> ```ts
> // Time out a single completion after 30s:
> const result = await provider.complete({
>   messages: [{ role: "user", content: "…" }],
>   signal: AbortSignal.timeout(30_000),
> });
>
> // Cancel a streaming call from elsewhere:
> const controller = new AbortController();
> const stream = provider.stream({ messages, signal: controller.signal });
> // …later: controller.abort();
> ```
>
> `combine()` accepts a `signal` on its request too (it extends
> `CompletionRequest`); the same signal is threaded into every participant call,
> so aborting it cancels the whole run at once.

> **Gemini note:** Gemini 2.5 models are _thinking_ models, and their internal
> thinking tokens count against `maxTokens` (Gemini's `maxOutputTokens`). A very
> small cap can therefore be consumed entirely by thinking, leaving the visible
> answer empty or truncated — where Anthropic/OpenAI would still return a short
> reply. Give Gemini ample headroom (e.g. a few hundred tokens or more). Note
> that `gemini-2.5-pro` cannot fully disable thinking, so this behavior can't
> simply be turned off.

### Result fields

`complete()` resolves to a `CompletionResult`:

| Field             | Type           | Notes                                                                                                       |
| ----------------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| `text`            | `string`       | The full answer.                                                                                            |
| `model`           | `string`       | The model that actually produced the response.                                                              |
| `finishReason`    | `FinishReason` | Normalized stop reason, or `undefined` if none was reported (see below).                                    |
| `rawFinishReason` | `string`       | The provider's exact stop-reason string (e.g. `"max_tokens"`, `"length"`, `"MAX_TOKENS"`).                  |
| `refusal`         | `string`       | The refusal message when the model declined (currently OpenAI's `message.refusal`).                         |
| `usage`           | `Usage`        | Token usage (`inputTokens`/`outputTokens`/`totalTokens`), or `undefined` if none reported.                  |
| `parsed`          | `unknown`      | The parsed structured output when `responseFormat` was given — see [Structured output](#structured-output). |

`FinishReason` is a provider-agnostic union mapped from each provider's field
(Anthropic `stop_reason`, OpenAI `finish_reason`, Gemini `finishReason`):

- `"stop"` — the model finished on its own.
- `"length"` — output was truncated at the token cap. Pair with the Gemini note
  above: a `length` reason with empty `text` usually means the cap was spent on
  thinking tokens.
- `"content_filter"` — the model refused or output was blocked by a safety
  filter. When `refusal` is set, `finishReason` is always this.
- `"other"` — any other or unrecognized reason.

This lets you tell a truncated/refused answer apart from a genuinely empty one
instead of just seeing `text: ""`:

```ts
const { text, finishReason, refusal } = await provider.complete({ messages });
if (finishReason === "length") {
  // raise maxTokens and retry
} else if (refusal !== undefined) {
  console.warn(`Model declined: ${refusal}`);
}
```

### Structured output

Pass `responseFormat` with a **plain JSON Schema** (no Zod, no runtime
dependency) to constrain the output. The model returns JSON in `text`, and
`complete()` also gives you the parsed value on `result.parsed`:

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
// result.parsed is `undefined` if the output wasn't valid JSON (e.g. truncated);
// the raw JSON is always in result.text.
```

Each provider maps the schema to its native mechanism (Anthropic
`output_config.format`, OpenAI `response_format` with `strict: true`, Gemini
`responseSchema`). For one schema to work across all three, keep it simple: every
object sets `additionalProperties: false`, and every property is `required` with a
single non-null `type`. Avoid optional/nullable fields (OpenAI strict requires all
properties in `required`; Gemini wants `nullable: true` rather than a
`["string","null"]` union, so null-unions aren't portable), recursive schemas,
`$ref`, and numeric/length constraints. `responseFormat` also applies to
`stream()` (the streamed `text` is JSON), but only `complete()` surfaces `parsed`.

## Public API

Exported from the package entry point:

- `ProviderRegistry` — the single entry point (`select()` and `combine()`).
- Config types: `ProviderRegistryConfig`, `ProviderName`,
  `AnthropicProviderOptions`, `OpenAIProviderOptions`, `GeminiProviderOptions`.
- Contract types: `Provider`, `Message`, `Role`, `ContentPart`, `TextPart`,
  `ImagePart`, `FilePart`, `MediaSource`, `CompletionRequest`, `CompletionResult`,
  `ResponseFormat`, `FinishReason`, `Usage`.
- `ProviderError` (a value — usable with `instanceof`) and its `ProviderErrorKind`
  type — see [Error handling](#error-handling).
- `RetryOptions` — the per-provider `retry` config shape; see [Retries](#retries).
- Combine types: `CombineRequest`, `CombineResult` (= `ConsensusResult` |
  `PipelineResult` | `EnsembleResult`), `EnsembleAgreement`, `CombineUsage`,
  `ParticipantOutcome`, `StrategyName`, `CombineOptions`, `CombineEvent`.

The concrete provider classes (`AnthropicProvider`, `OpenAIProvider`,
`GeminiProvider`) are **not** exported — they are constructed internally by the
registry.

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
(`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`). To enable them, copy
the template and add your key(s):

```bash
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY
yarn test:integration
```

To run just one provider's suite, append its filename pattern (it replaces the
default, which is all integration tests):

```bash
yarn test:integration openai.integration      # OpenAI only
yarn test:integration anthropic.integration    # Anthropic only
yarn test:integration gemini.integration       # Gemini only
yarn test:integration consensus.integration    # consensus combine (all three)
yarn test:integration pipeline.integration      # pipeline combine (all three)
```

The combine suites (`consensus.integration`, `pipeline.integration`) are
**triple-gated**: each runs only with `RUN_LIVE_TESTS=1` **and all three**
provider keys set, since they exercise the full three-way flow. They make several
paid calls on the cheap models (consensus: 3 drafts + 3 critiques + 1 synthesis;
pipeline: 3 sequential stages + 1 sanitize).

`.env` is gitignored and loaded automatically for the test run. Live tests use a
cheap model and a small token cap, so cost is negligible (Gemini uses a slightly
larger cap to leave room for its thinking tokens — see the Gemini note above).

## Roadmap

- [x] Core `Provider` abstraction + Anthropic provider (completion + streaming).
- [x] A second provider (OpenAI) behind the same interface.
- [x] Provider registry / selection by name.
- [x] A third provider (Google Gemini) behind the same interface.
- [x] Combine multiple providers on one prompt — the **consensus** strategy.
- [x] A second combine strategy — **pipeline** (sequential refinement).
- [ ] More combine strategies (e.g. court) and streaming for combine.

## Changelog

Notable changes are recorded in [CHANGELOG.md](./CHANGELOG.md), following the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## License

[MIT](./LICENSE) © Anders Jansson

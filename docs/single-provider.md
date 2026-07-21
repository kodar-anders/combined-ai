# Single-provider reference

Deep reference for one-provider calls (`complete()` / `stream()`). The basics —
`select()`, provider config, custom/gateway providers — are in
[Single-provider usage](../README.md#single-provider-usage) in the README.

- [Request options](#request-options)
- [Result fields](#result-fields)
- [Structured output](#structured-output)
- [Tool calling](#tool-calling)
- [Multimodal input](#multimodal-input)
- [Embeddings](#embeddings)

## Request options

Both `complete()` and `stream()` (and `combine()`) take a `CompletionRequest`:

| Field            | Type               | Notes                                                                                                                        |
| ---------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `messages`       | `Message[]`        | Required. `{ role: "user" \| "assistant"; content: string \| ContentPart[] }`                                                |
| `system`         | `string`           | Optional system prompt.                                                                                                      |
| `model`          | `string`           | Optional per-request model override.                                                                                         |
| `maxTokens`      | `number`           | Optional output cap (defaults: 16000 complete / 64000 stream).                                                               |
| `responseFormat` | `ResponseFormat`   | Optional. Constrain the output to a JSON Schema — see [Structured output](#structured-output).                               |
| `tools`          | `ToolDefinition[]` | Optional. Tools the model may call — see [Tool calling](#tool-calling).                                                      |
| `toolChoice`     | `ToolChoice`       | Optional. `"auto" \| "any" \| "none" \| { name }`.                                                                           |
| `signal`         | `AbortSignal`      | Optional. Aborts the request (and an in-flight `stream()` read) when it fires.                                               |
| `retry`          | `RetryOptions`     | Optional. Overrides the provider's construction-time retry for this call (merged field-wise).                                |
| `timeoutMs`      | `number`           | Optional. Whole-call wall-clock deadline — see [Retries & cancellation](./errors-retries-fallback.md#retries--cancellation). |

> **Gemini note:** Gemini 2.5 and 3.x models are _thinking_ models, and their
> internal thinking tokens count against `maxTokens`. A very small cap can be
> consumed entirely by thinking, leaving the visible answer empty or truncated —
> give Gemini ample headroom (the default `gemini-3.5-flash` can't fully disable
> thinking).

## Result fields

`complete()` resolves to a `CompletionResult`:

| Field             | Type           | Notes                                                                                                                                                    |
| ----------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`            | `string`       | The full answer.                                                                                                                                         |
| `model`           | `string`       | The model that actually produced the response.                                                                                                           |
| `finishReason`    | `FinishReason` | Normalized stop reason: `"stop"` \| `"length"` \| `"content_filter"` \| `"tool_use"` \| `"other"`.                                                       |
| `rawFinishReason` | `string`       | The provider's exact stop-reason string.                                                                                                                 |
| `refusal`         | `string`       | The refusal message when the model declined.                                                                                                             |
| `usage`           | `Usage`        | Token usage (`inputTokens`/`outputTokens`/`totalTokens`, plus optional `cachedInputTokens`/`cacheCreationInputTokens`), or `undefined` if none reported. |
| `parsed`          | `unknown`      | The parsed structured output when `responseFormat` was given.                                                                                            |
| `toolCalls`       | `ToolCall[]`   | The tool calls the model requested, when it called any.                                                                                                  |

`finishReason` lets you tell a truncated/refused answer apart from a genuinely
empty one instead of just seeing `text: ""`. A `"length"` reason with empty
`text` on Gemini usually means the cap was spent on thinking tokens.

| Provider  | Refusal signal                                                                   |
| --------- | -------------------------------------------------------------------------------- |
| OpenAI    | `refusal` text set; `finishReason: "content_filter"`.                            |
| Anthropic | `refusal` text set; `finishReason: "content_filter"`.                            |
| Gemini    | No refusal text — `finishReason: "content_filter"`; reason in `rawFinishReason`. |

```ts
const { text, finishReason, refusal } = await provider.complete({ messages });
if (finishReason === "length") {
  // raise maxTokens and retry
} else if (refusal !== undefined) {
  console.warn(`Model declined: ${refusal}`);
}
```

## Structured output

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
across all three, **keep it simple**: every object sets
`additionalProperties: false` and every property is `required` with a single
non-null `type`. Avoid optional/nullable fields, recursive schemas, `$ref`, and
numeric/length constraints. (The [ensemble](./strategies.md#ensemble) strategy
uses this same field across multiple models.)

## Tool calling

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

## Multimodal input

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
Gemini resolves a URL only from a Files API / `gs://` URI — so **prefer base64
for portability**. The mapper throws on an unsupported combination.

## Embeddings

`registry.embed(name, text)` embeds a single string; `registry.embedMany(name, texts)`
embeds a batch in one call (one vector per input, in order):

```ts
import { cosineSimilarity } from "combined-ai";

const { embedding } = await registry.embed("openai", "a dog barks");
const { embeddings } = await registry.embedMany("google", [
  "a puppy yaps",
  "the stock market fell",
]);

// Compare meaning with cosineSimilarity (always cosine — never a raw dot product):
cosineSimilarity(embedding, embeddings[0]); // higher → closer in meaning
```

OpenAI (default `text-embedding-3-small`) and Google (default
`gemini-embedding-001`) support embeddings. **Anthropic does not** — it has no
first-party embeddings endpoint, so `embed("anthropic", …)` throws. Embeddings are
an optional capability on the `Provider` contract, so a bring-your-own provider
may also implement `embed`.

Pass a per-call `model` or `dimensions` (reduces the output vector size — OpenAI
`dimensions` / Gemini `outputDimensionality`):

```ts
await registry.embedMany("openai", texts, {
  model: "text-embedding-3-large",
  dimensions: 256,
});
```

OpenAI reports token `usage` (priced through the same cost layer — embedding
models are in the registry, billed on input only); Google's embedding endpoint
reports none, so `usage` is omitted there.

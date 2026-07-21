# Errors, retries & fallback

How failed calls surface, the built-in retry/timeout behavior, and multi-provider
fallback chains.

- [Error handling](#error-handling)
- [Retries & cancellation](#retries--cancellation)
- [Fallback chains](#fallback-chains)

## Error handling

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
thrown — see [Reading the result](./strategies.md#reading-the-result).

## Retries & cancellation

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

Override the retry **per call** with `request.retry` — it merges field-by-field
over the provider's, so you can tune one knob (and `{ maxRetries: 0 }` disables
retry for just that call while keeping the provider's `baseDelayMs`):

```ts
await provider.complete({ messages, retry: { maxRetries: 5 } });
```

Pass a `signal` to bound or cancel a call, or set `timeoutMs` for a wall-clock
deadline (sugar for combining your `signal` with `AbortSignal.timeout(ms)`). Both
reject an expired/aborted call with a transport `ProviderError` whose `cause` is
the abort reason — a `TimeoutError` for `timeoutMs`, so a timeout is
distinguishable. A `timeoutMs` bounds the **whole call**: every retry attempt, the
backoff between them, and (for `stream()`) the full body read.

```ts
await provider.complete({ messages, timeoutMs: 30_000 });
// equivalent to: signal: AbortSignal.timeout(30_000)
```

`retry` and `timeoutMs` (like `signal`) flow through `combine()` and `fallback()`
to every underlying provider call. Note the split: a `signal` bounds the **whole
run** (one signal cancels a combine or a fallback chain), whereas `timeoutMs`
bounds **each provider call**. For a run-wide deadline across a multi-phase
combine or a fallback chain, use `signal` (e.g. `AbortSignal.timeout(ms)`).

## Fallback chains

`registry.fallback(specs)` returns a `Provider` that tries providers in order,
catching a `ProviderError` and moving to the next when one is down, rate-limited
past its retries, or otherwise failing. It pairs with the per-provider retry above
(each entry still retries its routine statuses before the chain moves on) and,
being a plain `Provider`, works via `.complete()`/`.stream()` and can even be
registered as a [custom provider](../README.md#custom--gateway-providers).

```ts
const resilient = registry.fallback(["openai", "anthropic"]);
const result = await resilient.complete({ messages }); // openai, then anthropic on failure
```

A `spec` is a bare provider name (its default model) or
`{ provider, model?, maxTokens? }`. Per-entry `model`/`maxTokens` override the
per-call request (entry → request → provider default). **For a mixed-provider
chain, set `model` per entry — not on the request** — since one `request.model`
can't be forwarded to a different provider:

```ts
registry.fallback([
  { provider: "openai", model: "gpt-5.4" },
  { provider: "anthropic", model: "claude-opus-4-8" },
]);
```

When **every** provider fails, `fallback` throws an `AggregateError` whose
`.errors` holds each `ProviderError`. Aborting the request's `signal` propagates
immediately without trying the rest of the chain; a per-call `timeoutMs`, by
contrast, applies to **each entry**, so a slow provider times out and the chain
advances to the next. `stream()` falls back only **before the first delta** —
once a delta is emitted the chain is committed to that provider and any later
error propagates unchanged.

By default it falls back on any non-abort `ProviderError` — even a `4xx`, since a
different provider may accept a request the first rejected (e.g. differing
structured-output schema rules). That means a genuinely unrecoverable error (a
bad key, a malformed request) is only surfaced after the whole chain is
exhausted. Pass `shouldFallback` to stop early on those, and `onFallback` to
observe each advance:

```ts
registry.fallback(["openai", "anthropic"], {
  shouldFallback: ({ error }) => error.status !== 401, // don't retry a bad key elsewhere
  onFallback: ({ provider, error }) =>
    console.warn(`${provider} failed (${error.status}), falling back`),
});
```

> The returned provider has no `embed` — fallback is completion routing, and
> embeddings from different providers/models aren't comparable. Note also that a
> fully-unavailable chain serializes each provider's retry backoff, so worst-case
> failover latency grows with the chain length.

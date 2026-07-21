# Testing with MockProvider

combined-ai publishes a network-free `MockProvider` on the `combined-ai/test`
subpath, so you can test provider selection and `combine` orchestration without
making (paid) API calls. It satisfies the `Provider` contract, records every call,
and simulates streaming by splitting the response text into deltas.

```ts
import { MockProvider, ProviderError } from "combined-ai/test";

// A canned completion (a bare string is shorthand for `{ text }`).
const mock = new MockProvider({ response: "42" });
await mock.complete({ messages }); // → { text: "42", model: "mock-model" }
for await (const delta of mock.stream({ messages })) {
  /* "42" arrives as word-ish deltas */
}
mock.calls; // every request passed in, for assertions

// A scripted sequence (one per call; throws when exhausted), or a per-call
// function for phase-aware fakes. Return/throw an Error to simulate a failure —
// e.g. drive retry/fallback logic with a real ProviderError.
new MockProvider({ response: ["first", "second"] });
new MockProvider({ response: (request, index) => `answer #${index}` });
new MockProvider({
  response: new ProviderError("rate limited", {
    provider: "mock",
    kind: "api",
    status: 429,
  }),
});

// A Partial<CompletionResult> passes usage/finishReason/parsed/toolCalls through;
// pass `embed` to opt into embeddings. Register it like any custom provider:
const registry = new ProviderRegistry({
  custom: {
    a: {
      kind: "provider",
      provider: new MockProvider({ response: "answer-a" }),
    },
    b: {
      kind: "provider",
      provider: new MockProvider({ response: "answer-b" }),
    },
  },
});
await registry.consensus({ messages, participants: ["a", "b"] });
```

Import `ProviderError` from `combined-ai/test` (not the main entry) when you need
`instanceof` to hold against errors thrown by a `MockProvider`. Subpath types
resolve under `moduleResolution` `bundler`/`node16`/`nodenext` (they read the
package's `exports` map).

The subpath exports `MockProvider` (plus `MockProviderOptions`, `MockResponse`,
`MockResponder`) and re-exports `ProviderError` / `ProviderErrorKind`.

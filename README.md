# combined-ai

A small TypeScript library that combines several AI providers behind one
interface. It lets you talk to a provider through a single, consistent contract
today, and is being built toward **combining multiple providers on one prompt**.

> **Status: early.** The core abstraction and three providers (Anthropic /
> Claude, OpenAI, and Google Gemini) are in place, with completion and streaming,
> plus a registry to select a provider by name. Multi-provider combination is
> planned — see [Roadmap](#roadmap).

## Features

- One provider-agnostic contract (`Provider`) for every backend.
- `complete()` — run a prompt, get the full text back.
- `stream()` — run a prompt, receive text deltas as they arrive.
- **Anthropic (Claude)**, **OpenAI**, and **Google Gemini** providers, talking
  to their HTTP APIs directly over the global `fetch` — no SDK dependency.
- `ProviderRegistry` — a single point of access: configure your providers, then
  select one by name.
- Dual ESM + CJS package with TypeScript types.

## Requirements

- Node.js ≥ 20 (uses the global `fetch`, `ReadableStream`, `TextDecoder`).

## Installation

Not published to a registry yet (private package). Install from the git repo:

```bash
yarn add combined-ai@git+ssh://git@github.com:kodar-anders/combined-ai.git
# or
npm install git+ssh://git@github.com:kodar-anders/combined-ai.git
```

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

### Request options

Both `complete()` and `stream()` take a `CompletionRequest`:

| Field       | Type        | Notes                                                          |
| ----------- | ----------- | -------------------------------------------------------------- |
| `messages`  | `Message[]` | Required. `{ role: "user" \| "assistant"; content: string }`   |
| `system`    | `string`    | Optional system prompt.                                        |
| `model`     | `string`    | Optional per-request model override.                           |
| `maxTokens` | `number`    | Optional output cap (defaults: 16000 complete / 64000 stream). |

> **Gemini note:** Gemini 2.5 models are _thinking_ models, and their internal
> thinking tokens count against `maxTokens` (Gemini's `maxOutputTokens`). A very
> small cap can therefore be consumed entirely by thinking, leaving the visible
> answer empty or truncated — where Anthropic/OpenAI would still return a short
> reply. Give Gemini ample headroom (e.g. a few hundred tokens or more). Note
> that `gemini-2.5-pro` cannot fully disable thinking, so this behavior can't
> simply be turned off.

## Public API

Exported from the package entry point:

- `ProviderRegistry` — the single entry point.
- Config types: `ProviderRegistryConfig`, `ProviderName`,
  `AnthropicProviderOptions`, `OpenAIProviderOptions`, `GeminiProviderOptions`.
- Contract types: `Provider`, `Message`, `Role`, `CompletionRequest`,
  `CompletionResult`.

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
```

`.env` is gitignored and loaded automatically for the test run. Live tests use a
cheap model and a small token cap, so cost is negligible (Gemini uses a slightly
larger cap to leave room for its thinking tokens — see the Gemini note above).

## Roadmap

- [x] Core `Provider` abstraction + Anthropic provider (completion + streaming).
- [x] A second provider (OpenAI) behind the same interface.
- [x] Provider registry / selection by name.
- [x] A third provider (Google Gemini) behind the same interface.
- [ ] Combine multiple providers on one prompt.

## License

Not yet specified (private package).

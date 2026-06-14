# combined-ai

A small TypeScript library that combines several AI providers behind one
interface. It lets you talk to a provider through a single, consistent contract
today, and is being built toward **combining multiple providers on one prompt**.

> **Status: early.** The core abstraction and the first provider (Anthropic /
> Claude) are in place, with completion and streaming. More providers, provider
> selection, and multi-provider combination are planned — see
> [Roadmap](#roadmap).

## Features

- One provider-agnostic contract (`Provider`) for every backend.
- `complete()` — run a prompt, get the full text back.
- `stream()` — run a prompt, receive text deltas as they arrive.
- **Anthropic (Claude)** provider, talking to the Messages API directly over
  the global `fetch` — no SDK dependency.
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

The library never reads environment variables — you always pass the API key in
explicitly.

```ts
import { AnthropicProvider } from "combined-ai";

const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!, // your key, supplied by your app
});

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

### Constructor options

```ts
new AnthropicProvider({
  apiKey: "sk-ant-...", // required
  model: "claude-opus-4-8", // optional; this is the default
  baseUrl: "https://api.anthropic.com", // optional; this is the default
});
```

### Request options

Both `complete()` and `stream()` take a `CompletionRequest`:

| Field       | Type        | Notes                                                          |
| ----------- | ----------- | -------------------------------------------------------------- |
| `messages`  | `Message[]` | Required. `{ role: "user" \| "assistant"; content: string }`   |
| `system`    | `string`    | Optional system prompt.                                        |
| `model`     | `string`    | Optional per-request model override.                           |
| `maxTokens` | `number`    | Optional output cap (defaults: 16000 complete / 64000 stream). |

## Public API

Exported from the package entry point:

- `AnthropicProvider`, `AnthropicProviderOptions`
- Types: `Provider`, `Message`, `Role`, `CompletionRequest`, `CompletionResult`

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

`yarn test:integration` runs tests against the real Anthropic API. They are
double-gated and skipped by default — they run only when both `RUN_LIVE_TESTS=1`
(set by the script) and `ANTHROPIC_API_KEY` are present. To enable them, copy
the template and add your key:

```bash
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY=sk-ant-...
yarn test:integration
```

`.env` is gitignored and loaded automatically for the test run. Live tests use a
cheap model and a tiny token cap, so cost is negligible.

## Roadmap

- [x] Core `Provider` abstraction + Anthropic provider (completion + streaming).
- [ ] A second provider behind the same interface.
- [ ] Provider registry / selection by name.
- [ ] Combine multiple providers on one prompt.

## License

Not yet specified (private package).

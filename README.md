# combined-ai

A small TypeScript library that combines several AI providers behind one
interface. It lets you talk to a provider through a single, consistent contract
today, and is being built toward **combining multiple providers on one prompt**.

> **Status: early.** The core abstraction and three providers (Anthropic /
> Claude, OpenAI, and Google Gemini) are in place, with completion and streaming,
> plus a registry to select a provider by name. Multi-provider combination has
> landed with its first strategy, **consensus** — see
> [Combining providers](#combining-providers-consensus) and [Roadmap](#roadmap).

## Features

- One provider-agnostic contract (`Provider`) for every backend.
- `complete()` — run a prompt, get the full text back.
- `stream()` — run a prompt, receive text deltas as they arrive.
- **Anthropic (Claude)**, **OpenAI**, and **Google Gemini** providers, talking
  to their HTTP APIs directly over the global `fetch` — no SDK dependency.
- `ProviderRegistry` — a single point of access: configure your providers, then
  select one by name.
- `registry.combine()` — make several providers **cooperate** on one prompt
  using a strategy. The first strategy is **consensus** (draft → critique →
  synthesize).
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

### Combining providers (consensus)

Beyond selecting one provider, you can make several **cooperate** on a single
prompt with `registry.combine()`. The only strategy today is **consensus**:

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
  // strategy: "consensus",                          // optional; the only value today
  // attribution: "attributed",                     // optional; default "anonymized"
});

console.log(result.text); // the final synthesized answer
console.log(result.synthesizer); // who wrote it (a fallback if the chosen one failed)
console.log(result.drafts); // each participant's first-pass answer (or failure)
console.log(result.critiques); // each participant's critique (or failure)
```

`combine()` accepts the same `CompletionRequest` fields as `complete()`
(`messages`, `system`, `model`, `maxTokens`) — they apply to every participant —
plus:

| Field             | Type                             | Notes                                                                                                                             |
| ----------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `participants`    | `ProviderName[]`                 | Required. Must be configured, non-empty, and unique; validated like `select()`.                                                   |
| `synthesizer`     | `ProviderName`                   | Optional. Must be a participant. Defaults to the first.                                                                           |
| `strategy`        | `"consensus"`                    | Optional. Defaults to `"consensus"` (the only value today).                                                                       |
| `attribution`     | `"attributed"` \| `"anonymized"` | Optional. Default `"anonymized"` (Answer A/B/C) reduces bias; `"attributed"` shows provider names. The result always keeps names. |
| `minParticipants` | `number`                         | Optional. Minimum drafts required to proceed (default 2). Must be a positive integer ≤ the participant count.                     |

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
- **Partial failures are tolerated.** A provider that fails to draft is recorded
  in `result.drafts` (as `status: "failed"`) and dropped from the rest of the
  round; the round proceeds with the survivors as long as at least
  `minParticipants` produced a draft (otherwise `combine()` throws). Failed
  critiques are likewise non-fatal. If the chosen synthesizer fails **or returns
  empty text**, it falls back to the next surviving participant.
- **A single participant** degrades to a plain completion (no critique/synthesis).

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
          console.log(`→ ${event.phase}`); // "drafting" | "critiquing" | "synthesizing"
          break;
        case "draft":
        case "critique":
          console.log(`  ${event.provider}: ${event.status}`); // "ok" | "failed"
          break;
      }
    },
  },
);
```

`CombineEvent` is a discriminated union on `type`:

| `type`       | Fields               | When                                                           |
| ------------ | -------------------- | -------------------------------------------------------------- |
| `"phase"`    | `phase`              | At each phase boundary (drafting / critiquing / synthesizing). |
| `"draft"`    | `provider`, `status` | As each participant's draft settles.                           |
| `"critique"` | `provider`, `status` | As each survivor's critique settles.                           |

`draft`/`critique` events arrive in completion order (which may differ from
participant order); there is no terminal event (the result is the return value);
and errors thrown from `onEvent` are swallowed so a listener can't break the run.

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

- `ProviderRegistry` — the single entry point (`select()` and `combine()`).
- Config types: `ProviderRegistryConfig`, `ProviderName`,
  `AnthropicProviderOptions`, `OpenAIProviderOptions`, `GeminiProviderOptions`.
- Contract types: `Provider`, `Message`, `Role`, `CompletionRequest`,
  `CompletionResult`.
- Combine types: `CombineRequest`, `CombineResult`, `ParticipantOutcome`,
  `StrategyName`, `CombineOptions`, `CombineEvent`.

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
```

The consensus combine suite (`consensus.integration`) is **triple-gated**: it
runs only with `RUN_LIVE_TESTS=1` **and all three** provider keys set, since it
exercises the full three-way draft → critique → synthesize flow. It makes
several paid calls (3 drafts + 3 critiques + 1 synthesis) on the cheap models.

`.env` is gitignored and loaded automatically for the test run. Live tests use a
cheap model and a small token cap, so cost is negligible (Gemini uses a slightly
larger cap to leave room for its thinking tokens — see the Gemini note above).

## Roadmap

- [x] Core `Provider` abstraction + Anthropic provider (completion + streaming).
- [x] A second provider (OpenAI) behind the same interface.
- [x] Provider registry / selection by name.
- [x] A third provider (Google Gemini) behind the same interface.
- [x] Combine multiple providers on one prompt — the **consensus** strategy.
- [ ] More combine strategies (conveyor belt, court) and streaming for combine.

## License

Not yet specified (private package).

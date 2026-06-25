/**
 * Core, provider-agnostic contract shared by every AI provider in the package.
 *
 * Everything else (additional providers, provider selection, multi-provider
 * combinations) builds on these types.
 */

export type Role = "user" | "assistant";

/**
 * A provider-native prompt-cache marker (**Anthropic only**). Attach it to a
 * content part (text/image/file) or the system prompt to place a cache breakpoint
 * there: Anthropic caches the prompt prefix up to and including the marked block
 * and re-uses it at a steep discount on later requests that share the same prefix.
 *
 * Omit `ttl` for the default 5-minute ephemeral cache; `"1h"` opts into the 1-hour
 * cache (a higher write premium — sent via Anthropic's extended-cache beta header).
 * Anthropic allows at most 4 breakpoints per request (the provider throws if more
 * are marked). OpenAI ignores it (it caches automatically); Gemini ignores it (it
 * has no per-request breakpoints — implicit caching is automatic); `combine`
 * ignores it (its strategies build their own prompts).
 */
export type CacheControl = { ttl?: "1h" };

/** A text segment of a message's content. */
export type TextPart = {
  type: "text";
  text: string;
  /** Mark a prompt-cache breakpoint at this block (Anthropic only; see {@link CacheControl}). */
  cacheControl?: CacheControl;
};

/**
 * Where binary media (an image or document) comes from — either inline
 * base64-encoded bytes (with their MIME type) or a URL the provider fetches.
 * For a `url` source, `mediaType` is optional but some providers need it (e.g.
 * Gemini's file references), so set it when known.
 */
export type MediaSource =
  | { kind: "base64"; mediaType: string; data: string }
  | { kind: "url"; url: string; mediaType?: string };

/** An image input (PNG/JPEG/WebP/GIF, per the provider's support). */
export type ImagePart = {
  type: "image";
  source: MediaSource;
  /** Mark a prompt-cache breakpoint at this block (Anthropic only; see {@link CacheControl}). */
  cacheControl?: CacheControl;
};

/** A document input, e.g. a PDF (`source.mediaType` should be `"application/pdf"`). */
export type FilePart = {
  type: "file";
  source: MediaSource;
  /** Optional file name (used by OpenAI's file input). */
  filename?: string;
  /** Mark a prompt-cache breakpoint at this block (Anthropic only; see {@link CacheControl}). */
  cacheControl?: CacheControl;
};

/**
 * A tool call the model made, as it appears in an **assistant** message's content
 * when you replay the conversation. Build these from the {@link ToolCall}s a prior
 * `complete()` returned, append them as the assistant turn, then send the matching
 * {@link ToolResultPart}s in the next user message.
 */
export type ToolUsePart = {
  type: "tool_use";
  /** The id the provider assigned to the call; echo it on the matching result. */
  id?: string;
  name: string;
  /** The arguments the model passed (a parsed object). */
  input: Record<string, unknown>;
};

/**
 * A tool's result, placed in a **user** message's content to feed it back to the
 * model. Carry both `toolUseId` (Anthropic/OpenAI match the call by id) and `name`
 * (Gemini matches by function name) when you have them.
 */
export type ToolResultPart = {
  type: "tool_result";
  /** The id of the {@link ToolUsePart}/{@link ToolCall} this answers. */
  toolUseId?: string;
  /** The tool's name — required for Gemini, which matches results by name. */
  name?: string;
  /** The tool's output as text. */
  content: string;
  /** Mark the call as having errored (the model is told the tool failed). */
  isError?: boolean;
};

/**
 * One part of a structured message content: text, an image, a file/document, or a
 * tool call / tool result (for replaying a tool-use conversation). Widening
 * {@link Message.content} from `string` to `string | ContentPart[]` was the one
 * breaking change; adding members here is additive.
 *
 * Provider support varies (e.g. OpenAI's Chat Completions has no URL file
 * source); each provider's content mapper handles what its API supports and
 * throws a clear error otherwise.
 */
export type ContentPart =
  | TextPart
  | ImagePart
  | FilePart
  | ToolUsePart
  | ToolResultPart;

export type Message = {
  role: Role;
  /**
   * The message body. A bare `string` is shorthand for a single text part, so
   * existing string callers keep working unchanged; pass `ContentPart[]` for
   * structured (e.g. future multimodal) content.
   */
  content: string | ContentPart[];
};

/**
 * Constrain the model's output to a JSON Schema (structured output). The schema
 * is a plain JSON Schema object — no Zod/runtime dependency. Each provider maps
 * it onto its own native mechanism (Anthropic `output_config.format`, OpenAI
 * `response_format`, Gemini `responseSchema`).
 *
 * **For one schema to work across all three providers** (driven by the strictest
 * rules), keep it simple: every `object` sets `additionalProperties: false`, and
 * every property is listed in `required` with a single non-null `type`. Avoid
 * optional and nullable fields — OpenAI's strict mode requires every property in
 * `required`, and Gemini expresses nullability with `nullable: true` rather than a
 * `["string", "null"]` union or an `anyOf` with a null member, so null-unions are
 * **not** portable (they're passed through untranslated and Gemini will reject
 * them). Also avoid recursive schemas, numeric/length constraints
 * (`minimum`/`maxLength`/…), and `$ref` (Gemini ignores most JSON Schema keywords
 * beyond types/enum/format). Provider-specific schemas can of course use more —
 * these constraints are only for a single schema shared across providers.
 */
export type ResponseFormat = {
  type: "json_schema";
  /** A JSON Schema object describing the desired output shape. */
  schema: Record<string, unknown>;
  /**
   * Schema name. OpenAI requires one (must match `^[a-zA-Z0-9_-]+$`); defaulted
   * when omitted. Ignored by Anthropic and Gemini.
   */
  name?: string;
};

/**
 * A tool the model may call. `parameters` is a JSON Schema describing the tool's
 * input (the same cross-provider schema guidance as {@link ResponseFormat} applies).
 */
export type ToolDefinition = {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};

/**
 * How the model should use the supplied tools:
 * - `"auto"` — the model decides whether to call a tool (the default when tools
 *   are present);
 * - `"any"` — the model must call some tool;
 * - `"none"` — the model must not call a tool;
 * - `{ name }` — the model must call that specific tool.
 */
export type ToolChoice = "auto" | "any" | "none" | { name: string };

/**
 * A tool call the model requested, surfaced on {@link CompletionResult.toolCalls}.
 * `input` is the parsed arguments object (OpenAI's JSON-string arguments are
 * parsed for you; Anthropic/Gemini already return an object).
 */
export type ToolCall = {
  /** Provider-assigned id (always on Anthropic/OpenAI; newer Gemini models). */
  id?: string;
  name: string;
  input: Record<string, unknown>;
};

/**
 * The object form of {@link CompletionRequest.system}: the prompt text plus an
 * optional {@link CacheControl} marker. Use it to cache the system prompt — often
 * the largest stable prefix of a request. `cacheControl` is honored by Anthropic
 * and ignored by OpenAI/Gemini (which read only `text`).
 */
export type SystemPrompt = { text: string; cacheControl?: CacheControl };

export type CompletionRequest = {
  messages: Message[];
  /**
   * Optional system prompt applied to the whole request. A bare `string`, or a
   * {@link SystemPrompt} object (`{ text, cacheControl }`) to mark the system
   * prompt as an Anthropic cache breakpoint.
   */
  system?: string | SystemPrompt;
  /** Override the provider's default model. */
  model?: string;
  /** Override the provider's default output-token cap. */
  maxTokens?: number;
  /**
   * Constrain the output to a JSON Schema. The model returns JSON in `text`, and
   * `complete()` also surfaces the parsed value on {@link CompletionResult.parsed}.
   */
  responseFormat?: ResponseFormat;
  /**
   * Tools the model may call. When the model calls one, `complete()` returns the
   * calls on {@link CompletionResult.toolCalls} (and `finishReason: "tool_use"`);
   * you run them and feed results back as {@link ToolResultPart}s in the next
   * message. Surfaced by `complete()` only — `stream()` yields text deltas and
   * does not report tool calls.
   */
  tools?: ToolDefinition[];
  /** Constrain whether/which tool the model calls. Defaults to provider behavior (`"auto"`). */
  toolChoice?: ToolChoice;
  /**
   * Abort the request (and, for `stream()`, the in-flight read) when this signal
   * fires. For a timeout, pass `AbortSignal.timeout(ms)`. An aborted request
   * rejects with a transport `ProviderError` whose `cause` is the abort reason.
   */
  signal?: AbortSignal;
};

/**
 * Normalized, provider-agnostic stop reason. The provider's exact value is
 * preserved separately on {@link CompletionResult.rawFinishReason}.
 *
 * - `"stop"` — the model finished on its own.
 * - `"length"` — output was truncated at the token cap (likely an empty `text`
 *   when the cap was spent on thinking tokens; see the Gemini note in CLAUDE.md).
 * - `"content_filter"` — the model refused or output was blocked by a safety
 *   filter.
 * - `"tool_use"` — the model stopped to call a tool; see
 *   {@link CompletionResult.toolCalls}.
 * - `"other"` — any other or unrecognized reason.
 */
export type FinishReason =
  | "stop"
  | "length"
  | "content_filter"
  | "tool_use"
  | "other";

/**
 * Token usage for a single completion.
 *
 * `inputTokens` is the **total billable prompt tokens**, including any prompt-cache
 * reads and writes — a superset, normalized across providers so a single cost
 * formula works. (Anthropic reports cache tokens in separate buckets *outside*
 * `input_tokens`; OpenAI/Gemini fold them into their prompt count. Both are
 * normalized to this shape, with the cache counts below as subsets of `inputTokens`.)
 *
 * `totalTokens` is the provider's own total when it reports one (Gemini's includes
 * thinking tokens, so it can exceed input + output), otherwise
 * `inputTokens + outputTokens`.
 */
export type Usage = {
  /** Total billable prompt tokens, including any cache reads/writes. */
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /**
   * The subset of `inputTokens` served from a prompt cache (a discounted read).
   * Set only when the provider reports a non-zero cached-read count (Anthropic
   * `cache_read_input_tokens`, OpenAI `cached_tokens`, Gemini
   * `cachedContentTokenCount`); omitted otherwise.
   */
  cachedInputTokens?: number;
  /**
   * The subset of `inputTokens` written to the cache this call, billed at a write
   * premium. Currently Anthropic only (`cache_creation_input_tokens`); omitted
   * when the provider has no separate cache-write charge or reported none.
   */
  cacheCreationInputTokens?: number;
};

export type CompletionResult = {
  text: string;
  /** The model that actually produced the response. */
  model: string;
  /**
   * Normalized stop reason, or `undefined` if the provider returned none.
   * Lets callers distinguish a real empty answer from a truncated/refused one
   * instead of seeing a bare `text: ""`.
   */
  finishReason?: FinishReason;
  /** The provider's exact stop-reason string, verbatim (before normalization). */
  rawFinishReason?: string;
  /**
   * The refusal message when the model explicitly declined (currently OpenAI's
   * `message.refusal`). When set, `finishReason` is `"content_filter"`.
   */
  refusal?: string;
  /** Token usage for this completion, or `undefined` if the provider reported none. */
  usage?: Usage;
  /**
   * The parsed structured output, set only when {@link CompletionRequest.responseFormat}
   * was given and `text` parsed as JSON. `undefined` if no schema was requested
   * or the output wasn't valid JSON (e.g. truncated at the token cap). The raw
   * JSON is always in `text`. Typed `unknown` — cast to your schema's type.
   */
  parsed?: unknown;
  /**
   * The tool calls the model requested, set only when it called at least one tool
   * (then `finishReason` is `"tool_use"`). Run them and feed results back as
   * {@link ToolResultPart}s. `complete()`-only.
   */
  toolCalls?: ToolCall[];
};

/**
 * A request to embed one or more texts into vectors. Always a batch on the wire
 * — {@link ProviderRegistry.embed} is sugar for a single text. `model` and
 * `dimensions` are optional; `signal` aborts the request like
 * {@link CompletionRequest.signal}.
 */
export type EmbeddingRequest = {
  /** The texts to embed. One vector is returned per entry, in the same order. */
  input: string[];
  /** Override the provider's default embedding model. */
  model?: string;
  /**
   * Reduce the output vector's dimensionality (OpenAI `dimensions` / Gemini
   * `outputDimensionality`). Omit for the model's native size. Compare vectors
   * only when they were produced with the same model and dimension.
   */
  dimensions?: number;
  /** Abort the request when this signal fires (see {@link CompletionRequest.signal}). */
  signal?: AbortSignal;
};

/** The {@link EmbeddingRequest} options minus the `input` texts. */
export type EmbeddingOptions = Omit<EmbeddingRequest, "input">;

/**
 * The result of an embedding call: one vector per input (in input order), the
 * model that produced them, and token usage when the provider reports it.
 */
export type EmbeddingResult = {
  /** One embedding vector per input, in input order. */
  embeddings: number[][];
  /** The model that actually produced the embeddings. */
  model: string;
  /**
   * Token usage, when the provider reports it. Reuses {@link Usage} with
   * `outputTokens: 0` and `totalTokens === inputTokens` (embeddings have no
   * completion tokens), so embedding calls price and aggregate through the same
   * machinery as completions. `undefined` when the provider returns none (e.g.
   * Gemini's embedding endpoint reports no usage).
   */
  usage?: Usage;
};

export type Provider = {
  readonly name: string;
  /** Run a single completion and return the full text. */
  complete(request: CompletionRequest): Promise<CompletionResult>;
  /** Run a single completion, yielding text deltas as they arrive. */
  stream(request: CompletionRequest): AsyncIterable<string>;
  /**
   * Embed one or more texts into vectors. **Optional** — not every provider has
   * an embeddings endpoint (Anthropic does not; it directs users to a dedicated
   * embeddings provider), so this is absent on providers that don't support it.
   * Reach it via {@link ProviderRegistry.embed}/`embedMany`, which throw a clear
   * error when the selected provider doesn't implement it.
   */
  embed?(request: EmbeddingRequest): Promise<EmbeddingResult>;
};

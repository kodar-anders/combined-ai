/**
 * Core, provider-agnostic contract shared by every AI provider in the package.
 *
 * Everything else (additional providers, provider selection, multi-provider
 * combinations) builds on these types.
 */

export type Role = "user" | "assistant";

/** A text segment of a message's content. */
export type TextPart = { type: "text"; text: string };

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
export type ImagePart = { type: "image"; source: MediaSource };

/** A document input, e.g. a PDF (`source.mediaType` should be `"application/pdf"`). */
export type FilePart = {
  type: "file";
  source: MediaSource;
  /** Optional file name (used by OpenAI's file input). */
  filename?: string;
};

/**
 * One part of a structured message content: text, an image, or a file/document.
 * Tool parts will add members to this union in a later step — that is
 * **additive** and non-breaking; the one breaking change was widening
 * {@link Message.content} from `string` to `string | ContentPart[]`.
 *
 * Provider support varies (e.g. OpenAI's Chat Completions has no URL file
 * source); each provider's content mapper handles what its API supports and
 * throws a clear error otherwise.
 */
export type ContentPart = TextPart | ImagePart | FilePart;

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

export type CompletionRequest = {
  messages: Message[];
  /** Optional system prompt applied to the whole request. */
  system?: string;
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
 * - `"other"` — any other or unrecognized reason.
 */
export type FinishReason = "stop" | "length" | "content_filter" | "other";

/**
 * Token usage for a single completion. `totalTokens` is the provider's own total
 * when it reports one (Gemini's includes thinking tokens, so it can exceed
 * input + output), otherwise `inputTokens + outputTokens`.
 */
export type Usage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
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
};

export type Provider = {
  readonly name: string;
  /** Run a single completion and return the full text. */
  complete(request: CompletionRequest): Promise<CompletionResult>;
  /** Run a single completion, yielding text deltas as they arrive. */
  stream(request: CompletionRequest): AsyncIterable<string>;
};

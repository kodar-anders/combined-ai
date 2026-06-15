/**
 * Core, provider-agnostic contract shared by every AI provider in the package.
 *
 * Everything else (additional providers, provider selection, multi-provider
 * combinations) builds on these types.
 */

export type Role = "user" | "assistant";

export type Message = {
  role: Role;
  content: string;
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
};

export type Provider = {
  readonly name: string;
  /** Run a single completion and return the full text. */
  complete(request: CompletionRequest): Promise<CompletionResult>;
  /** Run a single completion, yielding text deltas as they arrive. */
  stream(request: CompletionRequest): AsyncIterable<string>;
};

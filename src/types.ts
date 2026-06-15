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

export type CompletionResult = {
  text: string;
  /** The model that actually produced the response. */
  model: string;
};

export type Provider = {
  readonly name: string;
  /** Run a single completion and return the full text. */
  complete(request: CompletionRequest): Promise<CompletionResult>;
  /** Run a single completion, yielding text deltas as they arrive. */
  stream(request: CompletionRequest): AsyncIterable<string>;
};

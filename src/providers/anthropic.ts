/**
 * Anthropic (Claude) provider, talking to the Messages API directly over
 * `fetch` — no SDK dependency.
 */

import { apiError } from "../errors";
import { requestWithRetry, type RetryOptions } from "../transport";
import {
  type CompletionRequest,
  type CompletionResult,
  type FinishReason,
  type Provider,
} from "../types";

export type AnthropicProviderOptions = {
  apiKey: string;
  /** Defaults to {@link DEFAULT_MODEL}. */
  model?: string;
  /** Defaults to `https://api.anthropic.com`. */
  baseUrl?: string;
  /** Bounded retry/backoff on 429/503/529. Defaults applied when omitted. */
  retry?: RetryOptions;
};

const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

/** Non-streaming default keeps responses under the SDK/HTTP timeout window. */
const DEFAULT_MAX_TOKENS = 16000;
/** Streaming has no timeout concern, so give the model more room. */
const DEFAULT_STREAM_MAX_TOKENS = 64000;

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";

  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #retry?: RetryOptions;

  constructor(options: AnthropicProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#retry = options.retry;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const model = request.model ?? this.#model;
    const response = await requestWithRetry(
      "anthropic",
      `${this.#baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(
          this.#buildBody(request, model, DEFAULT_MAX_TOKENS, false),
        ),
        signal: request.signal,
      },
      this.#retry,
    );

    if (!response.ok) {
      throw await apiError("anthropic", response);
    }

    const data: unknown = await response.json();
    const rawFinishReason = extractFinishReason(data);
    return {
      text: extractText(data),
      model: extractModel(data, model),
      finishReason: normalizeFinishReason(rawFinishReason),
      rawFinishReason,
      refusal: extractRefusal(data),
    };
  }

  async *stream(
    request: CompletionRequest,
  ): AsyncGenerator<string, void, void> {
    const model = request.model ?? this.#model;
    const response = await requestWithRetry(
      "anthropic",
      `${this.#baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(
          this.#buildBody(request, model, DEFAULT_STREAM_MAX_TOKENS, true),
        ),
        signal: request.signal,
      },
      this.#retry,
    );

    if (!response.ok) {
      throw await apiError("anthropic", response);
    }
    if (!response.body) {
      throw new Error("Anthropic streaming response had no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      let result = await reader.read();
      while (!result.done) {
        buffer += decoder.decode(result.value as Uint8Array, { stream: true });

        for (
          let nl = buffer.indexOf("\n");
          nl !== -1;
          nl = buffer.indexOf("\n")
        ) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);

          if (!line.startsWith("data:")) {
            continue;
          }
          const payload = line.slice("data:".length).trim();
          if (payload === "") {
            continue;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }
          if (!isRecord(parsed)) {
            continue;
          }

          if (parsed.type === "message_stop") {
            return;
          }
          if (parsed.type === "error") {
            throw new Error(`Anthropic stream error: ${payload}`);
          }
          if (parsed.type === "content_block_delta") {
            const delta = parsed.delta;
            if (
              isRecord(delta) &&
              delta.type === "text_delta" &&
              typeof delta.text === "string"
            ) {
              yield delta.text;
            }
          }
        }

        result = await reader.read();
      }
    } finally {
      await reader.cancel();
    }
  }

  #headers(): Record<string, string> {
    return {
      "x-api-key": this.#apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    };
  }

  #buildBody(
    request: CompletionRequest,
    model: string,
    defaultMaxTokens: number,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? defaultMaxTokens,
      messages: request.messages,
    };
    if (request.system !== undefined) {
      body.system = request.system;
    }
    if (stream) {
      body.stream = true;
    }
    return body;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function extractText(data: unknown): string {
  const content = isRecord(data) ? toArray(data.content) : [];
  let text = "";
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      text += block.text;
    }
  }
  return text;
}

function extractModel(data: unknown, fallback: string): string {
  if (isRecord(data) && typeof data.model === "string") {
    return data.model;
  }
  return fallback;
}

function extractFinishReason(data: unknown): string | undefined {
  if (isRecord(data) && typeof data.stop_reason === "string") {
    return data.stop_reason;
  }
  return undefined;
}

/** Maps Anthropic's `stop_reason` onto the provider-agnostic union. */
function normalizeFinishReason(
  raw: string | undefined,
): FinishReason | undefined {
  switch (raw) {
    case undefined:
      return undefined;
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return "other";
  }
}

/** Text from any `type: "refusal"` content blocks `extractText` skips. */
function extractRefusal(data: unknown): string | undefined {
  const content = isRecord(data) ? toArray(data.content) : [];
  let refusal = "";
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "refusal" &&
      typeof block.text === "string"
    ) {
      refusal += block.text;
    }
  }
  return refusal === "" ? undefined : refusal;
}

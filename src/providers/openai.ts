/**
 * OpenAI provider, talking to the Chat Completions API directly over `fetch` —
 * no SDK dependency.
 */

import { apiError, apiErrorFromBody } from "../errors";
import { requestWithRetry, type RetryOptions } from "../transport";
import {
  type CompletionRequest,
  type CompletionResult,
  type FinishReason,
  type Message,
  type Provider,
} from "../types";

export type OpenAIProviderOptions = {
  apiKey: string;
  /** Defaults to {@link DEFAULT_MODEL}. */
  model?: string;
  /** Defaults to `https://api.openai.com`. */
  baseUrl?: string;
  /** Bounded retry/backoff on 429/503/529. Defaults applied when omitted. */
  retry?: RetryOptions;
};

const DEFAULT_MODEL = "gpt-4.1";
const DEFAULT_BASE_URL = "https://api.openai.com";

/** Non-streaming default keeps responses under the HTTP timeout window. */
const DEFAULT_MAX_TOKENS = 16000;
/** Streaming has no timeout concern, so give the model more room. */
const DEFAULT_STREAM_MAX_TOKENS = 64000;

export class OpenAIProvider implements Provider {
  readonly name = "openai";

  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #retry?: RetryOptions;

  constructor(options: OpenAIProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#retry = options.retry;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const model = request.model ?? this.#model;
    const response = await requestWithRetry(
      "openai",
      `${this.#baseUrl}/v1/chat/completions`,
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
      throw await apiError("openai", response);
    }

    const data: unknown = await response.json();
    if (isRecord(data) && isRecord(data.error)) {
      throw apiErrorFromBody("openai", response.status, data);
    }
    const rawFinishReason = extractFinishReason(data);
    const refusal = extractRefusal(data);
    return {
      text: extractText(data),
      model: extractModel(data, model),
      // A refusal is a content-filter outcome even though OpenAI still reports
      // finish_reason: "stop", so surface it as such regardless of the raw value.
      finishReason:
        refusal === undefined
          ? normalizeFinishReason(rawFinishReason)
          : "content_filter",
      rawFinishReason,
      refusal,
    };
  }

  async *stream(
    request: CompletionRequest,
  ): AsyncGenerator<string, void, void> {
    const model = request.model ?? this.#model;
    const response = await requestWithRetry(
      "openai",
      `${this.#baseUrl}/v1/chat/completions`,
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
      throw await apiError("openai", response);
    }
    if (!response.body) {
      throw new Error("OpenAI streaming response had no body");
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
          if (payload === "[DONE]") {
            return;
          }
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

          if (isRecord(parsed.error)) {
            throw new Error(`OpenAI stream error: ${payload}`);
          }

          const delta = firstChoiceDelta(parsed);
          if (isRecord(delta) && typeof delta.content === "string") {
            yield delta.content;
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
      authorization: `Bearer ${this.#apiKey}`,
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
      max_completion_tokens: request.maxTokens ?? defaultMaxTokens,
      messages: toOpenAIMessages(request),
    };
    if (stream) {
      body.stream = true;
    }
    return body;
  }
}

/**
 * OpenAI carries the system prompt as a leading `system` message rather than a
 * top-level field, so fold {@link CompletionRequest.system} into the array.
 */
function toOpenAIMessages(
  request: CompletionRequest,
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> =
    request.messages.map((message: Message) => ({
      role: message.role,
      content: message.content,
    }));
  if (request.system !== undefined) {
    messages.unshift({ role: "system", content: request.system });
  }
  return messages;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function firstChoice(data: unknown): Record<string, unknown> | undefined {
  const choices = isRecord(data) ? toArray(data.choices) : [];
  const first = choices[0];
  return isRecord(first) ? first : undefined;
}

function extractText(data: unknown): string {
  const message = firstChoice(data)?.message;
  if (isRecord(message) && typeof message.content === "string") {
    return message.content;
  }
  return "";
}

function firstChoiceDelta(data: unknown): unknown {
  return firstChoice(data)?.delta;
}

function extractModel(data: unknown, fallback: string): string {
  if (isRecord(data) && typeof data.model === "string") {
    return data.model;
  }
  return fallback;
}

function extractFinishReason(data: unknown): string | undefined {
  const reason = firstChoice(data)?.finish_reason;
  return typeof reason === "string" ? reason : undefined;
}

/** Maps OpenAI's `finish_reason` onto the provider-agnostic union. */
function normalizeFinishReason(
  raw: string | undefined,
): FinishReason | undefined {
  switch (raw) {
    case undefined:
      return undefined;
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "other";
  }
}

function extractRefusal(data: unknown): string | undefined {
  const message = firstChoice(data)?.message;
  if (
    isRecord(message) &&
    typeof message.refusal === "string" &&
    message.refusal !== ""
  ) {
    return message.refusal;
  }
  return undefined;
}

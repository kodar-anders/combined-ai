/**
 * Anthropic (Claude) provider, talking to the Messages API directly over
 * `fetch` — no SDK dependency.
 */

import {
  type CompletionRequest,
  type CompletionResult,
  type Provider,
} from "../types";

export type AnthropicProviderOptions = {
  apiKey: string;
  /** Defaults to {@link DEFAULT_MODEL}. */
  model?: string;
  /** Defaults to `https://api.anthropic.com`. */
  baseUrl?: string;
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

  constructor(options: AnthropicProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const model = request.model ?? this.#model;
    const response = await fetch(`${this.#baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(
        this.#buildBody(request, model, DEFAULT_MAX_TOKENS, false),
      ),
    });

    if (!response.ok) {
      throw await requestError(response);
    }

    const data: unknown = await response.json();
    return {
      text: extractText(data),
      model: extractModel(data, model),
    };
  }

  async *stream(
    request: CompletionRequest,
  ): AsyncGenerator<string, void, void> {
    const model = request.model ?? this.#model;
    const response = await fetch(`${this.#baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(
        this.#buildBody(request, model, DEFAULT_STREAM_MAX_TOKENS, true),
      ),
    });

    if (!response.ok) {
      throw await requestError(response);
    }
    if (!response.body) {
      throw new Error("Anthropic streaming response had no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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
        const parsed: unknown = JSON.parse(payload);
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

async function requestError(response: Response): Promise<Error> {
  const detail = await response.text();
  return new Error(`Anthropic request failed (${response.status}): ${detail}`);
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

/**
 * Google Gemini provider, talking to the Generative Language API directly over
 * `fetch` — no SDK dependency.
 */

import {
  type CompletionRequest,
  type CompletionResult,
  type Message,
  type Provider,
} from "../types";

export type GeminiProviderOptions = {
  apiKey: string;
  /** Defaults to {@link DEFAULT_MODEL}. */
  model?: string;
  /** Defaults to `https://generativelanguage.googleapis.com`. */
  baseUrl?: string;
};

const DEFAULT_MODEL = "gemini-2.5-pro";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

/** Non-streaming default keeps responses under the HTTP timeout window. */
const DEFAULT_MAX_TOKENS = 16000;
/** Streaming has no timeout concern, so give the model more room. */
const DEFAULT_STREAM_MAX_TOKENS = 64000;

export class GeminiProvider implements Provider {
  readonly name = "gemini";

  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;

  constructor(options: GeminiProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const model = request.model ?? this.#model;
    const response = await fetch(this.#url(model, false), {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(this.#buildBody(request, DEFAULT_MAX_TOKENS)),
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
    const response = await fetch(this.#url(model, true), {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(this.#buildBody(request, DEFAULT_STREAM_MAX_TOKENS)),
    });

    if (!response.ok) {
      throw await requestError(response);
    }
    if (!response.body) {
      throw new Error("Gemini streaming response had no body");
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

          if (isRecord(parsed.error)) {
            throw new Error(`Gemini stream error: ${payload}`);
          }

          const text = extractText(parsed);
          if (text.length > 0) {
            yield text;
          }
        }

        result = await reader.read();
      }
    } finally {
      await reader.cancel();
    }
  }

  /**
   * Gemini puts the model and the action in the path (`:generateContent` vs
   * `:streamGenerateContent`); streaming additionally needs `?alt=sse` to get an
   * SSE body rather than a streamed JSON array.
   */
  #url(model: string, stream: boolean): string {
    const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    return `${this.#baseUrl}/v1beta/models/${model}:${action}`;
  }

  #headers(): Record<string, string> {
    return {
      "x-goog-api-key": this.#apiKey,
      "content-type": "application/json",
    };
  }

  #buildBody(
    request: CompletionRequest,
    defaultMaxTokens: number,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      contents: request.messages.map((message) => toGeminiContent(message)),
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? defaultMaxTokens,
      },
    };
    if (request.system !== undefined) {
      body.systemInstruction = { parts: [{ text: request.system }] };
    }
    return body;
  }
}

/**
 * Gemini names the assistant role `model` and carries text inside a `parts`
 * array rather than a flat `content` string.
 */
function toGeminiContent(message: Message): {
  role: string;
  parts: Array<{ text: string }>;
} {
  return {
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  };
}

async function requestError(response: Response): Promise<Error> {
  const detail = await response.text();
  return new Error(`Gemini request failed (${response.status}): ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function extractText(data: unknown): string {
  const candidates = isRecord(data) ? toArray(data.candidates) : [];
  const first = candidates[0];
  const content = isRecord(first) ? first.content : undefined;
  const parts = isRecord(content) ? toArray(content.parts) : [];
  let text = "";
  for (const part of parts) {
    if (isRecord(part) && typeof part.text === "string") {
      text += part.text;
    }
  }
  return text;
}

function extractModel(data: unknown, fallback: string): string {
  if (isRecord(data) && typeof data.modelVersion === "string") {
    return data.modelVersion;
  }
  return fallback;
}

/**
 * Google Gemini provider, talking to the Generative Language API directly over
 * `fetch` — no SDK dependency.
 */

import { apiError, apiErrorFromBody } from "../errors";
import { extractModel, isRecord } from "./extract";
import { sseJson } from "./sse";
import { parseStructured } from "./structured";
import { requestWithRetry, type RetryOptions } from "../transport";
import {
  type CompletionRequest,
  type CompletionResult,
  type ContentPart,
  type FinishReason,
  type MediaSource,
  type Message,
  type Provider,
  type ToolCall,
  type ToolChoice,
  type Usage,
} from "../types";

export type GeminiProviderOptions = {
  apiKey: string;
  /** Defaults to {@link DEFAULT_MODEL}. */
  model?: string;
  /** Defaults to `https://generativelanguage.googleapis.com`. */
  baseUrl?: string;
  /** Bounded retry/backoff on 429/503/529. Defaults applied when omitted. */
  retry?: RetryOptions;
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
  readonly #retry?: RetryOptions;

  constructor(options: GeminiProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#retry = options.retry;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const model = request.model ?? this.#model;
    const response = await requestWithRetry(
      "gemini",
      this.#url(model, false),
      {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(this.#buildBody(request, DEFAULT_MAX_TOKENS)),
        signal: request.signal,
      },
      this.#retry,
    );

    if (!response.ok) {
      throw await apiError("gemini", response);
    }

    const data: unknown = await response.json();
    if (isRecord(data) && isRecord(data.error)) {
      throw apiErrorFromBody("gemini", response.status, data);
    }
    const rawFinishReason = extractFinishReason(data);
    const text = extractText(data);
    const toolCalls = extractToolCalls(data);
    const finishReason = normalizeFinishReason(rawFinishReason);
    return {
      text,
      model: extractModel(data, model, "modelVersion"),
      // Gemini reports `STOP` even when it emits a function call, so surface
      // `tool_use` — but only on a clean stop. A real `MAX_TOKENS`/`SAFETY` stop
      // (e.g. truncated args) must not be masked, so keep its normalized reason.
      finishReason:
        toolCalls !== undefined &&
        (finishReason === "stop" || finishReason === undefined)
          ? "tool_use"
          : finishReason,
      rawFinishReason,
      usage: extractUsage(data),
      parsed: parseStructured(request, text),
      toolCalls,
    };
  }

  async *stream(
    request: CompletionRequest,
  ): AsyncGenerator<string, void, void> {
    const model = request.model ?? this.#model;
    const response = await requestWithRetry(
      "gemini",
      this.#url(model, true),
      {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(
          this.#buildBody(request, DEFAULT_STREAM_MAX_TOKENS),
        ),
        signal: request.signal,
      },
      this.#retry,
    );

    if (!response.ok) {
      throw await apiError("gemini", response);
    }
    if (!response.body) {
      throw new Error("Gemini streaming response had no body");
    }

    for await (const event of sseJson(response.body)) {
      if (isRecord(event.error)) {
        throw new Error(`Gemini stream error: ${JSON.stringify(event)}`);
      }
      const text = extractText(event);
      if (text.length > 0) {
        yield text;
      }
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
    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: request.maxTokens ?? defaultMaxTokens,
    };
    if (request.responseFormat !== undefined) {
      // Gemini's native structured output lives on generationConfig: a JSON MIME
      // type plus an OpenAPI-3-subset schema (UPPERCASE types — see toGeminiSchema).
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseSchema = toGeminiSchema(
        request.responseFormat.schema,
      );
    }
    const body: Record<string, unknown> = {
      contents: request.messages.map((message) => toGeminiContent(message)),
      generationConfig,
    };
    if (request.system !== undefined) {
      body.systemInstruction = { parts: [{ text: request.system }] };
    }
    if (request.tools !== undefined) {
      // Tool parameter schemas need the same OpenAPI-3-subset transform as
      // structured output (UPPERCASE types).
      body.tools = [
        {
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: toGeminiSchema(tool.parameters),
          })),
        },
      ];
    }
    if (request.toolChoice !== undefined) {
      body.toolConfig = {
        functionCallingConfig: toGeminiFunctionCallingConfig(
          request.toolChoice,
        ),
      };
    }
    return body;
  }
}

/** Map the provider-agnostic tool choice onto Gemini's `functionCallingConfig`. */
function toGeminiFunctionCallingConfig(
  choice: ToolChoice,
): Record<string, unknown> {
  if (typeof choice === "object") {
    // Force this one tool: ANY mode restricted to its name.
    return { mode: "ANY", allowedFunctionNames: [choice.name] };
  }
  const mode = { auto: "AUTO", any: "ANY", none: "NONE" }[choice];
  return { mode };
}

/**
 * Convert a JSON Schema to Gemini's OpenAPI-3 subset. The load-bearing
 * difference is that `type` values are UPPERCASE (`"string"` → `"STRING"`); we
 * recurse through `properties`/`items`/`anyOf`/`allOf`/`oneOf` and uppercase
 * each scalar `type`. Other keywords pass through (Gemini silently ignores ones
 * it doesn't support); advanced features (null-union types, `$ref`, numeric/
 * length constraints) aren't translated — keep schemas within the documented
 * cross-provider subset.
 */
function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => toGeminiSchema(entry));
  }
  if (!isRecord(schema)) {
    return schema;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type" && typeof value === "string") {
      out[key] = value.toUpperCase();
    } else if (key === "properties" && isRecord(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, propSchema]) => [
          name,
          toGeminiSchema(propSchema),
        ]),
      );
    } else if (key === "items") {
      out[key] = toGeminiSchema(value);
    } else if (
      ["anyOf", "allOf", "oneOf"].includes(key) &&
      Array.isArray(value)
    ) {
      out[key] = value.map((entry) => toGeminiSchema(entry));
    } else {
      out[key] = value;
    }
  }
  return out;
}

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType?: string; fileUri: string } }
  | {
      functionCall: {
        name: string;
        id?: string;
        args: Record<string, unknown>;
      };
    }
  | {
      functionResponse: {
        name?: string;
        id?: string;
        response: Record<string, unknown>;
      };
    };

/**
 * Gemini names the assistant role `model` and carries content inside a `parts`
 * array. A bare-`string` content becomes a single text part; structured content
 * is mapped part-by-part. Images and files map alike: inline base64 bytes become
 * an `inlineData` part, a URL becomes a `fileData` reference (see {@link toGeminiMedia}).
 */
function toGeminiContent(message: Message): {
  role: string;
  parts: GeminiPart[];
} {
  return {
    role: message.role === "assistant" ? "model" : "user",
    parts:
      typeof message.content === "string"
        ? [{ text: message.content }]
        : message.content.map((part) => toGeminiPart(part)),
  };
}

function toGeminiPart(part: ContentPart): GeminiPart {
  switch (part.type) {
    case "text":
      return { text: part.text };
    case "image":
    case "file":
      return toGeminiMedia(part.source);
    case "tool_use":
      return {
        functionCall: {
          name: part.name,
          ...(part.id === undefined ? {} : { id: part.id }),
          args: part.input,
        },
      };
    case "tool_result":
      // Gemini correlates a result to its call by function name, so name is
      // required here (unlike Anthropic/OpenAI, which match by id).
      if (part.name === undefined) {
        throw new Error(
          "Gemini requires the tool name on each tool result; set ToolResultPart.name to the called tool's name.",
        );
      }
      // Gemini's functionResponse.response is an object; wrap the text output.
      return {
        functionResponse: {
          name: part.name,
          ...(part.toolUseId === undefined ? {} : { id: part.toolUseId }),
          response: { result: part.content },
        },
      };
  }
}

/**
 * Map a media source to a Gemini part. Base64 bytes become inline `inlineData`.
 * A URL becomes a `fileData` reference — but Gemini's `fileData.fileUri` only
 * accepts a Files API URI or a `gs://` Cloud Storage URI, **not** an arbitrary
 * public web URL (unlike Anthropic/OpenAI image URLs). Passing a plain `https://`
 * URL will be rejected by Gemini; use a base64 source or a Files API URI instead.
 */
function toGeminiMedia(source: MediaSource): GeminiPart {
  if (source.kind === "base64") {
    return { inlineData: { mimeType: source.mediaType, data: source.data } };
  }
  return {
    fileData:
      source.mediaType === undefined
        ? { fileUri: source.url }
        : { mimeType: source.mediaType, fileUri: source.url },
  };
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** The first candidate of a response (`candidates[0]`), or `undefined`. */
function firstCandidate(data: unknown): Record<string, unknown> | undefined {
  const candidates = isRecord(data) ? toArray(data.candidates) : [];
  const first = candidates[0];
  return isRecord(first) ? first : undefined;
}

/** The parts of the first candidate's content (`candidates[0].content.parts`). */
function firstCandidateParts(data: unknown): unknown[] {
  const content = firstCandidate(data)?.content;
  return isRecord(content) ? toArray(content.parts) : [];
}

function extractText(data: unknown): string {
  let text = "";
  for (const part of firstCandidateParts(data)) {
    if (isRecord(part) && typeof part.text === "string") {
      text += part.text;
    }
  }
  return text;
}

/** Collect any `functionCall` parts as provider-agnostic tool calls. */
function extractToolCalls(data: unknown): ToolCall[] | undefined {
  const parts = firstCandidateParts(data);
  const calls: ToolCall[] = [];
  for (const part of parts) {
    const call = isRecord(part) ? part.functionCall : undefined;
    if (isRecord(call) && typeof call.name === "string") {
      calls.push({
        id: typeof call.id === "string" ? call.id : undefined,
        name: call.name,
        input: isRecord(call.args) ? call.args : {},
      });
    }
  }
  return calls.length > 0 ? calls : undefined;
}

/**
 * Gemini reports the stop reason on the first candidate. When the prompt itself
 * was blocked there are no candidates, so fall back to `promptFeedback.blockReason`.
 */
function extractFinishReason(data: unknown): string | undefined {
  const first = firstCandidate(data);
  if (first !== undefined && typeof first.finishReason === "string") {
    return first.finishReason;
  }
  const feedback = isRecord(data) ? data.promptFeedback : undefined;
  if (isRecord(feedback) && typeof feedback.blockReason === "string") {
    return feedback.blockReason;
  }
  return undefined;
}

/**
 * Gemini reports `usageMetadata.promptTokenCount`/`candidatesTokenCount`/
 * `totalTokenCount`. `totalTokenCount` includes thinking tokens, so it can
 * exceed prompt + candidates — we keep the provider's own total verbatim.
 */
function extractUsage(data: unknown): Usage | undefined {
  const usage = isRecord(data) ? data.usageMetadata : undefined;
  if (!isRecord(usage)) {
    return undefined;
  }
  const inputTokens =
    typeof usage.promptTokenCount === "number" ? usage.promptTokenCount : 0;
  const outputTokens =
    typeof usage.candidatesTokenCount === "number"
      ? usage.candidatesTokenCount
      : 0;
  const totalTokens =
    typeof usage.totalTokenCount === "number"
      ? usage.totalTokenCount
      : inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

/** Maps Gemini's `finishReason` (and prompt block reasons) onto the union. */
function normalizeFinishReason(
  raw: string | undefined,
): FinishReason | undefined {
  switch (raw) {
    case undefined:
      return undefined;
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "content_filter";
    default:
      return "other";
  }
}

/**
 * OpenAI provider, talking to the Chat Completions API directly over `fetch` —
 * no SDK dependency.
 */

import { apiError, apiErrorFromBody } from "../errors";
import { extractModel, isRecord } from "./extract";
import { sseJson } from "./sse";
import { parseStructured } from "./structured";
import { requestWithRetry, type RetryOptions } from "../transport";
import {
  type CompletionRequest,
  type CompletionResult,
  type EmbeddingRequest,
  type EmbeddingResult,
  type FilePart,
  type FinishReason,
  type ImagePart,
  type MediaSource,
  type Message,
  type Provider,
  type TextPart,
  type ToolCall,
  type ToolChoice,
  type Usage,
} from "../types";

export type OpenAIProviderOptions = {
  apiKey: string;
  /** Defaults to {@link DEFAULT_MODEL}. */
  model?: string;
  /** Defaults to `https://api.openai.com`. */
  baseUrl?: string;
  /**
   * Extra headers merged into (and able to override) every request's headers —
   * for an OpenAI-compatible gateway's auth/routing (e.g. OpenRouter's
   * `HTTP-Referer`/`X-Title`) or a proxy. Use lowercase header names.
   */
  headers?: Record<string, string>;
  /** Bounded retry/backoff on 429/503/529. Defaults applied when omitted. */
  retry?: RetryOptions;
};

const DEFAULT_MODEL = "gpt-4.1";
const DEFAULT_EMBED_MODEL = "text-embedding-3-small";
const DEFAULT_BASE_URL = "https://api.openai.com";

/** Non-streaming default keeps responses under the HTTP timeout window. */
const DEFAULT_MAX_TOKENS = 16000;
/** Streaming has no timeout concern, so give the model more room. */
const DEFAULT_STREAM_MAX_TOKENS = 64000;

export class OpenAIProvider implements Provider {
  readonly name: string;

  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #extraHeaders?: Record<string, string>;
  readonly #retry?: RetryOptions;

  /**
   * `name` is the provider's identity, used as `this.name` and in error
   * attribution (`ProviderError.provider`). It defaults to `"openai"`; the
   * registry passes a custom name for an OpenAI-compatible gateway so its errors
   * aren't mislabeled `"openai"`. It's a constructor argument rather than a
   * public option because only the registry sets it — it isn't user config.
   */
  constructor(options: OpenAIProviderOptions, name = "openai") {
    this.name = name;
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#extraHeaders = options.headers;
    this.#retry = options.retry;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const model = request.model ?? this.#model;
    const response = await requestWithRetry(
      this.name,
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
      throw await apiError(this.name, response);
    }

    const data: unknown = await response.json();
    if (isRecord(data) && isRecord(data.error)) {
      throw apiErrorFromBody(this.name, response.status, data);
    }
    const rawFinishReason = extractFinishReason(data);
    const refusal = extractRefusal(data);
    const text = extractText(data);
    return {
      text,
      model: extractModel(data, model),
      // A refusal is a content-filter outcome even though OpenAI still reports
      // finish_reason: "stop", so surface it as such regardless of the raw value.
      finishReason:
        refusal === undefined
          ? normalizeFinishReason(rawFinishReason)
          : "content_filter",
      rawFinishReason,
      refusal,
      usage: extractUsage(data),
      parsed: parseStructured(request, text),
      toolCalls: extractToolCalls(data),
    };
  }

  async *stream(
    request: CompletionRequest,
  ): AsyncGenerator<string, void, void> {
    const model = request.model ?? this.#model;
    const response = await requestWithRetry(
      this.name,
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
      throw await apiError(this.name, response);
    }
    if (!response.body) {
      throw new Error("OpenAI streaming response had no body");
    }

    for await (const event of sseJson(response.body)) {
      if (isRecord(event.error)) {
        throw new Error(`OpenAI stream error: ${JSON.stringify(event)}`);
      }
      const delta = firstChoiceDelta(event);
      if (isRecord(delta) && typeof delta.content === "string") {
        yield delta.content;
      }
    }
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const model = request.model ?? DEFAULT_EMBED_MODEL;
    // `encoding_format` defaults to "float" (a JSON number array), which is what
    // we want; no need to send it. `input` accepts the array directly.
    const body: Record<string, unknown> = { model, input: request.input };
    if (request.dimensions !== undefined) {
      body.dimensions = request.dimensions;
    }
    const response = await requestWithRetry(
      this.name,
      `${this.#baseUrl}/v1/embeddings`,
      {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal: request.signal,
      },
      this.#retry,
    );

    if (!response.ok) {
      throw await apiError(this.name, response);
    }

    const data: unknown = await response.json();
    if (isRecord(data) && isRecord(data.error)) {
      throw apiErrorFromBody(this.name, response.status, data);
    }
    return {
      embeddings: extractEmbeddings(data),
      model: extractModel(data, model),
      // An embeddings response carries only prompt tokens, so the shared
      // completion usage parser yields `outputTokens: 0` for it (and the
      // embedding models price output at $0 anyway).
      usage: extractUsage(data),
    };
  }

  #headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.#apiKey}`,
      "content-type": "application/json",
      ...this.#extraHeaders,
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
    if (request.responseFormat !== undefined) {
      // OpenAI Structured Outputs: response_format.json_schema with strict:true
      // (requires additionalProperties:false + every property in `required`).
      // `name` is required and must match ^[A-Za-z0-9_-]+$.
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: request.responseFormat.name ?? "response",
          strict: true,
          schema: request.responseFormat.schema,
        },
      };
    }
    if (request.tools !== undefined) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }
    if (request.toolChoice !== undefined) {
      body.tool_choice = toOpenAIToolChoice(request.toolChoice);
    }
    if (stream) {
      body.stream = true;
    }
    return body;
  }
}

/** Map the provider-agnostic tool choice onto OpenAI's `tool_choice`. */
function toOpenAIToolChoice(choice: ToolChoice): unknown {
  if (typeof choice === "object") {
    return { type: "function", function: { name: choice.name } };
  }
  // "any" is OpenAI's "required"; "auto"/"none" map by name.
  return choice === "any" ? "required" : choice;
}

type OpenAIPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename?: string; file_data: string } };

type OpenAIToolCall = {
  id?: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OpenAIMessage =
  | {
      role: string;
      content: string | OpenAIPart[] | null;
      tool_calls?: OpenAIToolCall[];
    }
  | { role: "tool"; tool_call_id?: string; content: string };

/** Content parts other than tool parts (which OpenAI carries at the message level). */
type OpenAIContentPart = TextPart | ImagePart | FilePart;

/**
 * OpenAI carries the system prompt as a leading `system` message rather than a
 * top-level field, so fold {@link CompletionRequest.system} into the array. A
 * message may expand to several wire messages: OpenAI represents tool calls on an
 * assistant message's `tool_calls`, and each tool result as its own `tool`-role
 * message — so tool parts are handled at the message level, not as content parts.
 */
function toOpenAIMessages(request: CompletionRequest): OpenAIMessage[] {
  const messages = request.messages.flatMap((message) =>
    toOpenAIWireMessages(message),
  );
  if (request.system !== undefined) {
    // OpenAI has no per-request cache breakpoints (it caches automatically), so a
    // SystemPrompt's cacheControl is ignored — read its text only.
    const content =
      typeof request.system === "string" ? request.system : request.system.text;
    messages.unshift({ role: "system", content });
  }
  return messages;
}

function toOpenAIWireMessages(message: Message): OpenAIMessage[] {
  if (typeof message.content === "string") {
    return [{ role: message.role, content: message.content }];
  }

  const toolUses = message.content.filter((p) => p.type === "tool_use");
  const toolResults = message.content.filter((p) => p.type === "tool_result");
  const rest = message.content.filter((p): p is OpenAIContentPart =>
    ["text", "image", "file"].includes(p.type),
  );

  // An assistant turn that called tools: content (if any) plus `tool_calls`.
  if (toolUses.length > 0) {
    return [
      {
        role: message.role,
        content: rest.length > 0 ? rest.map((p) => toOpenAIPart(p)) : null,
        tool_calls: toolUses.map((u) => {
          if (u.id === undefined) {
            throw new Error(
              "OpenAI requires an id on each tool call; replay the ToolCall.id you received from the model.",
            );
          }
          return {
            id: u.id,
            type: "function",
            function: { name: u.name, arguments: JSON.stringify(u.input) },
          };
        }),
      },
    ];
  }

  // Tool results become one `tool`-role message each; any other parts follow as a
  // normal message.
  const out: OpenAIMessage[] = toolResults.map((r) => {
    if (r.toolUseId === undefined) {
      throw new Error(
        "OpenAI requires toolUseId on each tool result; set it to the id of the ToolCall you are answering.",
      );
    }
    return { role: "tool", tool_call_id: r.toolUseId, content: r.content };
  });
  if (rest.length > 0) {
    out.push({ role: message.role, content: rest.map((p) => toOpenAIPart(p)) });
  }
  return out;
}

function toOpenAIPart(part: OpenAIContentPart): OpenAIPart {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return {
        type: "image_url",
        image_url: { url: toOpenAIUrl(part.source) },
      };
    case "file":
      return { type: "file", file: toOpenAIFile(part) };
  }
}

/** An image source becomes either an https URL or a base64 `data:` URI. */
function toOpenAIUrl(source: MediaSource): string {
  return source.kind === "base64"
    ? `data:${source.mediaType};base64,${source.data}`
    : source.url;
}

/**
 * Chat Completions takes a file only as inline base64 (`file_data`, a `data:`
 * URI) — there is no URL file source — so a `url` file source is unsupported.
 */
function toOpenAIFile(part: FilePart): {
  filename?: string;
  file_data: string;
} {
  if (part.source.kind !== "base64") {
    throw new Error(
      "OpenAI (Chat Completions) does not support a URL file source; use a base64 source.",
    );
  }
  const file_data = `data:${part.source.mediaType};base64,${part.source.data}`;
  return part.filename === undefined
    ? { file_data }
    : { filename: part.filename, file_data };
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

/**
 * Collect `choices[0].message.tool_calls` as provider-agnostic tool calls.
 * OpenAI's `arguments` is a JSON **string**, so it's parsed into the `input`
 * object (a malformed/empty string yields `{}`).
 */
function extractToolCalls(data: unknown): ToolCall[] | undefined {
  const message = firstChoice(data)?.message;
  const toolCalls = isRecord(message) ? toArray(message.tool_calls) : [];
  const calls: ToolCall[] = [];
  for (const call of toolCalls) {
    if (!isRecord(call) || !isRecord(call.function)) {
      continue;
    }
    const fn = call.function;
    if (typeof fn.name !== "string") {
      continue;
    }
    calls.push({
      id: typeof call.id === "string" ? call.id : undefined,
      name: fn.name,
      input: parseArguments(fn.arguments),
    });
  }
  return calls.length > 0 ? calls : undefined;
}

function parseArguments(args: unknown): Record<string, unknown> {
  if (typeof args !== "string") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(args);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
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
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return "other";
  }
}

/**
 * OpenAI reports `usage.prompt_tokens`/`completion_tokens`/`total_tokens`, with any
 * cached prompt tokens nested under `prompt_tokens_details.cached_tokens` — a subset
 * of `prompt_tokens`, so `inputTokens` already includes them. The cached count is
 * clamped to `[0, inputTokens]` to defend against a gateway over-reporting it.
 */
function extractUsage(data: unknown): Usage | undefined {
  const usage = isRecord(data) ? data.usage : undefined;
  if (!isRecord(usage)) {
    return undefined;
  }
  const inputTokens =
    typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const outputTokens =
    typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  const totalTokens =
    typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : inputTokens + outputTokens;
  const details = usage.prompt_tokens_details;
  const cachedRaw =
    isRecord(details) && typeof details.cached_tokens === "number"
      ? details.cached_tokens
      : 0;
  const cachedInputTokens = Math.min(Math.max(0, cachedRaw), inputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
  };
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

function toNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((n): n is number => typeof n === "number")
    : [];
}

/**
 * Map `data[]` to one vector per input, **sorted by `index`** — the API returns
 * them in input order, but sorting defensively guarantees the caller's ordering.
 */
function extractEmbeddings(data: unknown): number[][] {
  const rows = isRecord(data) ? toArray(data.data) : [];
  return (
    rows
      .filter(isRecord)
      .map((row) => ({
        index: typeof row.index === "number" ? row.index : 0,
        embedding: toNumberArray(row.embedding),
      }))
      // eslint-disable-next-line unicorn/no-array-sort -- toSorted() needs ES2023; the lib target is ES2022. The array is freshly mapped, so mutating sort is safe.
      .sort((a, b) => a.index - b.index)
      .map((row) => row.embedding)
  );
}

/**
 * Anthropic (Claude) provider, talking to the Messages API directly over
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
  type Role,
  type ToolCall,
  type ToolChoice,
  type Usage,
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
    if (isRecord(data) && isRecord(data.error)) {
      throw apiErrorFromBody("anthropic", response.status, data);
    }
    const rawFinishReason = extractFinishReason(data);
    const text = extractText(data);
    return {
      text,
      model: extractModel(data, model),
      finishReason: normalizeFinishReason(rawFinishReason),
      rawFinishReason,
      refusal: extractRefusal(data),
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

    for await (const event of sseJson(response.body)) {
      if (event.type === "message_stop") {
        return;
      }
      if (event.type === "error") {
        throw new Error(`Anthropic stream error: ${JSON.stringify(event)}`);
      }
      if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (
          isRecord(delta) &&
          delta.type === "text_delta" &&
          typeof delta.text === "string"
        ) {
          yield delta.text;
        }
      }
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
      messages: request.messages.map((message) => toAnthropicMessage(message)),
    };
    if (request.system !== undefined) {
      body.system = request.system;
    }
    if (request.responseFormat !== undefined) {
      // Anthropic's native structured output: a top-level output_config.format
      // (no name/strict wrapper). The schema is passed through as-is.
      body.output_config = {
        format: { type: "json_schema", schema: request.responseFormat.schema },
      };
    }
    if (request.tools !== undefined) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }
    if (request.toolChoice !== undefined) {
      body.tool_choice = toAnthropicToolChoice(request.toolChoice);
    }
    if (stream) {
      body.stream = true;
    }
    return body;
  }
}

/** Map the provider-agnostic tool choice onto Anthropic's `tool_choice`. */
function toAnthropicToolChoice(choice: ToolChoice): Record<string, unknown> {
  if (typeof choice === "object") {
    return { type: "tool", name: choice.name };
  }
  // "auto" | "any" | "none" map to Anthropic's own type names directly.
  return { type: choice };
}

type AnthropicSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string };

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: AnthropicSource }
  | { type: "document"; source: AnthropicSource }
  | {
      type: "tool_use";
      id?: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id?: string;
      content: string;
      is_error?: boolean;
    };

/**
 * Map a message onto Anthropic's wire shape. A bare-`string` content is sent
 * as-is (Anthropic accepts a string or an array of content blocks); structured
 * content is mapped block-by-block. An image is an `image` block, a file a
 * `document` block (PDF/text).
 */
function toAnthropicMessage(message: Message): {
  role: Role;
  content: string | AnthropicBlock[];
} {
  if (typeof message.content === "string") {
    return { role: message.role, content: message.content };
  }
  const blocks = message.content.map((part) => toAnthropicBlock(part));
  // Anthropic requires tool_result blocks to come first in a user turn, so hoist
  // them ahead of any text the caller placed before them (a no-op when there are
  // none). Relative order within each group is preserved.
  const toolResults = blocks.filter((b) => b.type === "tool_result");
  const rest = blocks.filter((b) => b.type !== "tool_result");
  return { role: message.role, content: [...toolResults, ...rest] };
}

function toAnthropicBlock(part: ContentPart): AnthropicBlock {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return { type: "image", source: toAnthropicSource(part.source) };
    case "file":
      return { type: "document", source: toAnthropicSource(part.source) };
    case "tool_use":
      return {
        type: "tool_use",
        id: part.id,
        name: part.name,
        input: part.input,
      };
    case "tool_result":
      // Anthropic wants tool_result blocks first in the user turn; the caller is
      // responsible for ordering (the low-level protocol puts them in their own
      // message). is_error is omitted unless set.
      return {
        type: "tool_result",
        tool_use_id: part.toolUseId,
        content: part.content,
        ...(part.isError === undefined ? {} : { is_error: part.isError }),
      };
  }
}

function toAnthropicSource(source: MediaSource): AnthropicSource {
  return source.kind === "base64"
    ? { type: "base64", media_type: source.mediaType, data: source.data }
    : { type: "url", url: source.url };
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

/** Collect any `tool_use` content blocks as provider-agnostic tool calls. */
function extractToolCalls(data: unknown): ToolCall[] | undefined {
  const content = isRecord(data) ? toArray(data.content) : [];
  const calls: ToolCall[] = [];
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "tool_use" &&
      typeof block.name === "string"
    ) {
      calls.push({
        id: typeof block.id === "string" ? block.id : undefined,
        name: block.name,
        input: isRecord(block.input) ? block.input : {},
      });
    }
  }
  return calls.length > 0 ? calls : undefined;
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
    case "tool_use":
      return "tool_use";
    default:
      return "other";
  }
}

/** Anthropic reports `usage.input_tokens`/`output_tokens`; it has no total field. */
function extractUsage(data: unknown): Usage | undefined {
  const usage = isRecord(data) ? data.usage : undefined;
  if (!isRecord(usage)) {
    return undefined;
  }
  const inputTokens =
    typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens =
    typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
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

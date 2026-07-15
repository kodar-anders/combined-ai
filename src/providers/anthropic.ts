/**
 * Anthropic (Claude) provider, talking to the Messages API directly over
 * `fetch` — no SDK dependency.
 */

import { apiError, apiErrorFromBody } from "../errors";
import { extractModel, isRecord } from "./extract";
import { sseJson } from "./sse";
import { parseStructured } from "./structured";
import {
  readJsonBody,
  requestControls,
  requestWithRetry,
  type RetryOptions,
} from "../transport";
import {
  type CacheControl,
  type CompletionRequest,
  type CompletionResult,
  type ContentPart,
  type FinishReason,
  type MediaSource,
  type Message,
  type Provider,
  type Role,
  type SystemPrompt,
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
/** Anthropic accepts at most 4 `cache_control` breakpoints per request. */
const MAX_CACHE_BREAKPOINTS = 4;

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
    const { extendedCacheTtl } = prepareCacheControl(request);
    const { signal, retry } = requestControls(request, this.#retry);
    const response = await requestWithRetry(
      "anthropic",
      `${this.#baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: this.#headers(extendedCacheTtl),
        body: JSON.stringify(
          this.#buildBody(request, model, DEFAULT_MAX_TOKENS, false),
        ),
        signal,
      },
      retry,
    );

    if (!response.ok) {
      throw await apiError("anthropic", response);
    }

    const data: unknown = await readJsonBody("anthropic", response);
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
    const { extendedCacheTtl } = prepareCacheControl(request);
    const { signal, retry } = requestControls(request, this.#retry);
    const response = await requestWithRetry(
      "anthropic",
      `${this.#baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: this.#headers(extendedCacheTtl),
        body: JSON.stringify(
          this.#buildBody(request, model, DEFAULT_STREAM_MAX_TOKENS, true),
        ),
        signal,
      },
      retry,
    );

    if (!response.ok) {
      throw await apiError("anthropic", response);
    }
    if (!response.body) {
      throw new Error("Anthropic streaming response had no body");
    }

    for await (const event of sseJson(response.body, "anthropic")) {
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

  /**
   * `extendedCacheTtl` adds the beta header the 1-hour cache TTL requires; computed
   * once per request by {@link prepareCacheControl} and passed in (so we don't
   * re-scan the request here and risk disagreeing with the body).
   */
  #headers(extendedCacheTtl = false): Record<string, string> {
    return {
      "x-api-key": this.#apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
      ...(extendedCacheTtl
        ? { "anthropic-beta": "extended-cache-ttl-2025-04-11" }
        : {}),
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
      body.system = toAnthropicSystem(request.system);
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

type AnthropicCacheControl = { type: "ephemeral"; ttl?: "1h" };

type AnthropicTextBlock = {
  type: "text";
  text: string;
  cache_control?: AnthropicCacheControl;
};

type AnthropicBlock =
  | AnthropicTextBlock
  | {
      type: "image";
      source: AnthropicSource;
      cache_control?: AnthropicCacheControl;
    }
  | {
      type: "document";
      source: AnthropicSource;
      cache_control?: AnthropicCacheControl;
    }
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
      return {
        type: "text",
        text: part.text,
        ...cacheControlField(part.cacheControl),
      };
    case "image":
      return {
        type: "image",
        source: toAnthropicSource(part.source),
        ...cacheControlField(part.cacheControl),
      };
    case "file":
      return {
        type: "document",
        source: toAnthropicSource(part.source),
        ...cacheControlField(part.cacheControl),
      };
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

/** Map the provider-agnostic {@link CacheControl} onto Anthropic's `cache_control`. */
function toAnthropicCacheControl(
  cacheControl: CacheControl | undefined,
): AnthropicCacheControl | undefined {
  if (cacheControl === undefined) {
    return undefined;
  }
  // Omit `ttl` for the default 5-minute ephemeral cache; pass "1h" through.
  return cacheControl.ttl === undefined
    ? { type: "ephemeral" }
    : { type: "ephemeral", ttl: cacheControl.ttl };
}

/** Spread helper: `{ cache_control }` when a marker is set, else `{}` (field omitted). */
function cacheControlField(cacheControl: CacheControl | undefined): {
  cache_control?: AnthropicCacheControl;
} {
  const mapped = toAnthropicCacheControl(cacheControl);
  return mapped === undefined ? {} : { cache_control: mapped };
}

/**
 * Map the request's system prompt onto Anthropic's `system`: a bare string stays a
 * string, but the {@link SystemPrompt} object form with a cache marker becomes a
 * one-block text array carrying `cache_control` (Anthropic's way to cache the
 * system prompt). A `SystemPrompt` without a marker degrades to its text string.
 */
function toAnthropicSystem(
  system: string | SystemPrompt,
): string | AnthropicTextBlock[] {
  if (typeof system === "string") {
    return system;
  }
  const cacheControl = toAnthropicCacheControl(system.cacheControl);
  return cacheControl === undefined
    ? system.text
    : [{ type: "text", text: system.text, cache_control: cacheControl }];
}

/**
 * Scan the request for {@link CacheControl} markers (on the system prompt and on
 * text/image/file content parts): enforce Anthropic's 4-breakpoint limit up front
 * (a clear error beats a raw 400) and report whether any breakpoint uses the 1-hour
 * TTL (which needs a beta header). Done once per request so {@link AnthropicProvider}
 * `#headers` and the body builder can't disagree.
 */
function prepareCacheControl(request: CompletionRequest): {
  extendedCacheTtl: boolean;
} {
  let count = 0;
  let extendedCacheTtl = false;
  const note = (cacheControl: CacheControl | undefined): void => {
    if (cacheControl === undefined) {
      return;
    }
    count += 1;
    if (cacheControl.ttl === "1h") {
      extendedCacheTtl = true;
    }
  };

  if (typeof request.system === "object") {
    note(request.system.cacheControl);
  }
  for (const message of request.messages) {
    if (typeof message.content === "string") {
      continue;
    }
    for (const part of message.content) {
      // `cacheControl` exists only on text/image/file parts; the `in` check narrows.
      if ("cacheControl" in part) {
        note(part.cacheControl);
      }
    }
  }

  if (count > MAX_CACHE_BREAKPOINTS) {
    throw new Error(
      `Anthropic allows at most ${MAX_CACHE_BREAKPOINTS} cache_control breakpoints per request; got ${count}. A breakpoint caches the whole prefix up to it, so mark fewer blocks (e.g. only the last stable one).`,
    );
  }
  return { extendedCacheTtl };
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

/**
 * Anthropic reports `usage.input_tokens` (the uncached prompt remainder) plus
 * separate `cache_read_input_tokens` / `cache_creation_input_tokens` buckets, and
 * has no total field. We normalize `inputTokens` to the full billable prompt
 * (base + reads + writes) so it's a superset with the cache counts as subsets —
 * matching OpenAI/Gemini and letting one cost formula apply. `cachedInputTokens`
 * (reads) and `cacheCreationInputTokens` (writes) are set only when non-zero.
 *
 * Defensive: if a gateway dropped `input_tokens`, we don't synthesize a total from
 * the cache buckets alone (that would pass the cost layer's `inputTokens <= 0`
 * guard and underbill) — we report `inputTokens: 0` so pricing declines.
 */
function extractUsage(data: unknown): Usage | undefined {
  const usage = isRecord(data) ? data.usage : undefined;
  if (!isRecord(usage)) {
    return undefined;
  }
  const outputTokens =
    typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  if (typeof usage.input_tokens !== "number") {
    return { inputTokens: 0, outputTokens, totalTokens: outputTokens };
  }
  const cacheRead =
    typeof usage.cache_read_input_tokens === "number"
      ? usage.cache_read_input_tokens
      : 0;
  const cacheCreation =
    typeof usage.cache_creation_input_tokens === "number"
      ? usage.cache_creation_input_tokens
      : 0;
  // The cache buckets are disjoint from input_tokens, so they always sum to a
  // valid superset (each ≤ inputTokens) — no clamp needed here.
  const inputTokens = usage.input_tokens + cacheRead + cacheCreation;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cacheRead > 0 ? { cachedInputTokens: cacheRead } : {}),
    ...(cacheCreation > 0 ? { cacheCreationInputTokens: cacheCreation } : {}),
  };
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

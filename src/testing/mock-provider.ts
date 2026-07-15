/**
 * A network-free {@link Provider} for tests — canned completions, simulated
 * stream deltas, error simulation, and call recording, so you can exercise
 * provider selection and `combine` orchestration without making (paid) API calls.
 *
 * Published on the `combined-ai/test` subpath, **not** the main entry, so it never
 * lands in a production bundle.
 */

import { transportError } from "../errors";
import {
  type CompletionRequest,
  type CompletionResult,
  type EmbeddingRequest,
  type EmbeddingResult,
  type Provider,
} from "../types";

/**
 * One canned answer for a {@link MockProvider} call:
 * - a `string` → shorthand for `{ text }`;
 * - a `Partial<CompletionResult>` → passed through (missing `text`/`model` are
 *   backfilled), so you can set `usage`/`finishReason`/`parsed`/`toolCalls`;
 * - an `Error` (e.g. a `ProviderError`) → thrown, to simulate a failure.
 */
export type MockResponse = string | Partial<CompletionResult> | Error;

/**
 * A function that produces the {@link MockResponse} for a call, given the request
 * and the 0-based call index (across `complete` **and** `stream`). The most
 * flexible form — mirror phase-based combine fakes, or `throw` to fail a call.
 * Must return a single response, never an array.
 */
export type MockResponder = (
  request: CompletionRequest,
  index: number,
) => MockResponse | Promise<MockResponse>;

export type MockProviderOptions = {
  /** Registry/attribution name. Defaults to `"mock"`. */
  name?: string;
  /** Model reported when a response doesn't set one. Defaults to `"mock-model"`. */
  model?: string;
  /**
   * What `complete()`/`stream()` return, resolved once per call:
   * - a single {@link MockResponse} → the same answer every call;
   * - a `MockResponse[]` → a scripted sequence, one per call (throws a clear
   *   error when exhausted);
   * - a {@link MockResponder} → computed per call.
   *
   * Defaults to `""` (an empty completion).
   */
  response?: MockResponse | MockResponse[] | MockResponder;
  /**
   * How `stream()` splits the resolved `text` into deltas. Defaults to a lossless
   * word-ish split (`chunks.join("") === text`). Override for e.g. per-character
   * deltas: `(t) => t.match(/.{1,5}/gs) ?? []`.
   */
  chunk?: (text: string) => string[];
  /**
   * Opt-in embeddings. When set, the instance gains an `embed` method (so it works
   * as a `combine` embedder and via `ProviderRegistry.embed`); when omitted, `embed`
   * is **absent**, so the registry's "provider does not support embeddings" throw
   * stays testable.
   */
  embed?: (
    request: EmbeddingRequest,
  ) => EmbeddingResult | Promise<EmbeddingResult>;
};

const DEFAULT_NAME = "mock";
const DEFAULT_MODEL = "mock-model";

/**
 * Splits text into a non-space run plus its trailing spaces, or a run of
 * leading/standalone whitespace — tiling the whole string, so
 * `chunks.join("") === text` for any input (empty text → no deltas).
 */
const WORD_CHUNK = /\S+\s*|\s+/g;

/** Lossless default stream split (see {@link WORD_CHUNK}). */
function wordChunks(text: string): string[] {
  return text.match(WORD_CHUNK) ?? [];
}

/**
 * A configurable, network-free {@link Provider} for tests. Register it via
 * `custom: { name: { kind: "provider", provider } }` to drive `select()`/`combine`,
 * or use it directly. Records every call on {@link MockProvider.calls}.
 *
 * It honors only `request.signal` (abort). Being network-free, it ignores
 * `request.retry` (nothing to retry) and `request.timeoutMs` (no real timer) — so it
 * also won't reproduce a real provider's up-front throw on an invalid `timeoutMs`;
 * exercise that against a provider that runs the transport path.
 */
export class MockProvider implements Provider {
  readonly name: string;
  /** Every request passed to `complete()`/`stream()`, in call order. */
  readonly calls: CompletionRequest[] = [];
  /**
   * Present only when `options.embed` was given (an instance property, not a
   * prototype method, so `provider.embed === undefined` holds when unconfigured).
   */
  embed?: (request: EmbeddingRequest) => Promise<EmbeddingResult>;

  readonly #model: string;
  readonly #response: MockResponse | MockResponse[] | MockResponder;
  readonly #chunk: (text: string) => string[];

  constructor(options: MockProviderOptions = {}) {
    this.name = options.name ?? DEFAULT_NAME;
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#response = options.response ?? "";
    this.#chunk = options.chunk ?? wordChunks;
    const { embed } = options;
    if (embed !== undefined) {
      this.embed = async (request): Promise<EmbeddingResult> => embed(request);
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.#throwIfAborted(request.signal);
    this.calls.push(request);
    return this.#normalize(await this.#next(request));
  }

  async *stream(
    request: CompletionRequest,
  ): AsyncGenerator<string, void, void> {
    this.#throwIfAborted(request.signal);
    this.calls.push(request);
    // Resolve exactly like complete() (an Error response throws here, before any
    // delta). stream() carries no usage — matching the real providers.
    const { text } = this.#normalize(await this.#next(request));
    for (const delta of this.#chunk(text)) {
      // Mid-stream aborts surface as a plain error (real SSE readers do too);
      // only the entry check throws a transport ProviderError.
      if (request.signal?.aborted) {
        throw request.signal.reason;
      }
      yield delta;
    }
  }

  /** Clear recorded {@link MockProvider.calls}, rewinding the scripted sequence.
   *  (It cannot reset state captured inside a {@link MockResponder} closure.) */
  reset(): void {
    this.calls.length = 0;
  }

  /** Resolve the raw response for the current call (the last recorded one). */
  async #next(request: CompletionRequest): Promise<MockResponse> {
    const response = this.#response;
    // The request is recorded before this runs, so its 0-based index is the
    // count of calls so far minus this one.
    const index = this.calls.length - 1;
    if (typeof response === "function") {
      return response(request, index);
    }
    if (Array.isArray(response)) {
      const picked = response[index];
      if (picked === undefined) {
        throw new Error(
          `MockProvider "${this.name}": scripted response exhausted at call ${String(index)} (${String(response.length)} provided).`,
        );
      }
      return picked;
    }
    return response;
  }

  /** Throw the resolved Error, or normalize to a full {@link CompletionResult}. */
  #normalize(raw: MockResponse): CompletionResult {
    if (raw instanceof Error) {
      throw raw;
    }
    const partial = typeof raw === "string" ? { text: raw } : raw;
    return {
      ...partial,
      text: partial.text ?? "",
      model: partial.model ?? this.#model,
    };
  }

  #throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw transportError(this.name, signal.reason);
    }
  }
}

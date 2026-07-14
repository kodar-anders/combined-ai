/**
 * Single-provider fallback chains: try providers in order, catching a
 * {@link ProviderError} and moving to the next. The result is a plain
 * {@link Provider}, so it composes with everything (`select`-style usage, or
 * dropped into the registry as a `custom: { kind: "provider" }` entry).
 *
 * This pairs with — does not replace — the per-provider retry in `transport.ts`:
 * each entry still retries routine 429/503/529 internally before the chain gives
 * up on it. Reach it via {@link ProviderRegistry.fallback}, which resolves the
 * spec names to providers and delegates to {@link createFallbackProvider}.
 */

import { aggregateError, ProviderError } from "./errors";
import { type ProviderName } from "./registry";
import {
  type CompletionRequest,
  type CompletionResult,
  type Provider,
} from "./types";

/**
 * One entry in a fallback chain: a bare provider name (uses that provider's
 * default model), or an object with per-entry overrides. `model`/`maxTokens`
 * override the per-call request (entry → request → provider default) — this is
 * how you name a model per provider, since a single `request.model` can't sensibly
 * be forwarded to every provider in a heterogeneous chain.
 */
export type FallbackSpec =
  ProviderName | { provider: ProviderName; model?: string; maxTokens?: number };

/**
 * Context passed to {@link FallbackOptions.shouldFallback} / `onFallback` when a
 * provider in the chain fails.
 */
export type FallbackEvent = {
  /** Registry name of the provider that failed. */
  provider: ProviderName;
  /**
   * 0-based position in the chain. Disambiguates a repeated provider (e.g. the
   * same provider twice with different models), for which `provider` alone isn't
   * unique.
   */
  index: number;
  /** The error the provider failed with. */
  error: ProviderError;
};

export type FallbackOptions = {
  /**
   * Decide whether to fall back to the next provider on a given failure. Called
   * for every non-abort {@link ProviderError}, including the last entry's — where
   * a `false` result surfaces that error directly instead of the aggregate.
   * Default: always fall back.
   *
   * Pass this to **stop** on errors another provider won't fix — e.g. a 401/403
   * auth error or a deterministic 400 — so the actionable error surfaces directly
   * instead of being buried in the aggregate at the end of the chain.
   */
  shouldFallback?: (event: FallbackEvent) => boolean;
  /**
   * Fired each time a provider fails and the chain advances to the next. Fires
   * for chain positions `0…N-2` on an all-fail run (the final failure surfaces
   * only in the thrown {@link AggregateError}); a listener error is not swallowed.
   */
  onFallback?: (event: FallbackEvent) => void;
};

/** A chain entry with its provider already resolved (see {@link createFallbackProvider}). */
export type FallbackEntry = {
  provider: Provider;
  providerName: ProviderName;
  model?: string;
  maxTokens?: number;
};

/**
 * Build a {@link Provider} that tries `entries` in order. `complete()` falls back
 * on any non-abort {@link ProviderError} (subject to `options.shouldFallback`);
 * `stream()` falls back only if the error arrives before the first delta — once a
 * delta is yielded the chain is committed and later errors propagate unchanged.
 * When every entry fails, throws an {@link AggregateError} carrying each cause.
 *
 * No `embed`: a fallback chain is completion routing, its per-entry `model` is a
 * chat model, and embeddings from different providers aren't comparable — so it
 * intentionally leaves the optional method undefined.
 */
export function createFallbackProvider(
  entries: FallbackEntry[],
  options?: FallbackOptions,
): Provider {
  const name = `fallback(${entries.map((e) => e.providerName).join("->")})`;

  return {
    name,

    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const causes: ProviderError[] = [];
      for (const [index, entry] of entries.entries()) {
        try {
          return await entry.provider.complete(requestFor(entry, request));
        } catch (error) {
          handleFailure(error, entry, index, entries, causes, options, request);
        }
      }
      // Unreachable: the last entry's handleFailure always throws.
      throw noEntriesError();
    },

    async *stream(request: CompletionRequest): AsyncGenerator<string> {
      const causes: ProviderError[] = [];
      for (const [index, entry] of entries.entries()) {
        let iterator: AsyncIterator<string>;
        let first: IteratorResult<string>;
        try {
          // Acquiring the iterator and the first pull are where a stream fails
          // before producing output — a synchronous throw from a BYO provider's
          // stream() (the contract only promises an AsyncIterable, not an async
          // generator), or connection/auth on the first read. Both must be inside
          // the try so they're eligible for fallback, exactly like complete().
          iterator = entry.provider
            .stream(requestFor(entry, request))
            [Symbol.asyncIterator]();
          first = await iterator.next();
        } catch (error) {
          handleFailure(error, entry, index, entries, causes, options, request);
          continue;
        }
        // Committed: a delta (or a clean end) arrived, so re-emitting from another
        // provider would double the output. Drain here; later errors propagate.
        try {
          while (first.done !== true) {
            yield first.value;
            first = await iterator.next();
          }
        } finally {
          // Close the inner stream if the consumer broke out early, so the real
          // providers release their fetch reader (in sseJson's finally). Swallow a
          // teardown rejection so it can't mask the real streamed error/result.
          try {
            await iterator.return?.();
          } catch {
            // A cleanup error must not replace the streamed outcome.
          }
        }
        return;
      }
      // Unreachable: the last entry's handleFailure always throws.
      throw noEntriesError();
    },
  };
}

/** Apply an entry's per-entry overrides on top of the per-call request. */
function requestFor(
  entry: FallbackEntry,
  request: CompletionRequest,
): CompletionRequest {
  return {
    ...request,
    model: entry.model ?? request.model,
    maxTokens: entry.maxTokens ?? request.maxTokens,
  };
}

/**
 * The shared catch decision for `complete()`/`stream()`. Either **throws** (an
 * abort, a non-{@link ProviderError}, the last entry's aggregate, or a
 * `shouldFallback` veto) or **returns**, meaning "advance to the next entry"
 * (having recorded the cause and fired `onFallback`).
 */
function handleFailure(
  error: unknown,
  entry: FallbackEntry,
  index: number,
  entries: FallbackEntry[],
  causes: ProviderError[],
  options: FallbackOptions | undefined,
  request: CompletionRequest,
): void {
  // An intentional cancel: don't keep trying providers. Aborts and network
  // failures are both kind:"transport", so the signal — not the error — is the
  // honest discriminator (it latches synchronously at abort() time).
  if (request.signal?.aborted === true) {
    throw error;
  }
  // A bug (TypeError, etc.), never masked by falling back.
  if (!(error instanceof ProviderError)) {
    throw error;
  }
  causes.push(error);
  const event: FallbackEvent = {
    provider: entry.providerName,
    index,
    error,
  };
  // A veto means "this error is fatal — surface it directly". Checked at every
  // position, including the last, so a caller inspecting e.g. `err.status === 401`
  // gets the raw error rather than it buried in the aggregate.
  if (options?.shouldFallback && !options.shouldFallback(event)) {
    throw error;
  }
  if (index === entries.length - 1) {
    const chain = entries.map((e) => e.providerName).join(", ");
    throw aggregateError(
      `all ${String(entries.length)} providers in the fallback chain failed: ${chain}`,
      causes,
    );
  }
  options?.onFallback?.(event);
}

/** Guards the "no entries" path (the registry rejects an empty chain up front). */
function noEntriesError(): Error {
  return new Error("fallback chain has no providers");
}

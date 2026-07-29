import { describe, expect, it } from "@jest/globals";

import { apiError, ProviderError, transportError } from "../errors";

describe("apiError", () => {
  it("builds an api ProviderError from the error body", async () => {
    const response = {
      status: 429,
      text: () =>
        Promise.resolve(
          '{"error":{"code":"rate_limit_exceeded","type":"rate_limit_error"}}',
        ),
    } as unknown as Response;

    const error = await apiError("openai", response);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe("api");
    expect(error.status).toBe(429);
    expect(error.code).toBe("rate_limit_exceeded");
    expect(error.type).toBe("rate_limit_error");
  });

  it("wraps an abort during the error-body read as a transport error", async () => {
    const abort = new DOMException("The operation timed out.", "TimeoutError");
    const response = {
      status: 500,
      text: () => Promise.reject(abort),
    } as unknown as Response;

    const error = await apiError("openai", response);

    // A raw DOMException here would break fallback's ProviderError-based advance.
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe("transport");
    expect(error.cause).toBe(abort);
  });
});

/**
 * The round-trip under test. Deliberately not `structuredClone`: the point is what
 * `JSON.stringify` produces — it honors `toJSON`, drops non-enumerable properties like
 * `message`, and drops undefined-valued keys — which is what a log sink or SSE feed
 * actually sees. `structuredClone` would answer a different question (and downgrades a
 * `ProviderError` to a plain `Error`).
 */
function jsonRoundTrip(error: ProviderError): Record<string, unknown> {
  // eslint-disable-next-line unicorn/prefer-structured-clone -- asserting JSON.stringify's own behavior, not deep-cloning
  return JSON.parse(JSON.stringify(error)) as Record<string, unknown>;
}

describe("ProviderError.toJSON", () => {
  it("round-trips an api error through JSON.stringify", async () => {
    const response = {
      status: 429,
      text: () =>
        Promise.resolve(
          '{"error":{"code":"rate_limit_exceeded","type":"rate_limit_error"}}',
        ),
    } as unknown as Response;
    const error = await apiError("openai", response);

    // `message` is non-enumerable on Error, so without toJSON it would be missing here.
    expect(jsonRoundTrip(error)).toEqual({
      name: "ProviderError",
      message: error.message,
      provider: "openai",
      kind: "api",
      status: 429,
      code: "rate_limit_exceeded",
      type: "rate_limit_error",
    });
  });

  it("omits the raw body, which the message already carries verbatim", async () => {
    const body = '{"error":{"type":"invalid_request_error"}}';
    const response = {
      status: 400,
      text: () => Promise.resolve(body),
    } as unknown as Response;
    const error = await apiError("anthropic", response);

    expect(error.body).toBe(body);
    const serialized = jsonRoundTrip(error);
    expect(serialized).not.toHaveProperty("body");
    // Still recoverable — apiError embeds it in the message.
    expect(serialized.message).toContain(body);
  });

  it("drops the api-only fields for a transport error", () => {
    const error = transportError("google", new Error("fetch failed"));

    const serialized = jsonRoundTrip(error);
    // JSON.stringify drops undefined-valued keys, so these are absent, not null.
    expect(serialized).toEqual({
      name: "ProviderError",
      message: "google request failed: fetch failed",
      provider: "google",
      kind: "transport",
    });
    expect(serialized).not.toHaveProperty("status");
    expect(serialized).not.toHaveProperty("cause");
  });
});

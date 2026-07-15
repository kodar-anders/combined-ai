import { describe, expect, it } from "@jest/globals";

import { apiError, ProviderError } from "../errors";

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

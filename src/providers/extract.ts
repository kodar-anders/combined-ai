/**
 * Shared helpers for reading fields off a provider's response body.
 */

/** Whether a value is a non-null object — the shared guard for parsing JSON bodies. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The model name a provider reports on its response, falling back to the
 * requested model when absent or non-string. The field differs by provider
 * (Anthropic and OpenAI use `model`, Gemini uses `modelVersion`), so it's a
 * parameter that defaults to `"model"`.
 */
export function extractModel(
  data: unknown,
  fallback: string,
  field = "model",
): string {
  if (isRecord(data)) {
    const value = data[field];
    if (typeof value === "string") {
      return value;
    }
  }
  return fallback;
}

/**
 * Shared structured-output parsing, used by every provider.
 */

import { type CompletionRequest } from "../types";

/**
 * Parse the structured-output JSON when a `responseFormat` was requested. Returns
 * `undefined` when no schema was asked for or the text wasn't valid JSON (e.g.
 * truncated at the token cap) — the raw text is still returned on
 * `CompletionResult.text`. Provider-agnostic: the model returns the JSON in the
 * response text regardless of which native mechanism produced it.
 */
export function parseStructured(
  request: CompletionRequest,
  text: string,
): unknown {
  if (request.responseFormat === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

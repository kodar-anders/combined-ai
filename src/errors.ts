/**
 * Typed provider errors. Every provider throws a {@link ProviderError} so
 * consumers can branch on `err.status` / `err.kind` / `err.code` instead of
 * regex-matching a message string.
 */

import { type ProviderName } from "./registry";

/**
 * Whether the failure happened after the provider responded (`"api"` — an
 * HTTP error status, so `status` is set) or before any response arrived
 * (`"transport"` — a network/DNS failure or an aborted request, so `status` is
 * undefined). Branch on this to tell "the provider said no" from "we never
 * reached the provider".
 */
export type ProviderErrorKind = "api" | "transport";

type ProviderErrorInit = {
  provider: ProviderName;
  kind: ProviderErrorKind;
  status?: number;
  code?: string;
  type?: string;
  body?: string;
  cause?: unknown;
};

/** An error from a provider call, carrying enough structure to handle it programmatically. */
export class ProviderError extends Error {
  override readonly name = "ProviderError";
  /** Which provider produced the failure. */
  readonly provider: ProviderName;
  /** Transport failure (no response) vs API failure (error response). */
  readonly kind: ProviderErrorKind;
  /** HTTP status for `kind: "api"`; `undefined` for transport failures. */
  readonly status?: number;
  /** Machine-readable code parsed from the error body, where the provider sends one. */
  readonly code?: string;
  /** Error category parsed from the body (Anthropic/OpenAI `type`, Gemini `status`). */
  readonly type?: string;
  /** The raw response body, for `kind: "api"`. */
  readonly body?: string;

  constructor(message: string, init: ProviderErrorInit) {
    super(
      message,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.provider = init.provider;
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.type = init.type;
    this.body = init.body;
  }
}

/**
 * Build an `api` {@link ProviderError} from a non-2xx response, parsing the
 * provider's error body for a machine `code`/`type` where present.
 */
export async function apiError(
  provider: ProviderName,
  response: Response,
): Promise<ProviderError> {
  const body = await response.text();
  const { code, type } = parseErrorBody(body);
  return new ProviderError(
    `${provider} request failed (${String(response.status)}): ${body}`,
    { provider, kind: "api", status: response.status, code, type, body },
  );
}

/**
 * Pull a machine `code`/`type` out of an error body across the three vendors'
 * shapes: all nest the detail under `error`; the human code is OpenAI's
 * `error.code` (a string — Gemini's `code` is the numeric HTTP status, so it's
 * skipped), and the category is `error.type` (Anthropic/OpenAI) or `error.status`
 * (Gemini).
 */
function parseErrorBody(body: string): { code?: string; type?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) {
    return {};
  }
  const error = isRecord(parsed.error) ? parsed.error : parsed;
  const code = typeof error.code === "string" ? error.code : undefined;
  const type =
    typeof error.type === "string"
      ? error.type
      : typeof error.status === "string"
        ? error.status
        : undefined;
  return { code, type };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

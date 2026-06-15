/**
 * Public entry point for the library.
 *
 * The package is a single point of access to its AI providers: you configure a
 * {@link ProviderRegistry} and select a provider by name. The concrete provider
 * classes are intentionally not exported.
 */

export type {
  CompletionRequest,
  CompletionResult,
  Message,
  Provider,
  Role,
} from "./types";

export { type AnthropicProviderOptions } from "./providers/anthropic";
export { type OpenAIProviderOptions } from "./providers/openai";
export { type GeminiProviderOptions } from "./providers/gemini";

export {
  ProviderRegistry,
  type ProviderName,
  type ProviderRegistryConfig,
} from "./registry";

export type {
  CombineEvent,
  CombineOptions,
  CombineRequest,
  CombineResult,
  ParticipantOutcome,
  StrategyName,
} from "./combine";

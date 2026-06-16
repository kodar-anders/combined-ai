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
  ContentPart,
  FilePart,
  FinishReason,
  ImagePart,
  MediaSource,
  Message,
  Provider,
  ResponseFormat,
  Role,
  TextPart,
  ToolCall,
  ToolChoice,
  ToolDefinition,
  ToolResultPart,
  ToolUsePart,
  Usage,
} from "./types";

export { ProviderError, type ProviderErrorKind } from "./errors";
export { type RetryOptions } from "./transport";

export { type AnthropicProviderOptions } from "./providers/anthropic";
export { type OpenAIProviderOptions } from "./providers/openai";
export { type GoogleProviderOptions } from "./providers/google";

export {
  ProviderRegistry,
  type BuiltInProviderName,
  type CustomProviderConfig,
  type CustomProviderInstance,
  type OpenAICompatibleConfig,
  type ProviderName,
  type ProviderRegistryConfig,
} from "./registry";

export type {
  BroadcastResult,
  CombineEvent,
  CombineOptions,
  CombineRequest,
  CombineResult,
  CombineUsage,
  ConsensusResult,
  EnsembleAgreement,
  EnsembleResult,
  ParticipantOutcome,
  ParticipantSpec,
  PipelineResult,
  StrategyName,
} from "./combine";

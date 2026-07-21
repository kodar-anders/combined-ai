/**
 * Public entry point for the library.
 *
 * The package is a single point of access to its AI providers: you configure a
 * {@link ProviderRegistry} and select a provider by name. The concrete provider
 * classes are intentionally not exported.
 */

export type {
  CacheControl,
  CompletionRequest,
  CompletionResult,
  ContentPart,
  EmbeddingOptions,
  EmbeddingRequest,
  EmbeddingResult,
  FilePart,
  FinishReason,
  ImagePart,
  MediaSource,
  Message,
  Provider,
  ResponseFormat,
  Role,
  SystemPrompt,
  TextPart,
  ToolCall,
  ToolChoice,
  ToolDefinition,
  ToolResultPart,
  ToolUsePart,
  Usage,
} from "./types";

export { cosineSimilarity } from "./embeddings";

export { ProviderError, type ProviderErrorKind } from "./errors";
export { type RetryOptions } from "./transport";

export type { FallbackEvent, FallbackOptions, FallbackSpec } from "./fallback";

export { costOf, costOfUsage, type CostBreakdown } from "./cost";
export { combineCost, type CombineCost } from "./combine/cost";
export {
  findModel,
  listModels,
  PRICING_VERIFIED_ON,
  type CostOptions,
  type ModelInfo,
  type ModelPricing,
} from "./models";

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
  BroadcastRequest,
  BroadcastResult,
  CallUsage,
  CombineBudget,
  CombineEmbedding,
  CombineEvent,
  CombineOptions,
  CombineRequest,
  CombineRequestBase,
  CombineResult,
  CombineUsage,
  ConsensusRequest,
  ConsensusResult,
  EnsembleAgreement,
  EnsembleRequest,
  EnsembleResult,
  PanelRequest,
  PanelResult,
  ParticipantOutcome,
  ParticipantSpec,
  PipelineRequest,
  PipelineResult,
  ResultFor,
  SemanticComparison,
  StrategyName,
  StrategyRequest,
} from "./combine";

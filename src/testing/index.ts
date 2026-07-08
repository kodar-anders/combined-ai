/**
 * Testing entry point (`combined-ai/test`).
 *
 * Test-only helpers, kept off the main entry so they never reach a production
 * bundle. {@link ProviderError} is re-exported here so `instanceof` checks work
 * against errors thrown by a {@link MockProvider} without crossing the bundle
 * boundary (each entry bundles its own copy of the class under CJS).
 */

export { MockProvider } from "./mock-provider";
export type {
  MockProviderOptions,
  MockResponder,
  MockResponse,
} from "./mock-provider";
export { ProviderError, type ProviderErrorKind } from "../errors";

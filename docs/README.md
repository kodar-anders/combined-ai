# combined-ai documentation

Deep reference for the library. Start with the [main README](../README.md) for
the pitch, install, and quickstart; come here for the details.

- **[Combine strategies](./strategies.md)**: per-strategy behavior, semantic
  comparison, per-participant models, reading results, and progress events.
- **[Single-provider reference](./single-provider.md)**: request/result fields,
  structured output, tool calling, multimodal input, and embeddings.
- **[Cost, pricing & caching](./cost-and-caching.md)**: `costOf`, `combineCost`,
  budgets, and Anthropic prompt caching.
- **[Errors, retries & fallback](./errors-retries-fallback.md)**: `ProviderError`,
  retry/timeout behavior, and fallback chains.
- **[Testing with MockProvider](./testing.md)**: the network-free
  `combined-ai/test` entry.

To contribute to the library, see [CONTRIBUTING.md](../CONTRIBUTING.md).

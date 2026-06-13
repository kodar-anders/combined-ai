/** @type {import("jest").Config} */
export default {
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  // Loads `.env` (gitignored) so live integration tests can read ANTHROPIC_API_KEY.
  setupFiles: ["<rootDir>/jest.setup.cjs"],
  testMatch: ["**/*.{test,spec}.ts", "**/__tests__/**/*.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  // @swc/jest transpiles TS → CJS for the test run (fast, no type-checking).
  // Type errors are caught separately by `yarn typecheck`.
  transform: {
    "^.+\\.ts$": ["@swc/jest"],
  },
  clearMocks: true,
};

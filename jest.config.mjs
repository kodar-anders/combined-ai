/** @type {import("jest").Config} */
export default {
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.{test,spec}.ts", "**/__tests__/**/*.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  // @swc/jest transpiles TS → CJS for the test run (fast, no type-checking).
  // Type errors are caught separately by `yarn typecheck`.
  transform: {
    "^.+\\.ts$": ["@swc/jest"],
  },
  clearMocks: true,
};

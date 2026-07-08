import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import promisePlugin from "eslint-plugin-promise";
import unicornPlugin from "eslint-plugin-unicorn";
import unusedImportsPlugin from "eslint-plugin-unused-imports";
import jestPlugin from "eslint-plugin-jest";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  // --- Globally ignored paths ---
  {
    ignores: [
      "dist/",
      "coverage/",
      ".yarn/",
      ".pnp.*",
      "**/*.d.ts", // generated declaration files
    ],
  },

  // --- TypeScript source (type-aware linting) ---
  {
    files: ["**/*.ts"],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
      promisePlugin.configs["flat/recommended"],
      unicornPlugin.configs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      "unused-imports": unusedImportsPlugin,
    },
    rules: {
      // --- General ---
      curly: ["warn", "all"],
      eqeqeq: ["error", "always"],
      "no-console": "error", // a library should not write to the consumer's console
      "no-unused-expressions": ["warn", { allowTernary: true }],

      // --- Unused imports / vars (delegated to the unused-imports plugin) ---
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          args: "after-used",
          argsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],

      // --- Public API hygiene (matters most for a consumed library) ---
      "@typescript-eslint/explicit-module-boundary-types": "error", // exported functions must declare their types
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        { allowExpressions: true }, // don't force annotations on inline callbacks
      ],
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/consistent-type-exports": "warn",
      "@typescript-eslint/consistent-type-definitions": ["warn", "type"], // prefer `type` over `interface`

      // --- Style preferences ---
      "@typescript-eslint/array-type": ["error", { default: "array-simple" }],
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        { ignoreArrowShorthand: true },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],

      // --- Unicorn: relax the noisy/opinionated rules ---
      "unicorn/switch-case-braces": ["error", "avoid"], // omit braces for single-statement cases
      "unicorn/prevent-abbreviations": "off", // too aggressive on common short names
      "unicorn/name-replacements": "off", // same as prevent-abbreviations: `args`/`fn`/`e` are fine
      "unicorn/no-null": "off", // `null` is a legitimate value
      "unicorn/catch-error-name": "off",
      "unicorn/filename-case": "off",
      "unicorn/no-array-reduce": "off",
      "unicorn/numeric-separators-style": "off",
      "unicorn/consistent-boolean-name": "off", // don't force is/has-prefixed boolean names
      "unicorn/consistent-conditional-object-spread": "off", // ternary-with-{} spread is clear; not worth the `&&` churn
      "unicorn/consistent-class-member-order": "off", // public `name` intentionally leads the provider classes
      "unicorn/no-negated-array-predicate": "off", // `!x.some(p)` reads fine
      "unicorn/prefer-continue": "off", // early-continue would force negating compound conditions
      "unicorn/no-break-in-nested-loop": "off", // don't extract a helper just to avoid a simple `continue`
      "unicorn/max-nested-calls": "off", // call-nesting depth isn't worth policing
      "unicorn/no-unreadable-for-of-expression": "off", // inline `.slice()`/`.stream()` in a for-of header reads fine
      "unicorn/prefer-global-number-constants": "off", // keep explicit `Number.POSITIVE_INFINITY`
      // ES2022 lib target — these prefer methods that aren't available yet:
      "unicorn/prefer-array-from-async": "off", // `Array.fromAsync` is ES2024
      "unicorn/prefer-iterator-to-array": "off", // `Iterator#toArray` is ES2025
    },
  },

  // --- Tests (Jest) ---
  {
    files: ["**/*.{test,spec}.ts", "**/__tests__/**/*.ts"],
    extends: [jestPlugin.configs["flat/recommended"]],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "unicorn/consistent-function-scoping": "off",
      // Kept on for src, off for idiomatic test patterns:
      "unicorn/no-global-object-property-assignment": "off", // `globalThis.fetch = mock`
      "unicorn/no-unnecessary-global-this": "off", // `globalThis.fetch` when saving/restoring it
      "unicorn/prefer-await": "off", // `.catch((e) => e)` to capture a rejection for assertions
      "unicorn/no-return-array-push": "off", // `(e) => arr.push(e)` collectors whose return is ignored
      "unicorn/no-duplicate-loops": "off", // `for (const x of arr.filter(...))` in assertions
      "jest/consistent-test-it": ["warn", { fn: "it", withinDescribe: "it" }],
    },
  },

  // --- Plain JS / config files (no type-aware linting) ---
  {
    files: ["**/*.{js,cjs,mjs}"],
    extends: [eslint.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // --- Prettier compatibility (must stay last) ---
  eslintConfigPrettier,
);

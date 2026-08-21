/**
 * ESLint flat configuration.
 *
 * Follows `~/.claude/reference/typescript-static-analysis.md`: `@eslint/js` recommended,
 * type-aware `typescript-eslint`, React, React Hooks, JSX a11y, JSDoc, import, unicorn,
 * Vitest and React Refresh.
 *
 * The project spans three runtimes, so the parser project, globals and React rules are
 * scoped per directory:
 *
 *   - `src/`                     browser (SPA), covered by `tsconfig.app.json`
 *   - `server/`, `ops/`,         Node, covered by `tsconfig.server.json`
 *     `scripts/`, `e2e/`
 *   - `*.config.ts`              Node build tooling, covered by `tsconfig.node.json`
 * @author John Grimes
 */

import js from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import importPlugin from "eslint-plugin-import";
import jsdoc from "eslint-plugin-jsdoc";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefreshPlugin from "eslint-plugin-react-refresh";
import unicorn from "eslint-plugin-unicorn";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Global ignores. This object must carry no other key, otherwise ESLint scopes the
  // patterns to a single config block instead of applying them globally. `**/.claude/**`
  // keeps agent worktrees under `.claude/worktrees` out of the lint run.
  {
    ignores: [
      "**/.claude/**",
      "coverage",
      "dist",
      "dist-server",
      "node_modules",
      "report",
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Resolves each file through the nearest tsconfig, so type-aware rules see the
        // right lib and path aliases for browser, Node and build-tooling code alike.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // This config file is plain JavaScript and belongs to no TypeScript project, so the
  // type-aware rules (and the parser services they need) are switched off for it.
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },

  jsdoc.configs["flat/recommended-typescript"],
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  unicorn.configs.recommended,

  // Browser code.
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    extends: [
      react.configs.flat.recommended,
      react.configs.flat["jsx-runtime"],
      reactHooks.configs.flat["recommended-latest"],
      jsxA11y.flatConfigs.recommended,
      reactRefreshPlugin.configs.vite,
    ],
    settings: { react: { version: "detect" } },
    rules: {
      // TypeScript handles prop validation.
      "react/prop-types": "off",
      "react/jsx-pascal-case": "error",
      "react/jsx-boolean-value": ["error", "never"],
      "react/self-closing-comp": "error",

      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  // Node code: the server, its operational scripts, the offline check scripts and the
  // Playwright suite.
  {
    files: [
      "server/**/*.ts",
      "ops/**/*.ts",
      "scripts/**/*.ts",
      "e2e/**/*.ts",
      "tests/server/**/*.ts",
      "tests/ops/**/*.ts",
      "*.config.ts",
      "*.config.js",
    ],
    languageOptions: { globals: globals.node },
  },

  // The BFF process. `tsconfig.server.json` includes the `DOM` lib so the shared link
  // crypto under `src/` typechecks, which also drags the browser-only globals into scope.
  // They have no meaning in the server process, so importing browser code by mistake
  // should be a lint failure rather than a runtime crash.
  {
    files: ["server/**/*.ts", "ops/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        "alert",
        "document",
        "localStorage",
        "location",
        "navigator",
        "sessionStorage",
        "window",
      ],
    },
  },

  // The offline check scripts belong to no TypeScript project: `scripts/roundtrip.ts`
  // imports QuestionnaireResponse fixtures from a sibling `aehrc/smart-forms` checkout, so
  // putting them in `tsconfig.server.json` would fail `npm run typecheck` for anyone
  // without that checkout (including CI). They keep the syntax-only rules.
  {
    files: ["scripts/**/*.ts"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      // These are command-line entry points, where a non-zero exit code is the result.
      "unicorn/no-process-exit": "off",
    },
  },

  // Test files.
  {
    files: ["tests/**/*.{ts,tsx}"],
    extends: [vitest.configs.recommended],
  },

  {
    rules: {
      "jsdoc/require-jsdoc": [
        "warn",
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ArrowFunctionExpression: true,
            FunctionExpression: true,
          },
        },
      ],

      "import/order": [
        "error",
        {
          groups: [
            ["builtin", "external"],
            "internal",
            ["parent", "sibling", "index"],
            "type",
          ],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
      // TypeScript resolves modules, including the `@/*` alias from the tsconfig `paths`,
      // and reports missing or misnamed imports itself. The import plugin has no view of
      // the alias, so leaving these on would fail on every `@/...` import.
      "import/no-unresolved": "off",
      "import/named": "off",

      // The project convention is lowerCamelCase file names, with PascalCase reserved for
      // React component files.
      "unicorn/filename-case": [
        "error",
        { cases: { camelCase: true, pascalCase: true } },
      ],
      // Conflicts with React and DOM idiom (`props`, `ref`, `params`, `e`).
      "unicorn/prevent-abbreviations": "off",
      // FHIR canonical URLs are `http://hl7.org/fhir/...` by specification. They are
      // identifiers, not addresses, and rewriting them to `https` would break profile,
      // extension and code-system matching.
      "unicorn/prefer-https": "off",
      // `null` is load bearing here: it is what FHIR JSON and `JSON.parse` produce, what
      // `JSON.stringify` can round-trip (unlike `undefined`), and what React state uses
      // for "resolved, but absent".
      "unicorn/no-null": "off",
    },
  },
);

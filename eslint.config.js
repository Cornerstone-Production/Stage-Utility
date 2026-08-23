import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default [
  // `public/**` was ignored wholesale, which meant the service worker — real
  // shipped code that decides what a wall holds offline — was never linted.
  { ignores: ["build/**", "node_modules/**"] },
  {
    // The service worker: a worker global scope, plain JS, no TS parser.
    files: ["public/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.serviceworker, ...globals.browser },
    },
  },
  js.configs.recommended,
  {
    // Plain ESM helpers run by the update scripts — Node globals, no TS parser.
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "react-hooks": reactHooks,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // tsc (strict, noUnusedLocals) already covers these; avoid duplicate noise
      // and the no-undef false positives on type-only references.
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      // `interface Props extends React.XHTMLAttributes<…> {}` is an idiomatic
      // named-props pattern; allow the single-extends form.
      "@typescript-eslint/no-empty-object-type": ["error", { allowInterfaces: "with-single-extends" }],
    },
  },
];

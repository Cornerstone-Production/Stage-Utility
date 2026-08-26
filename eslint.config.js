import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default [
  { ignores: ["build/**", "node_modules/**", "public/**"] },
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
      // errorMessage() exists to hold this one expression. It was written to
      // sweep 62 copies of it, and three more had already grown back by 1.11 --
      // two in one file, beside a sibling that imports the helper correctly.
      // A lint rule rather than a test, because it fires where the copy is typed
      // rather than in a scan somebody has to go read.
      "no-restricted-syntax": [
        "error",
        {
          // Precisely the shape errorMessage() replaces: `x instanceof Error ?
          // x.message : String(x)`. Deliberately NOT the near-misses -- a custom
          // fallback ("Upload failed") or a bare `: err` says something else, and
          // flagging those would push people to paper over the difference.
          selector:
            "ConditionalExpression[test.operator='instanceof'][test.right.name='Error']" +
            "[consequent.property.name='message']" +
            "[alternate.callee.name='String']",
          message: "Use errorMessage(err) from @main/services/errors instead of re-writing the ternary.",
        },
      ],
    },
  },
];

// vite-react-compiler.ts — the React Compiler preset both Vite configs share.
//
// @vitejs/plugin-react's reactCompilerPreset() names its Babel preset by file
// (dist/reactCompilerBabelPreset.js, an ES module that calls import.meta.resolve),
// so @rolldown/plugin-babel can hand it to worker threads. Babel loads that file
// with require(). Under `node --import tsx`, which runs scripts/servicecue-bundle.ts
// and the test suite, tsx's require hook compiles the module to CommonJS and swaps
// import.meta for a fixed object with no resolve(). Every file Babel touches then
// fails with "define_import_meta_default.resolve is not a function", and the
// public bundles do not build.
//
// So the preset is a function here, which Babel calls in process and never loads
// from disk. The file form exists only for plugin-babel's `parallel` option, which
// neither config uses. The filter and optimizeDeps from reactCompilerPreset() are
// kept as they are.
//
// A module of its own for the same reason as vite-aliases.ts: two configs need it,
// and neither can import the other.

import { createRequire } from "node:module";
import { reactCompilerPreset } from "@vitejs/plugin-react";

/** createRequire, not import.meta.resolve: tsx's CommonJS output keeps import.meta.url. */
const COMPILER_PLUGIN = createRequire(import.meta.url).resolve("babel-plugin-react-compiler");

/** reactCompilerPreset(), with its Babel preset given in process rather than by path. */
export function reactCompiler(): ReturnType<typeof reactCompilerPreset> {
  return { ...reactCompilerPreset(), preset: () => ({ plugins: [COMPILER_PLUGIN] }) };
}

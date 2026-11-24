// react-compiler-hook.ts — run chosen modules through the React Compiler in a test.
//
// The suite runs under tsx, which does not run the React Compiler; the built app
// does (vite.config.ts). A component that reads a store outside its hook's
// snapshot works uncompiled and freezes compiled: the compiler memoises the read
// on inputs that never change. A built Q-SYS panel did exactly that, drawing
// every control offline for good, while every uncompiled test passed.
//
// This installs a module load hook that takes tsx's output for each matching
// file and runs babel-plugin-react-compiler over it, the plugin the build uses,
// through the Babel that @rolldown/plugin-babel (the build's Babel) depends on.
// Call it BEFORE the first import of anything that reaches those files.
//
// TEST-ONLY: no `.test.` in the filename, so `npm test` does not run it as a suite.

import { createRequire, registerHooks } from "node:module";

const require = createRequire(import.meta.url);
const babel = createRequire(require.resolve("@rolldown/plugin-babel"))("@babel/core") as {
  transformSync: (code: string, opts: Record<string, unknown>) => { code?: string | null } | null;
};
const COMPILER = require.resolve("babel-plugin-react-compiler");

/** Modules whose URL `match` accepts are compiled; returns how many have been so far. */
export function compileWithReactCompiler(match: (url: string) => boolean): () => number {
  let compiled = 0;
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (!match(url) || loaded.source == null) return loaded;
      const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source as Uint8Array).toString("utf8");
      const out = babel.transformSync(source, {
        filename: new URL(url).pathname,
        babelrc: false,
        configFile: false,
        plugins: [COMPILER],
        parserOpts: { plugins: ["jsx", "typescript"] },
        sourceType: "module",
      });
      if (!out?.code) throw new Error(`the React Compiler produced nothing for ${url}`);
      compiled++;
      return { ...loaded, source: out.code };
    },
  });
  return () => compiled;
}

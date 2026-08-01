#!/usr/bin/env node
// bundle-server.mjs — collapse the backend into one file for a packaged install.
//
// A git checkout runs `server.ts` through tsx, resolving imports from
// node_modules as it goes. A packaged install ships neither, so the backend is
// bundled ahead of time into a single ESM file that needs only a Node binary.
//
// This is cheap because the server imports exactly three third-party packages —
// fflate, read-excel-file, write-excel-file — all pure JavaScript. Everything
// else in `dependencies` is interface code that Vite compiles into build/, and
// there are no native modules on this path, so there is nothing to compile per
// platform.
//
// Usage: node scripts/bundle-server.mjs [--outfile build/server.mjs]

import { build } from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argOut = process.argv.indexOf("--outfile");
const OUTFILE = path.resolve(ROOT, argOut > -1 ? process.argv[argOut + 1] : "build/server.mjs");

// Node's version floor, so esbuild leaves syntax the runtime already supports
// rather than downlevelling it.
const TARGET = "node24";

const result = await build({
  absWorkingDir: ROOT,
  entryPoints: [path.join(ROOT, "server.ts")],
  outfile: OUTFILE,
  bundle: true,
  platform: "node",
  format: "esm",
  target: TARGET,
  sourcemap: "linked", // a stack trace from a display should still be readable
  metafile: true,
  logLevel: "info",
  // Some dependencies are published as CommonJS and call `require` at runtime.
  // ESM output has no `require`, so give them one built from this module's URL.
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});

const bytes = fs.statSync(OUTFILE).size;
const inputs = Object.keys(result.metafile.inputs).length;
console.log(
  `[bundle] ${path.relative(ROOT, OUTFILE)} — ${(bytes / 1024).toFixed(0)} KB from ${inputs} modules`,
);

// A bundle that silently dropped the server would still be a valid file. These
// are the shapes whose absence would only show up when a display failed to load.
const src = fs.readFileSync(OUTFILE, "utf8");
const required = ["createServer", "STAGE_UTILITY_DATA"];
const missing = required.filter((s) => !src.includes(s));
if (missing.length) {
  console.error(`[bundle] FAILED — bundle is missing: ${missing.join(", ")}`);
  process.exit(1);
}
if (bytes < 100_000) {
  console.error(`[bundle] FAILED — ${bytes} bytes is too small to be the server`);
  process.exit(1);
}

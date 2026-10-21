// vite-aliases.ts — the path aliases both Vite configs share.
//
// Path aliases come from tsconfig, which tsc and the production build already read.
// The dev server does not, so an import through an alias would type-check, build,
// and then 500 the page in dev. Deriving them here rather than repeating the list
// keeps the two from drifting apart when a new alias is added, and keeps the
// operator app's config and the public viewer's from each carrying a copy of the
// derivation.
//
// A module of its own because vite.config.ts cannot be imported outside Vite (it
// reads __dirname), and a config that wants the aliases would otherwise have to.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** `{"@x/*": ["./x/*"]}` from `<root>/tsconfig.json` → `{"@x": "<root>/x"}` for Vite. */
export function tsconfigAliases(root: string): Record<string, string> {
  const paths: Record<string, string[]> =
    JSON.parse(readFileSync(resolve(root, "tsconfig.json"), "utf8")).compilerOptions?.paths ?? {};
  const out: Record<string, string> = {};
  for (const [k, [v]] of Object.entries(paths)) {
    if (!v) continue;
    out[k.replace(/\/\*$/, "")] = resolve(root, v.replace(/^\.\//, "").replace(/\/\*$/, ""));
  }
  return out;
}

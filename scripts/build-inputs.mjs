#!/usr/bin/env node
// build-inputs.mjs — did an update change something `npm run build` is made from?
//
// update.sh and update.ps1 skip the build when nothing it reads changed. Which paths those
// are lives here, once, so the two scripts cannot disagree and a test can run the real rule.
//
// Usage:  git diff --name-only <old> <new> | node scripts/build-inputs.mjs
// Output: true | false      (an unreadable list reports true: do the work)

import { isMain } from "./is-main.mjs";

/** Sorted, one per line. A path that starts with any of these is a build input. */
export const BUILD_INPUT_PREFIXES = [
  "index.html",
  "main/types/servicecue-publish.ts", // the public ServiceCue page and its Worker share it
  "postcss.config",
  "publish/servicecue/src/", // the Worker, bundled into build/servicecue
  "publish/servicecue/wrangler", // its compatibility date, bindings and asset rules
  "renderer/",
  "scripts/servicecue-bundle.ts",
  "servicecue.html",
  "tailwind.config",
  "tsconfig",
  "vite.config",
  "vite.servicecue.config",
];

/** Does any changed path need a rebuild? */
export function needsBuild(paths) {
  return paths.some((p) => BUILD_INPUT_PREFIXES.some((prefix) => p.startsWith(prefix)));
}

if (isMain(import.meta.url, process.argv[1])) {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (text += c));
  process.stdin.on("end", () => {
    process.stdout.write(String(needsBuild(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))));
  });
  process.stdin.on("error", () => process.stdout.write("true"));
}

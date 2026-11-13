// build-inputs.ts — did an update change something `npm run build` is made from?
//
// update.sh and update.ps1 skip the build when nothing it reads changed. Which paths those
// are lives here, once, so the two scripts cannot disagree and a test can run the real rule.
//
// Usage:  git diff --name-only <old> <new> | node scripts/build-inputs.ts
// Output: true | false      (an unreadable list reports true: do the work)

import { isMain } from "./is-main.ts";

/** Sorted, one per line. A path that starts with any of these is a build input. */
export const BUILD_INPUT_PREFIXES = [
  "app.html",
  "index.html",
  "main/", // the interface and the page's Worker both build from shared modules here
  "postcss.config",
  "public/", // copied into the interface, and the page's icons are read from it
  "publish/servicecue/src/", // the Worker, bundled into build/servicecue
  "publish/servicecue/wrangler", // its compatibility date, bindings and asset rules
  "renderer/",
  "scripts/servicecue-bundle.ts",
  "servicecue.html",
  "stageplots.html",
  "tailwind.config",
  "tsconfig",
  "vite.config",
  "vite.servicecue.config",
];

/** Sorted, one per line. Paths a prefix above matches that no build reads. */
export const NOT_BUILD_INPUTS = [
  "tsconfig.tooling.json", // type-checks the tooling only; vite and the Worker's bundle never read it
];

/** Does any changed path need a rebuild? */
export function needsBuild(paths: string[]): boolean {
  return paths.some((p) => !NOT_BUILD_INPUTS.includes(p) && BUILD_INPUT_PREFIXES.some((prefix) => p.startsWith(prefix)));
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

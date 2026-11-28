// sharp stays out of the server bundle. Inlined, its loader would look for the
// native build beside server.mjs's own path inside the bundle and never find the
// node_modules/ the archive ships, so every stage-plot upload on a packaged
// install would fail. Builds the real bundle in memory and reads its metafile.

import assert from "node:assert/strict";
import { test } from "node:test";

import { build } from "esbuild";

import { EXTERNAL_PACKAGES, bundleOptions } from "./bundle-server.ts";

test("the server bundle has no sharp inputs, and imports sharp at run time", async () => {
  const result = await build({ ...bundleOptions("build/server.mjs"), write: false, metafile: true, logLevel: "silent" });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.some((f) => f.endsWith("main/services/stageplots-convert.ts")), "the bundle no longer contains the conversion; the test is not looking at the server");
  assert.deepEqual(inputs.filter((f) => /node_modules\/(sharp|@img)\//.test(f)), []);
  const imports = Object.values(result.metafile.outputs).flatMap((o) => o.imports.filter((i) => i.external).map((i) => i.path));
  assert.ok(imports.includes("sharp"), `sharp is not an external import of the bundle: ${JSON.stringify(imports.filter((i) => !i.startsWith("node:")))}`);
  assert.deepEqual(EXTERNAL_PACKAGES, ["sharp"]);
});

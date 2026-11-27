// A patch sheet's structure, read by one reader (patch-shape.ts): what POST /api/patch refuses,
// what patch.json is cleaned of on load, and what resolvePatch, /patch, the export and stage
// plots then read. Each case here once threw in one of them, or was read two ways.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, mock, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "patch-shape-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");
// patch.json as an older build, a hand edit or a restore might have left it, there before the store first reads it.
await fs.writeFile(
  path.join(TMP, "patch.json"),
  JSON.stringify({
    updatedAt: "",
    sheets: [
      {
        id: "s1",
        name: "Analog",
        kind: "analog",
        devices: [],
        endpoints: [{ rackId: "r1", dir: "in", index: 1, label: "Kick" }],
        variants: [{ id: "v1", name: "Week", overrides: { "r1:in:1": null } }],
        assignments: { byServiceType: {}, byPlan: { p1: null } },
      },
    ],
  }),
);

const { normalizePatch, patchShapeProblem } = await import("./patch-shape.js");
const { mergeOverrides, resolvePatch } = await import("./patch-resolve.js");
const { exportRows } = await import("./patch-export.js");
const { callRoute } = await import("./routes/route-harness.js");
const { serviceCueRoutes } = await import("./routes/servicecue-routes.js");
const { patchStore } = await import("./patch-store.js");

import type { PatchEndpoint, PatchFile, PatchSheet } from "../types/patch.js";

after(() => fs.rm(TMP, { recursive: true, force: true }));

const endpoint = (index: number, label: string) => ({ rackId: "r1", dir: "in", index, label }) as PatchEndpoint;

/** A sheet the editor would write, with `over` laid on it. */
function sheet(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "s1",
    name: "Analog",
    kind: "analog",
    devices: [{ id: "r1", name: "Stage rack", kind: "rack", inputs: 8, outputs: 0 }],
    endpoints: [endpoint(1, "Kick"), endpoint(2, "Snare")],
    variants: [{ id: "v1", name: "Week", overrides: { "r1:in:1": { label: "Kick In" } } }],
    assignments: { byServiceType: { st1: "v1" }, byPlan: { p1: { variantId: "v1", tweaks: { "r1:in:2": { label: "Snare Top" } } } } },
    ...over,
  };
}
const file = (...sheets: Record<string, unknown>[]) => ({ sheets, updatedAt: "" }) as unknown as PatchFile;

/** Every way a sheet's structure has been seen wrong, by what it is. */
const MALFORMED: [string, Record<string, unknown>][] = [
  ["assignments null", { assignments: null }],
  ["byPlan null", { assignments: { byServiceType: {}, byPlan: null } }],
  ["byServiceType null", { assignments: { byServiceType: null, byPlan: {} } }],
  ["a plan entry null", { assignments: { byServiceType: {}, byPlan: { p1: null } } }],
  ["variants null", { variants: null }],
  ["a variant null", { variants: [null] }],
  ["a variant's overrides null", { variants: [{ id: "v1", name: "Week", overrides: null }] }],
  ["an override null", { variants: [{ id: "v1", name: "Week", overrides: { "r1:in:1": null } }] }],
  ["an override a list", { variants: [{ id: "v1", name: "Week", overrides: { "r1:in:1": ["x", "y"] } }] }],
  ["a tweak a list", { assignments: { byServiceType: {}, byPlan: { p1: { tweaks: { "r1:in:2": ["x"] } } } } }],
  ["devices null", { devices: null }],
];

describe("patch.json on disk", () => {
  test("is read clean, each value left out said once on [patch], however often it is read", async () => {
    const warned: string[] = [];
    const spy = mock.method(console, "warn", (...a: unknown[]) => void warned.push(a.map(String).join(" ")));
    let read: PatchFile;
    try {
      read = await patchStore.load();
      await patchStore.load();
      await patchStore.loadStrict();
    } finally {
      spy.mock.restore();
    }
    const s = read.sheets[0]!;
    assert.deepEqual(s.assignments.byPlan, {});
    assert.deepEqual(s.variants[0]!.overrides, {});
    const lines = warned.filter((l) => l.startsWith("[patch] patch.json:"));
    assert.equal(lines.length, 2, lines.join(" / "));
    resolvePatch(s, { serviceTypeId: "st1", planId: "p1" });
  });
});

describe("the one reader", () => {
  test("leaves a sheet the editor writes exactly as it was", () => {
    const clean = file(sheet());
    const { file: read, dropped } = normalizePatch(clean);
    assert.deepEqual(dropped, []);
    assert.deepEqual(read, clean);
    assert.equal(patchShapeProblem(clean), null);
  });

  for (const [what, over] of MALFORMED) {
    test(`${what}: named, and every reader after it reads the rest`, () => {
      const bad = file(sheet(over));
      assert.ok(patchShapeProblem(bad), `${what} was not seen`);
      const read = normalizePatch(bad).file.sheets[0] as PatchSheet;
      // Every consumer, on what the reader leaves: none throws.
      resolvePatch(read, { serviceTypeId: "st1", planId: "p1" });
      exportRows(read, "v1", { plan: { serviceTypeId: "st1", planId: "p1" } });
      assert.equal(normalizePatch(file(read as unknown as Record<string, unknown>)).dropped.length, 0, "what the reader leaves is not clean");
    });
  }

  test("an override that is a list is left out, not spread as fields 0 and 1", () => {
    const merged = mergeOverrides([endpoint(1, "Kick")], { "r1:in:1": ["x", "y"] } as never);
    assert.deepEqual(merged, [endpoint(1, "Kick")]);
  });
});

describe("POST /api/patch", () => {
  test("refuses a sheet the readers cannot take, says why on [patch], and saves nothing", async () => {
    const warned: string[] = [];
    const spy = mock.method(console, "warn", (...a: unknown[]) => void warned.push(a.map(String).join(" ")));
    try {
      const before = await patchStore.load();
      const r = await callRoute(serviceCueRoutes, "/api/patch", { method: "POST", body: { file: file(sheet({ variants: [{ id: "v1", name: "Week", overrides: { "r1:in:1": null } }] })) } });
      assert.equal(r.status, 400);
      assert.match((r.json as { error: string }).error, /"r1:in:1" is not an object/);
      assert.deepEqual(await patchStore.load(), before, "a refused patch was saved");
      assert.ok(warned.some((l) => l.startsWith("[patch] save refused:")), warned.join(" / "));
      const ok = await callRoute(serviceCueRoutes, "/api/patch", { method: "POST", body: { file: file(sheet()) } });
      assert.equal(ok.status, 200, "a sheet the editor writes was refused");
    } finally {
      spy.mock.restore();
    }
  });
});


// Existing layouts store category NAMES. Migration turns each distinct name into a
// single-member role and rewrites the layouts to reference role ids. It has to be
// lossless — every layout must render exactly as before — and idempotent, because it
// runs on every load rather than behind a version stamp.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { migrateLayouts } from "./scriptview-layout-migration.js";
import type { ScriptViewLayout } from "../types/stage.js";

const legacy = [
  { id: "l1", name: "Audio", order: 0, columns: ["Band", "Vocals"], accentDepartment: "Band" },
  { id: "l2", name: "Full", order: 1, columns: ["Band", "Lighting"] },
] as unknown as ScriptViewLayout[];

describe("migrateLayouts", () => {
  test("each distinct name becomes a single-member role", () => {
    const { roles } = migrateLayouts(legacy, []);
    assert.deepEqual(roles.map((r) => r.name).sort(), ["Band", "Lighting", "Vocals"]);
    for (const r of roles) assert.equal(r.members.length, 1);
  });

  test("column ORDER is preserved — a layout must look identical afterwards", () => {
    const { layouts, roles } = migrateLayouts(legacy, []);
    const nameOf = (id: string) => roles.find((r) => r.id === id)!.name;
    assert.deepEqual(layouts[0].columnRoles!.map(nameOf), ["Band", "Vocals"]);
  });

  test("accentDepartment carries across to a role id", () => {
    const { layouts, roles } = migrateLayouts(legacy, []);
    assert.equal(roles.find((r) => r.id === layouts[0].accentRole)!.name, "Band");
  });

  test("a layout with no accent gets none", () => {
    const { layouts } = migrateLayouts(legacy, []);
    assert.equal(layouts[1].accentRole ?? null, null);
  });

  test("running it twice changes nothing", () => {
    const once = migrateLayouts(legacy, []);
    const twice = migrateLayouts(once.layouts, once.roles);
    assert.deepEqual(twice.layouts, once.layouts);
    assert.deepEqual(twice.roles, once.roles);
  });

  test("existing roles are reused rather than duplicated", () => {
    const existing = [{ id: "role-band", name: "Band", members: ["Band", "Banda"] }];
    const { roles } = migrateLayouts(legacy, existing);
    const band = roles.filter((r) => r.name === "Band");
    assert.equal(band.length, 1);
    // and its member list is left alone — the operator may have edited it
    assert.deepEqual(band[0].members, ["Band", "Banda"]);
  });

  test("a layout with no columns survives", () => {
    const one = [{ id: "x", name: "Simple", order: 0, columns: [] }] as unknown as ScriptViewLayout[];
    assert.deepEqual(migrateLayouts(one, []).layouts[0].columnRoles, []);
  });

  test("the legacy fields are dropped, so nothing reads them by accident", () => {
    const { layouts } = migrateLayouts(legacy, []);
    assert.equal((layouts[0] as { columns?: unknown }).columns, undefined);
    assert.equal((layouts[0] as { accentDepartment?: unknown }).accentDepartment, undefined);
  });
});

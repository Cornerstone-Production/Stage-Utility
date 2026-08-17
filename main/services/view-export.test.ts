import assert from "node:assert/strict";
import { describe, test, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// A real data directory, never the operator's. STAGE_UTILITY_DATA is set before
// any store module is imported, because DataStore resolves its path once.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "su-export-"));
process.env.STAGE_UTILITY_DATA = dir;

const { viewsStore } = await import("./views-store.js");
const { buildViewBundle } = await import("./view-export.js");

const custom = (id: string, objects: unknown[]) => ({
  id, name: id, kind: "custom", createdAt: 0,
  layout: { version: 1, canvas: { w: 1920, h: 1080 }, objects },
});

beforeEach(async () => {
  await viewsStore.save([
    custom("view-1", [{
      id: "o1", x: 0, y: 0, w: 1, h: 1, z: 0, style: {},
      config: { type: "view-embed", viewId: "view-2" },
    }]),
    custom("view-2", []),
    custom("view-3", []),
  ] as never);
});

describe("building a view bundle", () => {
  test("carries the chosen view and what it embeds, and nothing else", async () => {
    const b = await buildViewBundle("view-1");
    assert.deepEqual(b.views.map((v) => v.id), ["view-1", "view-2"]);
  });

  test("is stamped so an import can refuse the wrong file", async () => {
    const b = await buildViewBundle("view-1");
    assert.equal(b.kind, "stage-utility-view");
    assert.equal(b.version, 1);
    assert.ok(b.createdAt, "no createdAt");
  });

  test("an unknown view id is an error, not an empty bundle", async () => {
    // An empty bundle downloads happily and fails silently at the other end.
    await assert.rejects(() => buildViewBundle("view-nope"), /view-nope/);
  });

  test("carries no secrets", async () => {
    // Passwords live in secretsStore and nothing here reads it. This asserts the
    // property rather than the implementation, so it still holds if the bundle
    // grows a field later.
    const b = await buildViewBundle("view-1");
    const text = JSON.stringify(b).toLowerCase();
    for (const word of ["password", "secret", "apikey"]) {
      assert.ok(!text.includes(word), `bundle mentions "${word}"`);
    }
  });
});

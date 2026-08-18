import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { remapBundle } from "./view-remap.js";
import type { View } from "../types/views.js";

const v = (id: string, objects: unknown[]): View =>
  ({
    id, name: id, kind: "custom", createdAt: 0,
    layout: { version: 1, canvas: { width: 1920, height: 1080 }, objects },
  }) as unknown as View;

const o = (id: string, config: Record<string, unknown>) =>
  ({ id, x: 0, y: 0, w: 1, h: 1, z: 0, style: {}, config });

/** Fresh ids, the way the importer mints them. Closed over rather than passed an
 *  index, so the production signature carries nothing only a test uses. */
function mint(): () => string {
  let n = 0;
  return () => `view-new-${n++}`;
}

describe("remapping an imported bundle", () => {
  test("an embed points at the NEW id of the view that came with it", () => {
    // The bug this exists for: without the remap the embed still names view-2
    // from the SOURCE install, which here is somebody else's view or nothing.
    const out = remapBundle([
      v("view-1", [o("o1", { type: "view-embed", viewId: "view-2" })]),
      v("view-2", []),
    ], mint());

    const embed = out.views[0].layout!.objects[0].config as unknown as Record<string, unknown>;
    assert.equal(embed.viewId, out.views[1].id);
    assert.notEqual(embed.viewId, "view-2");
  });

  test("a slots-grid sourceViewId is remapped the same way", () => {
    const out = remapBundle([
      v("view-1", [o("o1", { type: "slots-grid", source: "view", sourceViewId: "view-2" })]),
      v("view-2", []),
    ], mint());
    const cfg = out.views[0].layout!.objects[0].config as unknown as Record<string, unknown>;
    assert.equal(cfg.sourceViewId, out.views[1].id);
  });

  test("a reference to a view NOT in the bundle is left alone", () => {
    // It may resolve locally. Rewriting it to a minted id would break a link
    // that would otherwise have worked.
    const out = remapBundle([
      v("view-1", [o("o1", { type: "view-embed", viewId: "view-elsewhere" })]),
    ], mint());
    const cfg = out.views[0].layout!.objects[0].config as unknown as Record<string, unknown>;
    assert.equal(cfg.viewId, "view-elsewhere");
  });

  test("a reference inside a nested container is remapped too", () => {
    // Containers nest arbitrarily deep, and an embed three levels down is still
    // an embed.
    const child = o("deep", { type: "view-embed", viewId: "view-2" });
    const parent = { ...o("box", { type: "container" }), children: [child] };
    const out = remapBundle([v("view-1", [parent]), v("view-2", [])], mint());
    const nested = out.views[0].layout!.objects[0].children![0].config as unknown as Record<string, unknown>;
    assert.equal(nested.viewId, out.views[1].id);
  });

  test("every object gets a fresh id, and the map records it", () => {
    const out = remapBundle([v("view-1", [o("o1", { type: "clock" })])], mint());
    const fresh = out.views[0].layout!.objects[0].id;
    assert.notEqual(fresh, "o1");
    assert.equal(out.objectIdMap.get("o1"), fresh);
  });

  test("a hardware binding is carried across untouched", () => {
    // Deliberate: it names gear, it is reported for rebinding, and it is never
    // silently cleared.
    const out = remapBundle([
      v("view-1", [o("o1", { type: "wireless-channel", channelId: "conn-7::3" })]),
    ], mint());
    const cfg = out.views[0].layout!.objects[0].config as unknown as Record<string, unknown>;
    assert.equal(cfg.channelId, "conn-7::3");
  });

  test("the source bundle is not mutated", () => {
    // Import may be retried after a failure, and a walk that edited its input
    // would make the second attempt operate on already-rewritten data.
    const src = [v("view-1", [o("o1", { type: "view-embed", viewId: "view-2" })]), v("view-2", [])];
    remapBundle(src, mint());
    const cfg = src[0].layout!.objects[0].config as unknown as Record<string, unknown>;
    assert.equal(cfg.viewId, "view-2", "remapBundle rewrote its own input");
  });
});

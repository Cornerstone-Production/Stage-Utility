import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { seedHomeView, defaultHomeLayout, HOME_VIEW_ID } from "./home-view.js";

// Home is seeded once and then belongs to the operator. The property that
// matters is that running the seed again NEVER puts back something they removed
// — restoring deleted work is the same class of bug as deleting work.

const view = (id: string) => ({ id, name: id, kind: "custom", layout: { version: 1, canvas: {}, objects: [] } }) as never;

describe("seeding", () => {
  test("adds Home when it is absent", () => {
    const out = seedHomeView([view("a")]);
    assert.equal(out.length, 2);
    assert.ok(out.some((v) => v.id === HOME_VIEW_ID));
  });

  test("Home starts with the cards the fixed panel showed", () => {
    const home = seedHomeView([])[0];
    const types = (home.layout?.objects ?? []).map((o) => o.config.type);
    assert.deepEqual(types, ["home-next-service", "home-readiness"]);
  });

  test("Home is a console, so its controls are live on the shell", () => {
    assert.equal(seedHomeView([])[0].surface, "console");
  });
});

describe("idempotence", () => {
  test("running twice adds nothing", () => {
    const once = seedHomeView([]);
    const twice = seedHomeView(once);
    assert.equal(twice.length, once.length);
  });

  test("the views array is returned BY REFERENCE when Home exists", () => {
    // So the caller can skip the write entirely. A fresh array every load means
    // a save every load, which is a file rewrite for nothing.
    const once = seedHomeView([]);
    assert.equal(seedHomeView(once), once);
  });

  test("a card the operator DELETED stays deleted", () => {
    // THE guard. Keying off the view's contents instead of its existence would
    // put the readiness card back every launch, and an operator who removed it
    // would have no way to keep it gone.
    const once = seedHomeView([]);
    const edited = once.map((v) =>
      v.id === HOME_VIEW_ID
        ? { ...v, layout: { ...v.layout!, objects: v.layout!.objects.filter((o) => o.config.type !== "home-readiness") } }
        : v,
    );
    const after = seedHomeView(edited);
    const types = (after.find((v) => v.id === HOME_VIEW_ID)!.layout?.objects ?? []).map((o) => o.config.type);
    assert.deepEqual(types, ["home-next-service"], "the deleted card came back");
  });

  test("a renamed Home is not duplicated", () => {
    const once = seedHomeView([]);
    const renamed = once.map((v) => (v.id === HOME_VIEW_ID ? { ...v, name: "Front page" } : v));
    assert.equal(seedHomeView(renamed).length, once.length);
  });
});

describe("the default layout", () => {
  test("is responsive, because Home is on whatever window the operator has", () => {
    assert.equal(defaultHomeLayout().canvas.fit, "responsive");
  });

  test("every object sits inside the canvas", () => {
    for (const o of defaultHomeLayout().objects) {
      assert.ok(o.x >= 0 && o.x + o.w <= 1, `${o.id} escapes horizontally`);
      assert.ok(o.y >= 0 && o.y + o.h <= 1, `${o.id} escapes vertically`);
    }
  });

  test("objects do not overlap", () => {
    const [a, b] = defaultHomeLayout().objects;
    assert.ok(a.y + a.h <= b.y, "the cards must stack, not sit on top of each other");
  });
});

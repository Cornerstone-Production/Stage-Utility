import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { seedHomeView, defaultHomeLayout, screensListViews, HOME_VIEW_ID } from "./home-view.js";

// Home is seeded once and then belongs to the operator. The property that
// matters is that running the seed again NEVER puts back something they removed
// — restoring deleted work is the same class of bug as deleting work.
//
// The one exception, and it is a narrow one: a Home that has never been SAVED
// (no layoutRev) is still the build's default, not the operator's work, so a
// build that adds a card gives it to them. See seedHomeView.

const view = (id: string) => ({ id, name: id, kind: "custom", layout: { version: 1, canvas: {}, objects: [] } }) as never;

/** The card types of the Home view in a seeded list. */
const typesOf = (views: ReturnType<typeof seedHomeView>) =>
  (views.find((v) => v.id === HOME_VIEW_ID)!.layout?.objects ?? []).map((o) => o.config.type);

/** A Home the operator has saved at least once. */
const edited = (views: ReturnType<typeof seedHomeView>, objects: unknown[]) =>
  views.map((v) =>
    v.id === HOME_VIEW_ID
      ? ({ ...v, layoutRev: 1, layout: { ...v.layout!, objects } } as never)
      : v,
  );

describe("seeding", () => {
  test("adds Home when it is absent", () => {
    const out = seedHomeView([view("a")]);
    assert.equal(out.length, 2);
    assert.ok(out.some((v) => v.id === HOME_VIEW_ID));
  });

  test("Home starts with the cards the fixed panels showed", () => {
    assert.deepEqual(typesOf(seedHomeView([])), [
      "home-live-status",
      "home-next-service",
      "home-readiness",
      "home-recent-services",
    ]);
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

  test("the views array is returned BY REFERENCE when Home is already current", () => {
    // So the caller can skip the write entirely. A fresh array every load means
    // a save every load, which is a file rewrite for nothing.
    const once = seedHomeView([]);
    assert.equal(seedHomeView(once), once);
  });

  test("a card the operator DELETED stays deleted", () => {
    // THE guard. Keying off the view's contents instead of "has a person saved
    // this" would put the readiness card back every launch, and an operator who
    // removed it would have no way to keep it gone.
    const once = seedHomeView([]);
    const objects = once
      .find((v) => v.id === HOME_VIEW_ID)!
      .layout!.objects.filter((o) => o.config.type !== "home-readiness");
    const after = seedHomeView(edited(once, objects));
    assert.deepEqual(
      typesOf(after),
      ["home-live-status", "home-next-service", "home-recent-services"],
      "the deleted card came back",
    );
  });

  test("an EMPTY Home the operator saved stays empty", () => {
    // The extreme of the same property: switching every card off is a legitimate
    // thing to want, and "no objects" must not read as "never seeded".
    assert.deepEqual(typesOf(seedHomeView(edited(seedHomeView([]), []))), []);
  });

  test("an UNEDITED Home gets the cards this build ships", () => {
    // The other half. Home shipped with two cards and now has four; without
    // this, every install that ran the older build would be missing the two new
    // ones permanently, with nothing in the UI to explain why.
    const stale = seedHomeView([]).map((v) =>
      v.id === HOME_VIEW_ID
        ? ({
            ...v,
            layout: {
              ...v.layout!,
              objects: v.layout!.objects.filter(
                (o) => o.config.type === "home-next-service" || o.config.type === "home-readiness",
              ),
            },
          } as never)
        : v,
    );
    assert.deepEqual(typesOf(seedHomeView(stale)), [
      "home-live-status",
      "home-next-service",
      "home-readiness",
      "home-recent-services",
    ]);
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

  // No geometry assertions. Home reads presence and ORDER only — every x/y/w/h
  // in this layout is filler the LayoutObject type demands, and a test that
  // pinned them would be asserting something nothing draws from. See the note
  // at the top of home-view.ts.
});

describe("the Screens list", () => {
  test("Home does not appear in it", () => {
    // Home is the front door, not a screen: it has no geometry, and on a wall
    // monitor it would render a stack of cards sized for a browser column.
    const listed = screensListViews(seedHomeView([view("stage"), view("lobby")]));
    assert.ok(!listed.some((v) => v.id === HOME_VIEW_ID), "Home is offered as a screen");
  });

  test("Home is not offered as a console either", () => {
    // The rail lists one row per CONSOLE view, and Home is a console — so the
    // rail carried two Home entries, the real front door at the top and a second
    // under Consoles that opened Home's cards on a bare canvas. Both lists run
    // through this same filter now, which is the composition asserted here.
    const consoles = screensListViews(seedHomeView([view("stage")])).filter(
      (v) => (v as { surface?: string }).surface === "console",
    );
    assert.ok(!consoles.some((v) => v.id === HOME_VIEW_ID), "Home is offered as a console");
  });

  test("every other view still is", () => {
    // The filter must take Home and nothing else — an over-eager one would hide
    // views an operator cannot then reach at all, since the Views list is gone.
    const all = seedHomeView([view("stage"), view("lobby")]);
    assert.deepEqual(
      screensListViews(all).map((v) => v.id),
      ["stage", "lobby"],
    );
  });
});

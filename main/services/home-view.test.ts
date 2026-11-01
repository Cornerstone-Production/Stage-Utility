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
      "home-attention",
      "timer",
      "home-recording",
      "home-spl",
      "home-screens",
      "home-next-service",
      "home-recent-services",
      "message-composer",
    ]);
  });

  test("the seeded timer is the service clock, as wide as Home goes and only while live", () => {
    // The card the retired `home-live-status` was: it reads as this Timer, so a
    // new Home and an old one draw the same thing, and the tile it arrives in is
    // stated on the card because a Timer's own default is not an xl live tile.
    const timer = seedHomeView([]).find((v) => v.id === HOME_VIEW_ID)!.layout!.objects.find((o) => o.config.type === "timer")!;
    assert.deepEqual(timer.config, { type: "timer", source: "service", nextItem: true });
    assert.deepEqual(timer.home, { size: "xl", when: "live" });
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
      .layout!.objects.filter((o) => o.config.type !== "home-attention");
    const after = seedHomeView(edited(once, objects));
    assert.deepEqual(
      typesOf(after),
      ["timer", "home-recording", "home-spl", "home-screens", "home-next-service", "home-recent-services", "message-composer"],
      "the deleted card came back",
    );
  });

  test("an EDITED Home that holds Readiness is left alone: Needs attention is not swapped in", () => {
    // Needs attention replaces Readiness only on a Home nobody has saved. Someone
    // who arranged their own keeps the card they chose.
    const once = seedHomeView([]);
    const objects = once
      .find((v) => v.id === HOME_VIEW_ID)!
      .layout!.objects.map((o) => (o.config.type === "home-attention" ? { ...o, config: { type: "home-readiness" } } : o));
    assert.deepEqual(typesOf(seedHomeView(edited(once, objects))), [
      "home-readiness", "timer", "home-recording", "home-spl", "home-screens", "home-next-service", "home-recent-services", "message-composer",
    ]);
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
      "home-attention",
      "timer",
      "home-recording",
      "home-spl",
      "home-screens",
      "home-next-service",
      "home-recent-services",
      "message-composer",
    ]);
  });

  test("the message composer arrives on an unedited Home, as an extra large always-on tile", () => {
    const composer = seedHomeView([])
      .find((v) => v.id === HOME_VIEW_ID)!
      .layout!.objects.find((o) => o.config.type === "message-composer");
    assert.deepEqual(composer?.home, { size: "xl", when: "always" });
  });

  test("an edited Home that lacks the composer is left without it", () => {
    const once = seedHomeView([]);
    const objects = once
      .find((v) => v.id === HOME_VIEW_ID)!
      .layout!.objects.filter((o) => o.config.type !== "message-composer");
    assert.ok(
      !typesOf(seedHomeView(edited(once, objects))).includes("message-composer"),
      "an operator's saved Home is theirs; the seed must not add a card to it",
    );
  });

  test("a renamed Home is not duplicated", () => {
    const once = seedHomeView([]);
    const renamed = once.map((v) => (v.id === HOME_VIEW_ID ? { ...v, name: "Front page" } : v));
    assert.equal(seedHomeView(renamed).length, once.length);
  });
});

describe("a Home saved before the Timer existed", () => {
  // `home-live-status` is retired into the Timer, but a Home the operator saved
  // keeps it, and it must keep working: it still reads as a Timer on screen, and
  // the older split — it once drew recording, SPL and screens inside itself —
  // still puts those back when they are missing.
  const old = (types: string[]) =>
    edited(seedHomeView([]), types.map((type, i) => ({ id: type, x: 0, y: i * 0.1, w: 1, h: 0.1, z: 1, config: { type }, style: {} })));

  test("an edited Home holding the old card keeps it, untouched", () => {
    const home = old(["home-live-status", "home-recording", "home-spl", "home-screens"]);
    assert.equal(seedHomeView(home), home);
    assert.deepEqual(typesOf(seedHomeView(home)), ["home-live-status", "home-recording", "home-spl", "home-screens"]);
  });

  test("the old card with its three stats missing gets them back, directly after it", () => {
    assert.deepEqual(typesOf(seedHomeView(old(["home-live-status", "home-next-service"]))), [
      "home-live-status",
      "home-recording",
      "home-spl",
      "home-screens",
      "home-next-service",
    ]);
  });
});

describe("the default layout", () => {
  test("is responsive, because Home is on whatever window the operator has", () => {
    assert.equal(defaultHomeLayout().canvas.fit, "responsive");
  });

  test("the cards stack rather than sitting on top of each other", () => {
    // Home ignores this geometry — but an output BOUND to Home before Phase 7
    // keeps rendering through the layout renderer, and identical coordinates
    // would draw four cards exactly on top of each other. Filler, not nonsense.
    const objs = defaultHomeLayout().objects;
    for (let i = 1; i < objs.length; i++) {
      assert.ok(
        objs[i - 1].y + objs[i - 1].h <= objs[i].y,
        `${objs[i].id} overlaps ${objs[i - 1].id}`,
      );
    }
  });

  test("every card sits inside the canvas", () => {
    for (const o of defaultHomeLayout().objects) {
      assert.ok(o.x >= 0 && o.x + o.w <= 1, `${o.id} escapes horizontally`);
      assert.ok(o.y >= 0 && o.y + o.h <= 1, `${o.id} escapes vertically`);
    }
  });
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

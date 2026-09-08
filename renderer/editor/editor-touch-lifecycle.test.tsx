// The editor's gesture LIFECYCLE, driven with real touch pointer events.
//
// On an iPad the layout editor could not hold a finger: a tap did not select, a
// drag did not follow, and lifting the finger did not end anything. Three
// separate gaps, none of which a mouse ever shows you and none of which the
// geometry tests can see, because the arithmetic was always right — it was never
// being handed a second event to do arithmetic with.
//
// What is asserted here is which handler ran and what geometry it produced:
// pointer ownership, capture, and the ends of a gesture. What is NOT asserted
// here, and cannot be:
//
// - `touch-action: none` actually preventing Safari from stealing the gesture.
//   jsdom loads no stylesheet, runs no compositor and has no scroll gesture to
//   steal. The DECLARATION is asserted below (test "the canvas declares
//   touch-action"); that it works is a browser question, driven under Chrome
//   touch emulation and recorded in the PR.
// - The 28px hit area on the 9px resize handles. It is a `@media (pointer:
//   coarse)` pseudo-element in styles.css; jsdom parses no stylesheet and
//   reports every box as 0x0, so a test here could only re-read the CSS text —
//   the kind of guard this repo has shipped vacuous four times. Verified in a
//   browser instead. What IS tested is the arithmetic that sizes it
//   (handlePadPx) and the variable each handle hands the rule.
// - Anything about feel: how far is far enough, how a drag looks mid-flight.

import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const React = (await import("react")).default;
const { render, cleanup, act } = await import("@testing-library/react");
const { EditorCanvas, handlePadPx } = await import("./layout-editor.js");

const CANVAS = { width: 1920, height: 1080, background: null };

// jsdom lays nothing out and the canvas draws nothing at a zero-size wrapper, so
// every element reports the same box a browser would give the editor pane. That
// makes the canvas box 1000 x 562.5 (min(1000/1920, 600/1080) = 0.5208 scale),
// and a top-level object's parent box is the canvas.
const PANE = { width: 1000, height: 600 };
const BOX_W = 1000;
const BOX_H = 562.5;
const realRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function () {
  return { ...PANE, top: 0, left: 0, right: PANE.width, bottom: PANE.height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
};

// jsdom implements PointerEvent but not pointer capture. Recording the calls is
// the point: capture is the whole reason a finger that drifts off a 9px handle
// keeps driving the drag, and it is invisible in any other assertion.
const captured: { id: number }[] = [];
const held = new Set<number>();
Element.prototype.setPointerCapture = function (id: number) {
  captured.push({ id });
  held.add(id);
};
Element.prototype.hasPointerCapture = function (id: number) {
  return held.has(id);
};
Element.prototype.releasePointerCapture = function (id: number) {
  held.delete(id);
};

after(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = realRect;
  teardown();
});

const TEXT = {
  id: "o1",
  x: 0.1, y: 0.2, w: 0.3, h: 0.16, z: 1,
  config: { type: "text", text: "hello" },
  style: {},
};
const OBJECTS = [TEXT];
// A container the text object already OVERLAPS, without anything having been
// dragged. Its centre (0.25, 0.28) is inside the container (0.05..0.55,
// 0.1..0.6), which is what turned a tap into a reparent.
const CONTAINER = {
  id: "c1",
  x: 0.05, y: 0.1, w: 0.5, h: 0.5, z: 0,
  config: { type: "container" },
  style: {},
  children: [],
};

type Geom = { x: number; y: number; w: number; h: number };

interface Harness {
  container: HTMLElement;
  geoms: { id: string; geom: Geom }[];
  selects: (string | null)[];
  marquees: { hits: string[] }[];
  reparents: string[];
  /** Undo entries pushed. A tap must push none. */
  commits: number;
  menus: (string | null)[];
  box: () => HTMLElement;
  node: (id?: string) => HTMLElement;
  handles: () => HTMLElement[];
}

function mount(interactive = true, objects: unknown[] = OBJECTS): Harness {
  const geoms: { id: string; geom: Geom }[] = [];
  const selects: (string | null)[] = [];
  const marquees: { hits: string[] }[] = [];
  const reparents: string[] = [];
  const menus: (string | null)[] = [];
  const h = { commits: 0 } as Harness;
  const { container } = render(
    React.createElement(EditorCanvas as never, {
      canvas: CANVAS,
      objects,
      selectedId: "o1",
      selectedIds: new Set(["o1"]),
      gridOn: false,
      alignOn: false,
      locked: false,
      ctx: { now: Date.now(), skewMs: 0, H: 0, interactive: false },
      ndiSource: null,
      interactive,
      onSelect: (id: string | null) => selects.push(id),
      onMarqueeSelect: (hits: string[]) => marquees.push({ hits }),
      onGeom: (id: string, geom: Geom) => geoms.push({ id, geom }),
      onGeomMany: () => {},
      onCommitStart: () => { h.commits += 1; },
      onReparent: (id: string) => reparents.push(id),
      // The real openContextMenu lives in LayoutEditor, which is not mounted
      // here. What the canvas owes it is the event, with the object still
      // findable from the target — the exact lookup that handler does.
      onContextMenu: (e: { target: unknown; preventDefault: () => void }) => {
        e.preventDefault();
        menus.push((e.target as HTMLElement).closest?.("[data-obj-id]")?.getAttribute("data-obj-id") ?? null);
      },
    } as never),
  );
  return Object.assign(h, {
    container,
    geoms,
    selects,
    marquees,
    reparents,
    menus,
    box: () => container.querySelector("[data-editor-canvas]") as HTMLElement,
    node: (id = "o1") => container.querySelector(`[data-obj-id="${id}"]`) as HTMLElement,
    handles: () => [...container.querySelectorAll(".editor-handle")] as HTMLElement[],
  });
}

/** A real PointerEvent, from a finger. */
function touch(type: string, x: number, y: number, pointerId = 1, opts: { isPrimary?: boolean; button?: number } = {}) {
  return new window.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId,
    pointerType: "touch",
    isPrimary: opts.isPrimary ?? pointerId === 1,
    button: opts.button ?? (type === "pointermove" ? -1 : 0),
    buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
    clientX: x,
    clientY: y,
  });
}

/** Down on an element (React's delegated listener); everything after it on the
 *  window, which is where the drag binds — exactly as a browser delivers it once
 *  the pointer is captured. */
function down(el: Element, x: number, y: number, pointerId = 1, opts: { isPrimary?: boolean; button?: number } = {}) {
  act(() => { el.dispatchEvent(touch("pointerdown", x, y, pointerId, opts)); });
}
function on(type: string, x: number, y: number, pointerId = 1) {
  act(() => { window.dispatchEvent(touch(type, x, y, pointerId)); });
}

beforeEach(() => {
  cleanup();
  captured.length = 0;
  held.clear();
});

describe("a finger can move an object", () => {
  test("down, move, up moves it, and the pointer was captured", () => {
    const h = mount();
    down(h.node(), 300, 300);
    assert.equal(captured.length, 1, "the drag did not capture the pointer — a finger that drifts off the object stops steering it");

    on("pointermove", 420, 300);
    const last = h.geoms.at(-1);
    assert.ok(last, "no geometry at all: pointermove after a touch pointerdown reached nothing");
    // 120px right on a 1000px canvas box = 0.12 of the canvas.
    assert.equal(last.id, "o1");
    assert.ok(
      Math.abs(last.geom.x - (0.1 + 120 / BOX_W)) < 1e-6,
      `expected x ~${(0.1 + 120 / BOX_W).toFixed(4)}, got ${last.geom.x}`,
    );
    assert.ok(Math.abs(last.geom.y - 0.2) < 1e-6, `y drifted to ${last.geom.y}`);

    // And down, on the shorter axis, where the object's parent box is boxH.
    on("pointermove", 420, 400);
    const down100 = h.geoms.at(-1);
    assert.ok(
      down100 && Math.abs(down100.geom.y - (0.2 + 100 / BOX_H)) < 1e-6,
      `expected y ~${(0.2 + 100 / BOX_H).toFixed(4)}, got ${down100?.geom.y}`,
    );

    on("pointerup", 420, 400);
    const after = h.geoms.length;
    on("pointermove", 600, 300);
    assert.equal(h.geoms.length, after, "the object kept following the pointer after it lifted");
  });

  test("a tap selects and does not nudge", () => {
    const h = mount();
    down(h.node(), 300, 300);
    assert.deepEqual(h.selects, ["o1"], "a tap on an object did not select it");
    // A finger always wobbles a few px between landing and lifting.
    on("pointermove", 303, 302);
    on("pointerup", 303, 302);
    assert.equal(h.geoms.length, 0, `a tap moved the object (${JSON.stringify(h.geoms)})`);
  });

  test("a tap on empty canvas clears the selection", () => {
    const h = mount();
    // 5px of wobble. Past the marquee's own fractional threshold (0.004 of a
    // 1000px box = 4px), so without the touch slop this became a marquee that
    // selected nothing instead of a tap that cleared.
    down(h.box(), 700, 500);
    on("pointermove", 705, 501);
    on("pointerup", 705, 501);
    assert.deepEqual(h.selects, [null], `expected one clear, got ${JSON.stringify(h.selects)}`);
  });
});

describe("a gesture belongs to one pointer, and ends when it is cancelled", () => {
  // THE guard. Remove the `pointercancel` listener from the drag effect in
  // layout-editor.tsx and this goes red: the moves after the cancel still apply,
  // because the gesture was never torn down.
  test("pointercancel ends the drag and leaves the object where it got to", () => {
    const h = mount();
    down(h.node(), 300, 300);
    on("pointermove", 400, 300);
    const atCancel = h.geoms.at(-1);
    assert.ok(atCancel, "the drag never started");
    const x = atCancel.geom.x;

    act(() => { window.dispatchEvent(touch("pointercancel", 400, 300)); });

    // Where the last move put it. Not back to the start, not on to anywhere else.
    assert.ok(
      Math.abs(x - (0.1 + 100 / BOX_W)) < 1e-6,
      `the object did not stop where the last move left it (x=${x})`,
    );
    const after = h.geoms.length;
    on("pointermove", 800, 300);
    on("pointermove", 900, 420);
    assert.equal(
      h.geoms.length,
      after,
      "moves after pointercancel still moved the object — the drag never ended",
    );
    on("pointerup", 900, 420);
    assert.equal(h.reparents.length, 0, "a cancelled drag reparented something");
  });

  test("a cancelled gesture releases the capture it took", () => {
    const h = mount();
    down(h.node(), 300, 300);
    on("pointermove", 400, 300);
    act(() => { window.dispatchEvent(touch("pointercancel", 400, 300)); });
    assert.equal(held.size, 0, "the element still holds the pointer after a cancel");
  });

  test("a second finger's moves do not steer the drag", () => {
    const h = mount();
    down(h.node(), 300, 300);
    on("pointermove", 400, 300);
    const owned = h.geoms.length;

    // A palm or a second fingertip lands and travels a long way.
    down(h.node(), 700, 500, 2);
    on("pointermove", 900, 500, 2);
    on("pointerup", 900, 500, 2);
    assert.equal(h.geoms.length, owned, "a second pointer moved an object it never picked up");

    // And the first finger still owns its gesture.
    on("pointermove", 500, 300);
    const last = h.geoms.at(-1);
    assert.ok(
      last && Math.abs(last.geom.x - (0.1 + 200 / BOX_W)) < 1e-6,
      `the first finger lost its gesture to the second (x=${last?.geom.x})`,
    );
  });
});

describe("the canvas declares touch-action", () => {
  // Not a proof that Safari behaves — see the header. It is a proof that the
  // declaration is there and is conditional, which is the part that can silently
  // regress in a refactor.
  test("none while interactive, absent when read-only", () => {
    const editing = mount(true);
    assert.equal(
      editing.box().style.touchAction,
      "none",
      "the editor canvas does not declare touch-action: none — Safari will take every drag as a scroll a few pixels in",
    );
    // A press-and-hold otherwise raises iOS's copy callout over the drag.
    assert.equal(editing.box().style.userSelect, "none", "the canvas is text-selectable during a drag");
    cleanup();

    const preview = mount(false);
    assert.equal(
      preview.box().style.touchAction,
      "",
      "a read-only preview claimed the gesture; it is a thing you scroll past",
    );
  });
});

describe("a tap is a selection, not an edit", () => {
  // THE guard for the worst of these. Drop `dragMoved.current &&` from finish()
  // in layout-editor.tsx and this goes red: dragGeom is seeded at pointerdown
  // with the object's OWN rect, so an object that already overlaps a container
  // reparents itself the moment it is tapped. A mouse click did it too; on a
  // tablet, tapping is how you select anything at all.
  test("tapping an object that overlaps a container does not move it into it", () => {
    const h = mount(true, [CONTAINER, TEXT]);
    down(h.node(), 300, 300);
    on("pointerup", 300, 300);
    assert.deepEqual(h.reparents, [], `a tap reparented the object into a container (${JSON.stringify(h.reparents)})`);
    assert.equal(h.geoms.length, 0, `a tap changed the geometry (${JSON.stringify(h.geoms)})`);
    assert.equal(h.commits, 0, "a tap pushed an undo entry — ten taps then cost ten ⌘Zs that undo nothing");
    assert.deepEqual(h.selects, ["o1"], "the tap stopped selecting");
  });

  test("a drag that DOES move still reparents, and pushes exactly one undo entry", () => {
    const h = mount(true, [CONTAINER, TEXT]);
    down(h.node(), 300, 300);
    on("pointermove", 340, 320);
    on("pointermove", 360, 330);
    assert.equal(h.commits, 1, `expected one undo entry for one drag, got ${h.commits}`);
    on("pointerup", 360, 330);
    assert.deepEqual(h.reparents, ["o1"], "a real drop into a container stopped reparenting");
  });
});

describe("a non-primary button never starts a drag", () => {
  // Weaken the gate in startDrag to `!e.isPrimary` and this goes red.
  test("right-click does not drag, and the object is still identifiable to the menu", () => {
    const h = mount();
    down(h.node(), 300, 300, 1, { button: 2 });
    on("pointermove", 500, 400);
    on("pointerup", 500, 400);
    assert.equal(h.geoms.length, 0, `a right-press dragged the object (${JSON.stringify(h.geoms)})`);
    assert.equal(captured.length, 0, "a right-press captured the pointer");
    assert.ok(
      !h.node().style.outline.includes("dashed"),
      "the object is drawn as being dragged after a right-press — the drag state was entered",
    );
    // The menu path is untouched: the contextmenu that follows still resolves to
    // this object, which is how openContextMenu selects it.
    act(() => {
      h.node().dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    });
    assert.deepEqual(h.menus, ["o1"], `the right-click menu could not tell what was under it (${JSON.stringify(h.menus)})`);
  });

  // Delete `if (drag) return;` from startDrag and this goes red: the second
  // pointerdown replaces the drag state wholesale and the object jumps to it.
  test("a second pointerdown mid-drag is ignored, even a primary one", () => {
    const h = mount();
    down(h.node(), 300, 300);
    on("pointermove", 400, 300);
    const owned = h.geoms.length;

    down(h.node(), 700, 500, 3, { isPrimary: true });
    on("pointermove", 900, 500, 3);
    assert.equal(h.geoms.length, owned, "a pointerdown during a drag stole the gesture");
    assert.equal(h.commits, 1, `a second pointerdown pushed another undo entry (${h.commits} total)`);

    // The first finger still owns it.
    on("pointermove", 500, 300);
    const last = h.geoms.at(-1);
    assert.ok(
      last && Math.abs(last.geom.x - (0.1 + 200 / BOX_W)) < 1e-6,
      `the original gesture lost its pointer (x=${last?.geom.x})`,
    );
  });
});

describe("a gesture whose owner unmounts lets go of the window", () => {
  // Drop the unmount effect that calls marqueeGesture.current.cancel() (or make
  // bindGesture return void again) and this goes red: the marquee's listeners
  // stay on the window and the pointerup selects into a tree that is gone.
  test("a marquee in flight when the canvas unmounts stops there", () => {
    const h = mount();
    down(h.box(), 700, 500);
    on("pointermove", 760, 540);
    const selectsBefore = h.selects.length;
    const marqueesBefore = h.marquees.length;

    act(() => { cleanup(); });

    on("pointermove", 800, 560);
    on("pointerup", 800, 560);
    assert.equal(h.selects.length, selectsBefore, "an unmounted canvas still selected something");
    assert.equal(
      h.marquees.length,
      marqueesBefore,
      "the marquee finished after its canvas was gone — its listeners were never unbound",
    );
    assert.equal(held.size, 0, "the unmounted canvas is still holding the pointer capture");
  });
});

describe("the resize handles size their touch pad from the object", () => {
  // A flat 9.5px pad on all eight handles leaves a small widget with no move
  // region: every touch lands on a handle and the thing can be resized but never
  // dragged. The pad itself is a `@media (pointer: coarse)` pseudo-element that
  // jsdom cannot see; the arithmetic behind it is pure, and this is it.
  test("handlePadPx", () => {
    const big = handlePadPx(200, 120);
    assert.deepEqual(big, { corner: 9.5, edge: 9.5 }, `a 200x120 object should get the full 28px targets, got ${JSON.stringify(big)}`);

    const small = handlePadPx(40, 30);
    assert.deepEqual(small, { corner: 0, edge: 0 }, `a 40x30 object has no room for pads, got ${JSON.stringify(small)}`);

    const mid = handlePadPx(80, 60);
    assert.equal(mid.edge, 0, `an 80x60 object must lose its edge pads first, got ${mid.edge}`);
    assert.ok(mid.corner > 0 && mid.corner < 9.5, `an 80x60 object's corner pads should be reduced, not full or gone (${mid.corner})`);

    // Sized off the SHORTER side: a wide, short object is the one that runs out.
    assert.deepEqual(handlePadPx(2000, 30), { corner: 0, edge: 0 }, "a 2000x30 strip was given pads it has no height for");
    // Monotonic, so there is no size at which growing an object shrinks its target.
    for (let s = 20; s < 200; s += 5) {
      assert.ok(handlePadPx(s + 5, s + 5).corner >= handlePadPx(s, s).corner, `pad shrank between ${s} and ${s + 5}`);
    }
  });

  test("each handle carries its pad as a CSS variable", () => {
    const h = mount();
    const handles = h.handles();
    assert.equal(handles.length, 8, `expected eight handles on the selected object, got ${handles.length}`);
    // o1 is 0.3 x 0.16 of a 1000 x 562.5 box = 300 x 90 px, comfortably past
    // every threshold, so all eight get the full pad.
    for (const el of handles) {
      assert.equal(
        el.style.getPropertyValue("--handle-pad"),
        "9.5px",
        "a handle shipped without --handle-pad — the coarse-pointer rule then falls back to no pad at all",
      );
    }
    // Corners over edges: with equal z-index, DOM order put `w` on top of `nw`.
    const z = handles.map((el) => Number(el.style.zIndex));
    assert.deepEqual(
      [...new Set(z)].sort(),
      [10, 11],
      `handles must sit on two layers, corners above edges (got ${JSON.stringify(z)})`,
    );
  });
});

// A slot photo asks the proxy for the size it is drawn at.
//
// The Screens page draws each screen as a 1280-wide kiosk page in an iframe
// scaled to under half, and the kiosk page cannot see that scale from its own
// layout: it measured itself at 1280 and downloaded every face at full size.
// These drive the real SlotPanel and check the `?s=` it puts on the photo URL for
// a box of known size, inside a scaled frame, on a 2x screen, after a transform
// arrives late, and for a photo that does not match its box's shape.
//
// jsdom has no layout, so the photo box's size, the frame's scale and a loaded
// image's natural size are stubbed. What is under test is the arithmetic and the
// React plumbing from a measured box to the <img src>. Paint timing — that the
// photo is there in the first paint — cannot be seen in jsdom and was checked in
// a real browser.
//
// Cleanup lives in `t.after()`, never a trailing statement, so a failed
// assertion cannot leave a stub installed for the next test.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const { SlotPanel } = await import("../components/slot-panel.js");
const { frameScale } = await import("./use-photo-size.js");

after(() => {
  cleanup();
  teardown();
});

/** The shape PCO serves, for a person who does not exist. */
const PHOTO = "https://avatars.planningcenteronline.com/uploads/person/100000001-1600000000/avatar.2.png?g=1000x1000";

/** A PCO slot matched to a person who has a photo. */
function photoSlot(photoUrl: string | null = PHOTO, displayName: string | null = "Jordan Example"): Slot {
  return {
    id: "s1",
    channel: "1",
    order: 0,
    link: { kind: "pco", matchBy: "person", personId: "p1" },
    displayName,
    photoUrl,
    device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null, charge: null, iemCharge: null, label: null, iemLabel: null },
  } as unknown as Slot;
}

/** The size the photo box answers getBoundingClientRect with. */
let box = { width: 0, height: 0 };
/** Live observers' callbacks. `disconnect` takes its own out, as a browser's does. */
const observers = new Set<() => void>();

function stubLayout(t: { after: (fn: () => void) => void }) {
  const proto = window.HTMLElement.prototype;
  const realRect = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const { width, height } = this.classList.contains("slot-photo") ? box : { width: 0, height: 0 };
    return { width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, toJSON() {} } as DOMRect;
  };
  const RealRO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    private fire: () => void;
    constructor(cb: ResizeObserverCallback) {
      this.fire = () => cb([], this as unknown as ResizeObserver);
    }
    observe() {
      observers.add(this.fire);
    }
    unobserve() {}
    disconnect() {
      observers.delete(this.fire);
    }
  } as unknown as typeof ResizeObserver;
  t.after(() => {
    proto.getBoundingClientRect = realRect;
    globalThis.ResizeObserver = RealRO;
    observers.clear();
    box = { width: 0, height: 0 };
  });
}

/** Tell every live observer the box changed, the way a browser would. */
function resize(width: number, height: number) {
  box = { width, height };
  act(() => {
    for (const fire of observers) fire();
  });
}

/** The photo finished loading at this natural size. */
function loaded(container: HTMLElement, naturalWidth: number, naturalHeight: number) {
  const img = container.querySelector("img")!;
  Object.defineProperty(img, "naturalWidth", { configurable: true, value: naturalWidth });
  Object.defineProperty(img, "naturalHeight", { configurable: true, value: naturalHeight });
  fireEvent.load(img);
}

function stubWindow(t: { after: (fn: () => void) => void }, name: "frameElement" | "devicePixelRatio", value: unknown) {
  const own = Object.getOwnPropertyDescriptor(window, name);
  Object.defineProperty(window, name, { configurable: true, get: () => value });
  t.after(() => {
    if (own) Object.defineProperty(window, name, own);
    else delete (window as unknown as Record<string, unknown>)[name];
  });
}

const photoSrc = (container: HTMLElement) => container.querySelector("img")?.getAttribute("src") ?? null;
const sizeParam = (src: string | null) => (src ? new URLSearchParams(src.split("?")[1]).get("s") : null);

describe("the size a slot photo asks for", () => {
  test("asks for the rung that covers the box's longest side", (t) => {
    stubLayout(t);
    box = { width: 98, height: 240 };
    const { container } = render(<SlotPanel slot={photoSlot()} />);
    t.after(() => cleanup());

    assert.equal(sizeParam(photoSrc(container)), "256");
    // The photo URL itself rides through untouched: the proxy does the resizing.
    assert.equal(new URLSearchParams(photoSrc(container)!.split("?")[1]).get("u"), PHOTO);
  });

  test("counts device pixels, so a 2x screen asks for twice the size", (t) => {
    stubLayout(t);
    stubWindow(t, "devicePixelRatio", 2);
    box = { width: 98, height: 240 };
    const { container } = render(<SlotPanel slot={photoSlot()} />);
    t.after(() => cleanup());

    // 240 CSS px is 480 device px. At 1x it would have asked for 256.
    assert.equal(sizeParam(photoSrc(container)), "512");
  });

  test("counts the scale of the frame it is drawn in", (t) => {
    stubLayout(t);
    // A Screens preview: the kiosk page is laid out 1280 wide and drawn 320.
    stubWindow(t, "frameElement", {
      getBoundingClientRect: () => ({ width: 320 }),
      offsetWidth: 1280,
      ownerDocument: { defaultView: { frameElement: null } },
    });
    box = { width: 98, height: 560 };
    const { container } = render(<SlotPanel slot={photoSlot()} />);
    t.after(() => cleanup());

    // 560 laid out, 140 drawn. Unscaled it would have asked for 768.
    assert.equal(sizeParam(photoSrc(container)), "192");
  });

  test("asks for no size when the box is bigger than the ladder", (t) => {
    stubLayout(t);
    box = { width: 400, height: 1200 };
    const { container } = render(<SlotPanel slot={photoSlot()} />);
    t.after(() => cleanup());

    const src = photoSrc(container);
    assert.ok(src, "no photo rendered");
    assert.equal(sizeParam(src), null, "a full-size display box was sent a small photo");
  });

  test("downloads nothing until the box has a size", (t) => {
    stubLayout(t);
    const { container } = render(<SlotPanel slot={photoSlot()} />);
    t.after(() => cleanup());
    assert.equal(photoSrc(container), null, "fetched a photo for a box it had not measured");

    resize(98, 240);
    assert.equal(sizeParam(photoSrc(container)), "256");
  });

  test("measures a box that appears after the slot mounted", (t) => {
    stubLayout(t);
    box = { width: 98, height: 240 };
    // No name yet: the slot draws as unfilled, with no photo box at all.
    const view = render(<SlotPanel slot={photoSlot(PHOTO, null)} />);
    t.after(() => cleanup());
    assert.equal(photoSrc(view.container), null);

    act(() => {
      view.rerender(<SlotPanel slot={photoSlot()} />);
    });
    assert.equal(sizeParam(photoSrc(view.container)), "256", "the late photo box was never measured");
  });

  test("grows with the box, and does not shrink back", (t) => {
    stubLayout(t);
    box = { width: 60, height: 100 };
    const { container } = render(<SlotPanel slot={photoSlot()} />);
    t.after(() => cleanup());
    assert.equal(sizeParam(photoSrc(container)), "128");

    resize(150, 300);
    assert.equal(sizeParam(photoSrc(container)), "384", "a larger box kept the small photo");

    // Shrinking again: the sharper photo is already loaded, so asking for a
    // smaller one would spend a download to lose detail.
    resize(60, 100);
    assert.equal(sizeParam(photoSrc(container)), "384");
  });

  test("measures again when the photo loads, for a transform that arrived late", (t) => {
    stubLayout(t);
    // A letterboxed layout measures its canvas a frame after mount, so the slot
    // first sees the unscaled box. The transform changes what is drawn, not the
    // box, and a ResizeObserver never hears of it.
    box = { width: 200, height: 400 };
    const { container } = render(<SlotPanel slot={photoSlot()} />);
    t.after(() => cleanup());
    assert.equal(sizeParam(photoSrc(container)), "512");

    box = { width: 400, height: 800 }; // scale(2), no resize event
    loaded(container, 512, 512);
    assert.equal(sizeParam(photoSrc(container)), null, "a 4K display kept a 512px face");
  });

  test("asks for more when the photo does not cover its box", (t) => {
    stubLayout(t);
    // object-fit: cover fills the SHORTER side. A landscape original in a tall
    // box comes back 256x192 at s=256 and is stretched 1.3x to fill 250 tall.
    box = { width: 150, height: 250 };
    const { container } = render(<SlotPanel slot={photoSlot()} />);
    t.after(() => cleanup());
    assert.equal(sizeParam(photoSrc(container)), "256");

    loaded(container, 256, 192);
    assert.equal(sizeParam(photoSrc(container)), "384", "a stretched photo was left stretched");

    // One that covers is left alone.
    loaded(container, 384, 288);
    assert.equal(sizeParam(photoSrc(container)), "384");
  });

  test("swaps a new photo into the same image, so the old face stays until it loads", (t) => {
    stubLayout(t);
    box = { width: 150, height: 300 };
    const view = render(<SlotPanel slot={photoSlot()} />);
    t.after(() => cleanup());
    const img = view.container.querySelector("img");
    assert.ok(img);

    const next = PHOTO.replace("avatar.2", "avatar.3");
    act(() => {
      view.rerender(<SlotPanel slot={photoSlot(next)} />);
    });

    const now = view.container.querySelector("img");
    // assert.ok, not assert.equal: a failing equal on two DOM nodes tries to
    // print a diff of jsdom's whole object graph and never finishes.
    assert.ok(now === img, "the <img> was replaced, which blanks the slot until the new photo loads");
    assert.equal(new URLSearchParams(now!.getAttribute("src")!.split("?")[1]).get("u"), next);
    assert.equal(sizeParam(now!.getAttribute("src")), "384");
  });

  test("stops observing the box when the slot unmounts", (t) => {
    stubLayout(t);
    box = { width: 98, height: 240 };
    const view = render(<SlotPanel slot={photoSlot()} />);
    t.after(() => cleanup());
    assert.equal(observers.size, 1);

    view.unmount();
    assert.equal(observers.size, 0, "an unmounted slot kept its ResizeObserver");
  });
});

describe("frameScale", () => {
  const frame = (drawn: number, laidOut: number, parent: Window | null) =>
    ({ frameElement: { getBoundingClientRect: () => ({ width: drawn }), offsetWidth: laidOut, ownerDocument: { defaultView: parent } } }) as unknown as Window;

  test("is 1 in a top-level page", () => {
    assert.equal(frameScale({ frameElement: null } as unknown as Window), 1);
  });

  test("multiplies the scales of nested same-origin frames", () => {
    const top = { frameElement: null } as unknown as Window;
    assert.equal(frameScale(frame(320, 1280, frame(500, 1000, top))), 0.125);
  });

  test("ignores a frame with no size rather than dividing by it", () => {
    assert.equal(frameScale(frame(0, 0, { frameElement: null } as unknown as Window)), 1);
  });
});

// A photo on a letterboxed layout asks for the size it is drawn at on screen.
//
// A display's custom layout is a design canvas scaled to fit the screen. The
// scale is measured after the canvas mounts, and objects used to be drawn
// straight away, inside a canvas still at scale(1). A slot photo measures itself
// on mount, so it saw the design size rather than the screen size, and because a
// photo's size only ever grows it never came back down: a 1920 canvas in a Screens
// preview (1280 wide, so 0.667) fetched every face at 1.5x the pixels it drew.
//
// jsdom has no layout, so the box and the photo's drawn size are stubbed. The
// photo's stub reads the canvas's ACTUAL transform off the DOM, the way a browser
// folds it into getBoundingClientRect, so what is under test is whether the
// transform is in place by the time the photo first measures.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const PHOTO = "https://avatars.planningcenteronline.com/uploads/person/100000001-1600000000/avatar.2.png?g=1000x1000";

const STATE = {
  hourCycle: "24h",
  timezone: null,
  barItems: [],
  barMobileItems: [],
  outputs: [],
  views: [],
  devices: [],
  pcoConfigured: true,
  slotsByView: {},
  slotsByLayoutObject: {
    grid: [
      {
        id: "s1",
        channel: "1",
        order: 0,
        link: { kind: "pco", matchBy: "person", personId: "p1" },
        displayName: "Jordan Example",
        photoUrl: PHOTO,
        device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null, charge: null, iemCharge: null, label: null, iemLabel: null },
      },
    ],
  },
};

(globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
  const body = String(url).includes("/api/state") ? STATE : null;
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};
(globalThis as unknown as { EventSource: unknown }).EventSource = class {
  addEventListener() {}
  removeEventListener() {}
  close() {}
};

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { LayoutRenderer } = await import("./layout-renderer.js");

const settle = () => new Promise((r) => setTimeout(r, 0));

after(async () => {
  cleanup();
  await settle();
  teardown();
});

/** The design size of the photo box, before any transform. */
const PHOTO_BOX = { width: 200, height: 360 };

/** The product of every `scale(…)` on the element's ancestors. */
function drawnScale(el: Element): number {
  let s = 1;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const m = /scale\(([\d.]+)\)/.exec(p.style.transform);
    if (m) s *= Number(m[1]);
  }
  return s;
}

describe("a photo on a letterboxed layout", () => {
  test("measures after the canvas is scaled, so it asks for the screen size", async (t) => {
    const proto = window.HTMLElement.prototype;
    const realRect = proto.getBoundingClientRect;
    const realW = Object.getOwnPropertyDescriptor(proto, "clientWidth");
    const realH = Object.getOwnPropertyDescriptor(proto, "clientHeight");
    // Every box is the Screens preview's 1280x720 iframe viewport.
    Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 1280 });
    Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 720 });
    proto.getBoundingClientRect = function (this: HTMLElement) {
      const s = this.classList.contains("slot-photo") ? drawnScale(this) : 0;
      const width = PHOTO_BOX.width * s;
      const height = PHOTO_BOX.height * s;
      return { width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, toJSON() {} } as DOMRect;
    };
    t.after(() => {
      proto.getBoundingClientRect = realRect;
      if (realW) Object.defineProperty(proto, "clientWidth", realW);
      if (realH) Object.defineProperty(proto, "clientHeight", realH);
      cleanup();
    });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        React.createElement(LayoutRenderer, {
          layout: {
            canvas: { width: 1920, height: 1080 },
            objects: [
              { id: "grid", x: 0, y: 0, w: 0.5, h: 0.5, z: 1, config: { type: "slots-grid", source: "inline", sourceViewId: null } },
            ],
          },
          viewId: "view-1",
        } as never),
      ));
      await settle();
    });

    const src = container.querySelector("img")?.getAttribute("src");
    assert.ok(src, "the grid drew no photo");
    // 360 design px at 1280/1920 = 240 on screen: the 256 rung. Measured at
    // scale(1) it asks for 384, and a size that only grows keeps it.
    assert.equal(new URLSearchParams(src.split("?")[1]).get("s"), "256");
  });
});

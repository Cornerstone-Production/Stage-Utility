// The shared fit: the search itself, and when the hook measures again.
//
// jsdom lays nothing out, so the box and the content's size are stood in for by
// getters on the prototype: the box is a fixed 400x100, and the content is as tall
// as a rule the test sets, from the font size it was just given. That is enough to
// pin the search and WHEN it runs; that real text wraps, and that the answer fills
// a real box, was driven in Chromium (see the commit that added this).

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";

const teardown = installRenderDom();

let contentHeightOf: (fontPx: number) => number = (px) => px * 2;
const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
Object.defineProperty(proto, "clientWidth", { get: () => 400, configurable: true });
let boxHeight = 100;
Object.defineProperty(proto, "clientHeight", { get: () => boxHeight, configurable: true });
Object.defineProperty(proto, "scrollWidth", { get: () => 10, configurable: true });
Object.defineProperty(proto, "offsetHeight", {
  get(this: HTMLElement) {
    return contentHeightOf(parseFloat(this.style.fontSize) || 0);
  },
  configurable: true,
});

const { render, cleanup, act } = await import("@testing-library/react");
const { largestFit, useBoxFit } = await import("./fit-to-box.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  contentHeightOf = (px) => px * 2;
  boxHeight = 100;
});

describe("largestFit", () => {
  test("is exactly the ceiling when the ceiling fits", () => {
    assert.equal(largestFit(8, 120, () => true), 120);
  });

  test("is the floor when nothing fits: small, never invisible", () => {
    assert.ok(Math.abs(largestFit(8, 120, () => false) - 8) < 0.1);
  });

  test("finds the largest fit to a fraction of a unit, across a jump", () => {
    // Wrapped text: height does not grow smoothly with the size; it jumps when a
    // line breaks. 37.3 is where this one jumps past the box.
    const found = largestFit(8, 120, (v) => v <= 37.3);
    assert.ok(found <= 37.3 && found > 37.2, `found ${found}`);
  });
});

function Probe({ keyed, onValue }: { keyed: string; onValue: (v: number) => void }) {
  const { wrapRef, contentRef, value } = useBoxFit<HTMLDivElement>({
    floor: 8,
    ceiling: 90,
    initial: 20,
    contentKey: keyed,
    apply: (el, px) => {
      el.style.fontSize = `${px}px`;
    },
  });
  onValue(value);
  return (
    <div ref={wrapRef}>
      <div ref={contentRef} style={{ fontSize: `${value}px` }} />
    </div>
  );
}

describe("useBoxFit", () => {
  test("lands on the largest size whose content fits the box", async () => {
    let seen = 0;
    await act(async () => {
      render(<Probe keyed="a" onValue={(v) => (seen = v)} />);
      await settle();
    });
    // Content is 2x the font size and the box is 100 high.
    assert.ok(seen > 49.9 && seen <= 50, `fitted ${seen}`);
  });

  test("measures again when the content key changes, and only then", async () => {
    let seen = 0;
    let r!: ReturnType<typeof render>;
    await act(async () => {
      r = render(<Probe keyed="a" onValue={(v) => (seen = v)} />);
      await settle();
    });
    const first = seen;
    // The content got taller; same key: nothing re-measures.
    contentHeightOf = (px) => px * 4;
    await act(async () => {
      r.rerender(<Probe keyed="a" onValue={(v) => (seen = v)} />);
      await settle();
    });
    assert.equal(seen, first, "measured again with nothing to say the content changed");
    await act(async () => {
      r.rerender(<Probe keyed="b" onValue={(v) => (seen = v)} />);
      await settle();
    });
    assert.ok(seen > 24.9 && seen <= 25, `a changed key did not re-measure: ${seen}`);
  });

  test("measures again once the fonts have loaded", async () => {
    let release!: () => void;
    const ready = new Promise<void>((r) => (release = r));
    (document as unknown as { fonts: unknown }).fonts = { ready };
    let seen = 0;
    try {
      await act(async () => {
        render(<Probe keyed="a" onValue={(v) => (seen = v)} />);
        await settle();
      });
      const first = seen;
      // The face that replaces the fallback sets taller text.
      contentHeightOf = (px) => px * 4;
      await act(async () => {
        release();
        await settle();
      });
      assert.notEqual(seen, first, "a measure taken in the fallback face was kept");
      assert.ok(seen > 24.9 && seen <= 25, `fitted ${seen}`);
    } finally {
      delete (document as unknown as { fonts?: unknown }).fonts;
    }
  });
});

describe("a resize", () => {
  test("measures again when the box the observer watches changes size", async () => {
    // A ResizeObserver that reports only what it was told to observe, and fires on
    // demand: the stub installDom provides never calls back, so it could not tell a
    // hook that observes from one that does not.
    const live: { cb: () => void; targets: Element[] }[] = [];
    const g = globalThis as unknown as { ResizeObserver: unknown };
    const real = g.ResizeObserver;
    g.ResizeObserver = class {
      targets: Element[] = [];
      constructor(public cb: () => void) {
        live.push(this);
      }
      observe(el: Element) {
        this.targets.push(el);
      }
      disconnect() {
        this.targets = [];
      }
      unobserve() {}
    };
    let seen = 0;
    try {
      await act(async () => {
        render(<Probe keyed="a" onValue={(v) => (seen = v)} />);
        await settle();
      });
      assert.ok(seen > 49.9 && seen <= 50, `fitted ${seen}`);
      assert.ok(live.some((o) => o.targets.length > 0), "nothing was observed");
      boxHeight = 60;
      await act(async () => {
        for (const o of live) if (o.targets.length) o.cb();
        await settle();
      });
      assert.ok(seen > 29.9 && seen <= 30, `the box shrank and the fit did not follow: ${seen}`);
    } finally {
      g.ResizeObserver = real;
    }
  });
});

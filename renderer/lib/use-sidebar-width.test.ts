import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

// The DOM must exist before the module is evaluated - a `before` hook runs after
// the module body.
import { installDom } from "../test-dom.js";

const teardown = installDom();

const {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
} = await import("./use-sidebar-width.js");

after(() => {
  teardown();
});

// The drag itself cannot be tested here - this repository's tooling cannot drive
// React pointer-drags, which is why the marquee work needed a human click-test.
// What IS testable is the clamping, and that is where an unusable rail comes
// from: a width restored outside the bounds leaves no obvious way back.
describe("sidebar width clamping", () => {
  test("keeps an ordinary width untouched", () => {
    assert.equal(clampSidebarWidth(260), 260);
  });

  test("clamps below the minimum rather than letting the rail vanish", () => {
    // Dragging past the left edge would otherwise produce a zero or negative
    // width and a rail that cannot be grabbed again.
    assert.equal(clampSidebarWidth(10), MIN_SIDEBAR_WIDTH);
    assert.equal(clampSidebarWidth(0), MIN_SIDEBAR_WIDTH);
    assert.equal(clampSidebarWidth(-500), MIN_SIDEBAR_WIDTH);
  });

  test("clamps above the maximum rather than letting it eat the content", () => {
    assert.equal(clampSidebarWidth(5000), MAX_SIDEBAR_WIDTH);
  });

  test("falls back to the default for a value that is not a number", () => {
    // localStorage returns strings, so a corrupted entry arrives as NaN. Without
    // this the rail renders at NaN px, which computes to zero.
    assert.equal(clampSidebarWidth(Number("not-a-width")), DEFAULT_SIDEBAR_WIDTH);
    assert.equal(clampSidebarWidth(Infinity), DEFAULT_SIDEBAR_WIDTH);
  });

  test("rounds to whole pixels", () => {
    assert.equal(clampSidebarWidth(233.7), 234);
  });

  test("the default sits inside its own bounds", () => {
    // A default outside the range would be clamped on every read, so the rail
    // would silently start at the wrong width.
    assert.ok(DEFAULT_SIDEBAR_WIDTH >= MIN_SIDEBAR_WIDTH);
    assert.ok(DEFAULT_SIDEBAR_WIDTH <= MAX_SIDEBAR_WIDTH);
    assert.equal(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH), DEFAULT_SIDEBAR_WIDTH);
  });
});

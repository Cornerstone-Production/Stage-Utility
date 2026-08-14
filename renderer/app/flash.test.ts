import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { flashTarget, FLASH_CLASS } = await import("./flash.js");

after(() => teardown());

/** flashTarget waits two animation frames before touching the DOM. */
function afterFrames(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))),
  );
}

describe("flash highlight", () => {
  test("highlights the matching target", async () => {
    const el = document.createElement("div");
    el.setAttribute("data-flash-id", "pco-token");
    document.body.appendChild(el);
    flashTarget("pco-token");
    await afterFrames();
    assert.ok(el.classList.contains(FLASH_CLASS));
    el.remove();
  });

  test("scrolls the target into view", async () => {
    // Highlighting something off-screen is the same as not highlighting it.
    const el = document.createElement("div");
    el.setAttribute("data-flash-id", "scrolls");
    let scrolled: unknown = null;
    (el as unknown as { scrollIntoView: (o: unknown) => void }).scrollIntoView = (o) => { scrolled = o; };
    document.body.appendChild(el);
    flashTarget("scrolls");
    await afterFrames();
    assert.deepEqual(scrolled, { behavior: "smooth", block: "center" });
    el.remove();
  });

  test("does not throw when the target never renders", async () => {
    // A destination may legitimately not show the field - an integration that
    // is not configured. Throwing would blank the route just navigated to.
    flashTarget("nothing-has-this-id");
    await afterFrames();
    assert.ok(true);
  });

  test("waits for the destination to render rather than acting immediately", async () => {
    // The element does not exist when navigation starts. Querying synchronously
    // finds nothing and the highlight silently never happens - which is exactly
    // what a naive port of this does.
    const el = document.createElement("div");
    el.setAttribute("data-flash-id", "late");
    flashTarget("late");
    // Appended AFTER the call, before the frames elapse.
    document.body.appendChild(el);
    await afterFrames();
    assert.ok(el.classList.contains(FLASH_CLASS));
    el.remove();
  });
});

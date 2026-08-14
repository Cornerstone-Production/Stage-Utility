import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { flashTarget, FLASH_CLASS, REVEAL_EVENT, pendingFlashTarget } = await import("./flash.js");

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

describe("revealing a hidden target", () => {
  test("announces what it is looking for before searching", () => {
    // A target can be inside a collapsed section, so it is not in the DOM to be
    // found. flashTarget asks first and looks second; without the announcement
    // the search can only fail.
    let announced: string | null = null;
    const onReveal = (e: Event) => {
      announced = (e as CustomEvent<{ flashId: string }>).detail.flashId;
    };
    window.addEventListener(REVEAL_EVENT, onReveal);
    flashTarget("hidden-thing");
    window.removeEventListener(REVEAL_EVENT, onReveal);
    assert.equal(announced, "hidden-thing");
  });

  test("finds a target that appears only after being revealed", async () => {
    // The realistic sequence: the listener expands a section, React renders it,
    // and the element shows up several frames later. A single look would miss
    // it and the highlight would silently never happen.
    const el = document.createElement("div");
    el.setAttribute("data-flash-id", "revealed-late");
    const onReveal = () => {
      setTimeout(() => document.body.appendChild(el), 120);
    };
    window.addEventListener(REVEAL_EVENT, onReveal);
    flashTarget("revealed-late");
    await new Promise((r) => setTimeout(r, 400));
    window.removeEventListener(REVEAL_EVENT, onReveal);
    assert.ok(el.classList.contains(FLASH_CLASS), "a revealed target must still be highlighted");
    el.remove();
  });
});

describe("the pending target, for listeners that mount late", () => {
  test("is readable while a search is in flight", async () => {
    // flashTarget runs on the page being LEFT, so the destination's listeners
    // do not exist when the event fires. A component that can hide the target
    // reads this on mount instead - which is the whole reason Getting Started's
    // first step could not highlight anything.
    flashTarget("in-flight");
    assert.equal(pendingFlashTarget(), "in-flight");
    await new Promise((r) => setTimeout(r, 1400));
  });

  test("clears once the target is found", async () => {
    const el = document.createElement("div");
    el.setAttribute("data-flash-id", "found-it");
    document.body.appendChild(el);
    flashTarget("found-it");
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(pendingFlashTarget(), null, "a found target must not stay pending");
    el.remove();
  });

  test("clears when the search gives up", async () => {
    // Left set, the next listener to mount would reveal something nobody asked
    // for - minutes later, on an unrelated navigation.
    flashTarget("never-appears");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(pendingFlashTarget(), null, "an abandoned search must not stay pending");
  });
});

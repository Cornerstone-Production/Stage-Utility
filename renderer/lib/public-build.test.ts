// public-build.ts — a page left open across a deploy reloads itself, once.
//
// What is asserted here is the DECISION: which offers of a build id reload the page,
// which are left alone, and what is written before a reload so that a page that comes
// back on the same wrong build does not reload forever. What is not asserted is that
// the reload keeps the address: that is `location.reload()`, which jsdom neither
// performs nor lets a test observe, so it is driven in a browser (see the PR) and the
// seam below stands in for it.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const PAGE = "aaaaaaaaaaaa";
const NEXT = "bbbbbbbbbbbb";
const AFTER_THAT = "cccccccccccc";

const teardown = installDom(`<!doctype html><html><head><meta name="servicecue-build" content="${PAGE}" /></head><body></body></html>`);
after(teardown);

const g = globalThis as unknown as Record<string, unknown>;
const warnings: string[] = [];
const logs: string[] = [];
console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));

const build = await import("./public-build.js");

/** What the page's own document says its build is: an id, something that is not one, or nothing. */
function setPageBuild(content: string | null): void {
  document.head.querySelectorAll('meta[name="servicecue-build"]').forEach((m) => m.remove());
  if (content === null) return;
  const meta = document.createElement("meta");
  meta.setAttribute("name", "servicecue-build");
  meta.setAttribute("content", content);
  document.head.append(meta);
}

/** Every reload asked for, and what the tab's storage held at the moment each was asked. */
let reloads: (string | null)[] = [];
const sessionDescriptor = Object.getOwnPropertyDescriptor(g, "sessionStorage")!;

beforeEach(() => {
  setPageBuild(PAGE);
  reloads = [];
  // The note a reload leaves is read AT the reload: it has to be there before the page goes.
  build.__setReloadForTests(() => void reloads.push(sessionStorage.getItem(build.RELOADED_FOR_KEY)));
});
afterEach(() => {
  build.__setReloadForTests(null);
  build.__resetPublicBuildForTests();
  Object.defineProperty(g, "sessionStorage", sessionDescriptor);
  sessionStorage.clear();
  localStorage.clear();
  warnings.length = 0;
  logs.length = 0;
});

describe("the build this page is", () => {
  test("is the id its own document is stamped with", () => {
    assert.equal(build.runningBuild(), PAGE);
  });

  test("is nothing when the document carries no id, or one that is not an id", () => {
    setPageBuild(null);
    assert.equal(build.runningBuild(), null);
    for (const content of ["", "short", "AAAAAAAAAAAA", "aaaaaaaaaaaaa", "gggggggggggg", "aaaaaaaaaaaa "]) {
      setPageBuild(content);
      assert.equal(build.runningBuild(), null, JSON.stringify(content));
    }
  });

  test("is nothing where there is no document at all", () => {
    const real = Object.getOwnPropertyDescriptor(g, "document")!;
    Object.defineProperty(g, "document", { value: undefined, configurable: true, writable: true });
    try {
      assert.equal(build.runningBuild(), null);
      assert.equal(build.reloadForNewBuild(NEXT), "unknown");
    } finally {
      Object.defineProperty(g, "document", real);
    }
    assert.deepEqual(reloads, []);
  });
});

describe("an offer of a build that is the page's own", () => {
  test("is left alone: no reload, and nothing written", () => {
    assert.equal(build.reloadForNewBuild(PAGE), "same");
    assert.deepEqual(reloads, []);
    assert.equal(sessionStorage.length, 0);
    assert.deepEqual(warnings, []);
  });
});

describe("an offer the page cannot compare", () => {
  test("from a page with no id of its own is not acted on: a dev server, or a build from before ids, never reloads", () => {
    for (const own of [null, "not-an-id"]) {
      setPageBuild(own);
      assert.equal(build.reloadForNewBuild(NEXT), "unknown", String(own));
    }
    assert.deepEqual(reloads, []);
    assert.equal(sessionStorage.length, 0);
  });

  test("that is not an id is not acted on, whatever it is", () => {
    for (const offered of [undefined, null, 0, 123456789012, {}, [], "", "short", "BBBBBBBBBBBB", "bbbbbbbbbbbbb", "bbbbbbbbbbbb\n", ["bbbbbbbbbbbb"]]) {
      assert.equal(build.reloadForNewBuild(offered), "unknown", JSON.stringify(offered));
    }
    assert.deepEqual(reloads, []);
    assert.equal(sessionStorage.length, 0);
  });
});

describe("an offer of a different build", () => {
  test("reloads the page, once, having written down which build it reloaded for BEFORE going", () => {
    assert.equal(build.reloadForNewBuild(NEXT), "reloading");
    assert.deepEqual(reloads, [NEXT], "the reload was asked for with no note in the tab, or no reload was asked for");
    assert.equal(sessionStorage.getItem(build.RELOADED_FOR_KEY), NEXT);
    assert.equal(logs.filter((l) => l.includes("[public-build]") && l.includes(NEXT) && l.includes(PAGE)).length, 1, "a reload is on the console");
  });

  test("the note is the tab's own: a note in localStorage would send one open tab and strand the others", () => {
    build.reloadForNewBuild(NEXT);
    assert.equal(localStorage.getItem(build.RELOADED_FOR_KEY), null);
    assert.equal(sessionStorage.getItem(build.RELOADED_FOR_KEY), NEXT);
    // And a note in localStorage, which another tab could have left, does not stop this tab.
    sessionStorage.clear();
    localStorage.setItem(build.RELOADED_FOR_KEY, NEXT);
    reloads = [];
    assert.equal(build.reloadForNewBuild(NEXT), "reloading");
    assert.deepEqual(reloads, [NEXT]);
  });

  test("is not reloaded for again by the same build: the page that came back still the old build stays where it is and says so", () => {
    assert.equal(build.reloadForNewBuild(NEXT), "reloading");
    // The reload brought the same old page back, with the tab's storage as it was left.
    for (let beat = 0; beat < 5; beat++) assert.equal(build.reloadForNewBuild(NEXT), "already-tried");
    assert.deepEqual(reloads, [NEXT], "it reloaded more than once for one build");
    assert.equal(warnings.filter((w) => w.includes("[public-build]") && w.includes("not reloading again")).length, 1, "said once, not on every heartbeat");
  });

  test("is reloaded for when it is a build the tab has not tried: the next deploy gets its reload", () => {
    build.reloadForNewBuild(NEXT);
    assert.equal(build.reloadForNewBuild(NEXT), "already-tried");
    assert.equal(build.reloadForNewBuild(AFTER_THAT), "reloading");
    assert.deepEqual(reloads, [NEXT, AFTER_THAT]);
    assert.equal(sessionStorage.getItem(build.RELOADED_FOR_KEY), AFTER_THAT);
  });

  test("is reloaded for when the note is not an id the tab could have written: a stale or mangled note does not hold it back", () => {
    for (const note of ["", "garbage", "bbbbbbbbbbbb ", "BBBBBBBBBBBB"]) {
      sessionStorage.setItem(build.RELOADED_FOR_KEY, note);
      reloads = [];
      assert.equal(build.reloadForNewBuild(NEXT), "reloading", JSON.stringify(note));
      assert.deepEqual(reloads, [NEXT]);
    }
  });
});

describe("a tab that cannot be made to remember", () => {
  test("is not reloaded, because a page that cannot prove it will not loop does not risk it: storage that throws on write", () => {
    Object.defineProperty(g, "sessionStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        removeItem: () => {},
      },
    });
    for (let beat = 0; beat < 4; beat++) assert.equal(build.reloadForNewBuild(NEXT), "cannot-remember");
    assert.deepEqual(reloads, []);
    assert.equal(warnings.filter((w) => w.includes("cannot remember a reload")).length, 1, "said once");
  });

  test("storage that throws when it is touched at all (blocked cookies)", () => {
    Object.defineProperty(g, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    assert.equal(build.reloadForNewBuild(NEXT), "cannot-remember");
    assert.deepEqual(reloads, []);
  });

  test("storage that is not there", () => {
    Object.defineProperty(g, "sessionStorage", { configurable: true, value: undefined });
    assert.equal(build.reloadForNewBuild(NEXT), "cannot-remember");
    assert.deepEqual(reloads, []);
  });

  test("storage that takes a write and keeps nothing: the note is read back, and what was not kept is not trusted", () => {
    Object.defineProperty(g, "sessionStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
    for (let beat = 0; beat < 3; beat++) assert.equal(build.reloadForNewBuild(NEXT), "cannot-remember");
    assert.deepEqual(reloads, []);
  });
});

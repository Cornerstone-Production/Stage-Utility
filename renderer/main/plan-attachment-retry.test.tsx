// A Plan file widget must not stay stuck until somebody refreshes the display.
//
// Two ways it did:
//   - A load that failed once (an expired signed link, a Planning Center blip)
//     was retried three times over about a minute and then left on "Couldn't
//     load file" for good.
//   - "No file on this plan" (a 404) was final, so a stage plot attached after
//     the display first asked never appeared.
//
// So the widget keeps asking: fast retries first, then every
// PLAN_ATTACHMENT_RECHECK_MS, for both "error" and "empty", until a file is
// drawn. A drawn file is not asked for again, nothing on screen is swapped for
// "Loading…" or for an error by a background check, a plan change asks at once,
// and unmounting stops it.
//
// jsdom has no canvas and never fires Image.onload, so "ready" needs a stand-in
// for both (stubImageDecode below). What jsdom cannot show — the notice's real
// size and position, a picture actually painted — is not unit-tested here; it was
// driven in a browser instead.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, mock, test } from "node:test";

import { installRenderDom, unmountAndTeardown } from "../test-dom.js";

const teardown = installRenderDom({ clientHeight: 270 });

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act } = await import("react");
const { TooltipProvider } = await import("../components/ui/tooltip-provider.js");
const { makeRenderCtx, DEFAULT_STAGE_STATE } = await import("./test-render-ctx.js");
const { ObjectContent, PLAN_ATTACHMENT_RETRY_MS, PLAN_ATTACHMENT_RECHECK_MS } = await import("./layout-renderer.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

/** Let resolved fetch promises and React's state updates land. setImmediate is
 *  real even while setTimeout is mocked, which is what makes this usable under
 *  mock.timers. */
async function flush() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setImmediate(r));
    });
  }
}

const PLOT = {
  id: "plot-1", x: 0, y: 0, w: 1, h: 1, z: 0,
  config: { type: "plan-attachment", match: "stage plot", page: 1 },
} as never;

type Answer = "404" | "502" | "file";
interface Call { url: string; init: RequestInit | undefined }

/** A fetch that answers each plan-file request from `answer(n)`, n counting the
 *  requests for the file (1-based), and records the client-log posts apart. */
function scriptFetch(answer: (n: number) => Answer) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/log/client")) {
      logs.push(String(init?.body));
      return new Response("{}", { status: 200 });
    }
    calls.push({ url, init });
    const a = answer(calls.length);
    if (a === "file") return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
    return new Response("no", { status: a === "404" ? 404 : 502 });
  }) as typeof fetch;
  return { calls, logs, restore: () => { globalThis.fetch = original; } };
}

/** The decode path a browser has and jsdom lacks: an Image that "loads", and a
 *  canvas that can be read back. Only what rasterizeImage and the PNG export touch. */
function stubImageDecode() {
  const g = globalThis as unknown as { Image?: unknown };
  const originalImage = g.Image;
  g.Image = class {
    naturalWidth = 10;
    naturalHeight = 10;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_v: string) {
      queueMicrotask(() => this.onload?.());
    }
  };
  const realCreate = document.createElement.bind(document);
  mock.method(document, "createElement", (tag: string, ...rest: unknown[]) => {
    const el = (realCreate as (t: string, ...r: unknown[]) => HTMLElement)(tag, ...rest);
    if (tag === "canvas") {
      Object.assign(el, { getContext: () => ({ drawImage() {} }), toDataURL: () => "data:image/png;base64,AAAA" });
    }
    return el;
  });
  return () => {
    g.Image = originalImage;
  };
}

let restore: Array<() => void> = [];
beforeEach(() => {
  restore = [];
  mock.timers.enable({ apis: ["setTimeout"] });
  restore.push(() => mock.timers.reset());
  restore.push(stubImageDecode());
});
afterEach(() => {
  for (const r of restore.reverse()) r();
  mock.restoreAll();
});

function ctxFor(planId: string | null) {
  return makeRenderCtx({ state: { ...DEFAULT_STAGE_STATE, planId } });
}
function tree(planId: string | null = null) {
  return React.createElement(
    TooltipProvider as never,
    null,
    React.createElement(ObjectContent, { o: PLOT, ctx: ctxFor(planId) } as never),
  );
}
function draw(planId: string | null = null) {
  return render(tree(planId));
}
const text = (v: { container: HTMLElement }) => v.container.textContent ?? "";
const drawn = (v: { container: HTMLElement }) => v.container.querySelector("img")?.getAttribute("src") ?? null;

async function tick(ms: number) {
  act(() => mock.timers.tick(ms));
  await flush();
}

describe("a plan attachment that fails to load", () => {
  test("retries on the fast schedule, then keeps retrying slowly, then recovers", async () => {
    const f = scriptFetch((n) => (n < 7 ? "502" : "file"));
    restore.push(f.restore);

    const view = draw();
    await flush();
    assert.equal(f.calls.length, 1, "the first load never happened");
    assert.match(text(view), /Couldn.t load file/, "the failure was not shown while waiting to retry");

    let expected = 1;
    for (const gap of PLAN_ATTACHMENT_RETRY_MS) {
      await tick(gap - 1);
      assert.equal(f.calls.length, expected, `retried before its ${gap}ms gap was up`);
      await tick(1);
      expected += 1;
      assert.equal(f.calls.length, expected, `did not retry after ${gap}ms`);
    }
    assert.equal(f.logs.length, 1, "the display must say once, on /log, that the file is still failing");
    assert.match(f.logs[0], /plan-file/);
    assert.match(f.logs[0], /stage plot/, "the log line must name the file");

    // The fast retries are spent. The old widget stopped here.
    for (let i = 0; i < 2; i++) {
      await tick(PLAN_ATTACHMENT_RECHECK_MS - 1);
      assert.equal(f.calls.length, expected, "re-checked before the slow interval was up");
      await tick(1);
      expected += 1;
      assert.equal(f.calls.length, expected, "stopped retrying after the fast retries; the wall stays on its notice until a refresh");
      assert.match(text(view), /Couldn.t load file/, "the notice was replaced during a background re-check");
    }
    assert.equal(f.logs.length, 1, "every slow retry logged; it must be once per outage");

    // The 7th request answers with a file.
    await tick(PLAN_ATTACHMENT_RECHECK_MS);
    assert.equal(f.calls.length, 7);
    assert.equal(drawn(view), "data:image/png;base64,AAAA", "the file was not drawn when the load recovered");
  });

  test("a retry goes around the browser's HTTP cache; the first load does not", async () => {
    const f = scriptFetch((n) => (n < 2 ? "502" : "file"));
    restore.push(f.restore);
    draw();
    await flush();
    await tick(PLAN_ATTACHMENT_RETRY_MS[0]);
    assert.equal(f.calls[0].init, undefined, "the first load must use the normal cache path");
    assert.equal(f.calls[1].init?.cache, "reload", "a retry must not be answered from the HTTP cache");
  });
});

describe("a plan attachment that is not on the plan", () => {
  test("is checked again, and drawn when the file is attached", async () => {
    const f = scriptFetch((n) => (n < 3 ? "404" : "file"));
    restore.push(f.restore);

    const view = draw();
    await flush();
    assert.match(text(view), /No "stage plot" on this plan/);

    await tick(PLAN_ATTACHMENT_RECHECK_MS - 1);
    assert.equal(f.calls.length, 1, "re-checked before the interval was up");
    await tick(1);
    assert.equal(f.calls.length, 2, "a 404 was final: a file attached later never appears");
    assert.match(text(view), /No "stage plot" on this plan/, "the notice was replaced during the re-check");
    assert.doesNotMatch(text(view), /Loading/, "flashed Loading… over the notice");
    assert.equal(f.calls[1].init?.cache, "reload", "the re-check of a 404 must bypass the browser's HTTP cache");

    await tick(PLAN_ATTACHMENT_RECHECK_MS);
    assert.equal(f.calls.length, 3);
    assert.equal(drawn(view), "data:image/png;base64,AAAA", "the file that was attached later was not drawn");
  });

  test("a failure on a re-check leaves the notice, and the checks go on", async () => {
    const f = scriptFetch((n) => (n === 2 ? "502" : n < 4 ? "404" : "file"));
    restore.push(f.restore);

    const view = draw();
    await flush();
    await tick(PLAN_ATTACHMENT_RECHECK_MS);
    assert.equal(f.calls.length, 2);
    assert.match(text(view), /No "stage plot" on this plan/, "a transient failure swapped the notice for an error");
    assert.doesNotMatch(text(view), /Couldn.t load/);

    // A failed check is retried on the fast schedule.
    await tick(PLAN_ATTACHMENT_RETRY_MS[0]);
    assert.equal(f.calls.length, 3);
    await tick(PLAN_ATTACHMENT_RECHECK_MS);
    assert.equal(drawn(view), "data:image/png;base64,AAAA");
  });
});

describe("a plan attachment that is drawn", () => {
  test("is not asked for again, and stays on screen", async () => {
    const f = scriptFetch(() => "file");
    restore.push(f.restore);

    const view = draw();
    await flush();
    assert.equal(drawn(view), "data:image/png;base64,AAAA");
    assert.equal(f.calls.length, 1);

    await tick(30 * 60_000);
    assert.equal(f.calls.length, 1, "a drawn file was fetched again; the server's cached 200 is not being used");
    assert.equal(drawn(view), "data:image/png;base64,AAAA", "the picture was replaced");
    assert.doesNotMatch(text(view), /Loading|Couldn.t load/);
  });
});

describe("a plan change", () => {
  test("re-fetches at once, from every state, without waiting for a timer", async () => {
    // First plan: a file. Second: not on it. Third: broken. Each swap must ask now.
    const f = scriptFetch((n) => (n === 1 ? "file" : n === 2 ? "404" : "502"));
    restore.push(f.restore);

    const view = draw("plan-a");
    await flush();
    assert.equal(drawn(view), "data:image/png;base64,AAAA");

    view.rerender(tree("plan-b"));
    await flush();
    assert.equal(f.calls.length, 2, "a plan change did not re-fetch");
    assert.match(f.calls[1].url, /plan=plan-b/);
    assert.equal(drawn(view), null, "the previous plan's picture lingered over the new plan");
    assert.match(text(view), /No "stage plot" on this plan/);

    view.rerender(tree("plan-c"));
    await flush();
    assert.equal(f.calls.length, 3, "a plan change while on the notice waited for the slow re-check");
    assert.match(f.calls[2].url, /plan=plan-c/);
  });

  test("the old plan's loop stops, so a late timer cannot ask for the old plan", async () => {
    const f = scriptFetch(() => "404");
    restore.push(f.restore);
    const view = draw("plan-a");
    await flush();
    view.rerender(tree("plan-b"));
    await flush();
    assert.equal(f.calls.length, 2);

    await tick(PLAN_ATTACHMENT_RECHECK_MS);
    const urls = f.calls.slice(2).map((c) => c.url);
    assert.equal(urls.length, 1, `one loop should be left, found ${urls.length} re-checks: ${urls.join(", ")}`);
    assert.match(urls[0], /plan=plan-b/);
  });
});

describe("unmounting", () => {
  test("stops the retries of a failing load", async () => {
    const f = scriptFetch(() => "502");
    restore.push(f.restore);
    const view = draw();
    await flush();
    view.unmount();
    await tick(60 * 60_000);
    assert.equal(f.calls.length, 1, "a failing widget kept retrying after it was unmounted");
  });

  test("stops the re-checks of an empty one", async () => {
    const f = scriptFetch(() => "404");
    restore.push(f.restore);
    const view = draw();
    await flush();
    view.unmount();
    await tick(60 * 60_000);
    assert.equal(f.calls.length, 1, "an empty widget kept re-checking after it was unmounted");
  });
});

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
// for both (stubImageDecode below). What jsdom cannot show is not unit-tested here:
// a picture actually painted, the notice's real size and position, and the
// browser's own HTTP cache turning a conditional request's 304 into the stored
// 200. Those were driven in headless Chrome against a real server (a download that
// fails and is fixed, a plan with no file that gets one, and a drawn file whose
// version changes), not asserted in this file.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, mock, test } from "node:test";

import { installRenderDom, unmountAndTeardown } from "../test-dom.js";

const teardown = installRenderDom({ clientHeight: 270 });

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act } = await import("react");
const { TooltipProvider } = await import("../components/ui/tooltip-provider.js");
const { makeRenderCtx, DEFAULT_STAGE_STATE } = await import("./test-render-ctx.js");
const { ObjectContent, PLAN_ATTACHMENT_RETRY_MS, PLAN_ATTACHMENT_RECHECK_MS, PLAN_ATTACHMENT_REVALIDATE_MS, PLAN_ATTACHMENT_FETCH_TIMEOUT_MS } = await import("./layout-renderer.js");

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
/** The ETag every "file" answer carries; a test changes it to replace the file. */
let etag: string | null = '"v1"';
interface Call { url: string; init: RequestInit | undefined }

/** A fetch that answers each plan-file request from `answer(n)`, n counting the
 *  requests for the file (1-based), and records the client-log posts apart. */
function scriptFetch(answer: (n: number) => Answer | "hang" | Promise<Answer>) {
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
    const a = await answer(calls.length);
    if (a === "hang") {
      // A server that accepts the connection and never answers: settles only when aborted.
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (a === "file") return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png", ...(etag ? { etag } : {}) } });
    return new Response("no", { status: a === "404" ? 404 : 502 });
  }) as typeof fetch;
  return { calls, logs, restore: () => { globalThis.fetch = original; } };
}

/** The decode path a browser has and jsdom lacks: an Image that "loads", and a
 *  canvas that can be read back. Only what rasterizeImage and the PNG export touch. */
let decodes = 0;
const PNG = (n: number) => `data:image/png;base64,${String.fromCharCode(65, 65, 65, 65 + n)}`; // AAAA, AAAB, ...
function stubImageDecode() {
  decodes = 0;
  const g = globalThis as unknown as { Image?: unknown };
  const originalImage = g.Image;
  g.Image = class {
    naturalWidth = 10;
    naturalHeight = 10;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_v: string) {
      decodes += 1;
      queueMicrotask(() => this.onload?.());
    }
  };
  const realCreate = document.createElement.bind(document);
  mock.method(document, "createElement", (tag: string, ...rest: unknown[]) => {
    const el = (realCreate as (t: string, ...r: unknown[]) => HTMLElement)(tag, ...rest);
    if (tag === "canvas") {
      Object.assign(el, { getContext: () => ({ drawImage() {} }), toDataURL: () => PNG(decodes - 1) });
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
  etag = '"v1"';
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
      assert.equal(f.logs.length, 0, `logged before the fast retries were spent (request ${expected})`);
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
    assert.equal(drawn(view), PNG(0), "the file was not drawn when the load recovered");
    assert.equal(f.logs.length, 2, "a display that logged an outage must log that it recovered");
    assert.match(f.logs[1], /plan-file/);
    assert.match(f.logs[1], /draws again/);
  });

  test("a retry goes around the browser's HTTP cache; the first load does not", async () => {
    const f = scriptFetch((n) => (n < 2 ? "502" : "file"));
    restore.push(f.restore);
    draw();
    await flush();
    await tick(PLAN_ATTACHMENT_RETRY_MS[0]);
    assert.equal(f.calls[0].init?.cache, undefined, "the first load must use the normal cache path");
    assert.equal(f.calls[1].init?.cache, "reload", "a retry must not be answered from the HTTP cache");
  });
});

describe("a server that never answers", () => {
  test("is a failure after the timeout, so the retries carry on", async () => {
    const f = scriptFetch((n) => (n === 1 ? "hang" : "file"));
    restore.push(f.restore);
    const view = draw();
    await flush();
    assert.equal(f.calls.length, 1);
    assert.match(text(view), /Loading/);

    await tick(PLAN_ATTACHMENT_FETCH_TIMEOUT_MS - 1);
    assert.match(text(view), /Loading/, "gave up before the timeout");
    await tick(1);
    assert.match(text(view), /Couldn.t load file/, "a request that never answered parked the widget on Loading…");

    await tick(PLAN_ATTACHMENT_RETRY_MS[0]);
    assert.equal(f.calls.length, 2, "no retry followed the timeout");
    assert.equal(drawn(view), PNG(0));
  });

  test("a re-validation that hangs leaves the picture and is asked again", async () => {
    const f = scriptFetch((n) => (n === 2 ? "hang" : "file"));
    restore.push(f.restore);
    const view = draw();
    await flush();
    await tick(PLAN_ATTACHMENT_REVALIDATE_MS);
    assert.equal(f.calls.length, 2);
    await tick(PLAN_ATTACHMENT_FETCH_TIMEOUT_MS);
    assert.equal(drawn(view), PNG(0));
    await tick(PLAN_ATTACHMENT_REVALIDATE_MS);
    assert.equal(f.calls.length, 3, "a hung re-validation stopped all later ones");
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
    assert.equal(drawn(view), PNG(0), "the file that was attached later was not drawn");
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
    assert.equal(drawn(view), PNG(0));
  });
});

describe("a plan attachment that is drawn", () => {
  test("is re-validated every few minutes, and an unchanged file is not redrawn", async () => {
    const f = scriptFetch(() => "file");
    restore.push(f.restore);

    const view = draw();
    await flush();
    assert.equal(drawn(view), PNG(0));
    assert.equal(f.calls.length, 1);
    assert.equal(decodes, 1);

    await tick(PLAN_ATTACHMENT_REVALIDATE_MS - 1);
    assert.equal(f.calls.length, 1, "re-validated before the interval was up");
    await tick(1);
    assert.equal(f.calls.length, 2, "a drawn file was never asked about again; a replaced file would stay up");
    assert.equal(f.calls[1].init?.cache, "no-cache", "the re-validation must be a conditional request, not a cached read");

    // The same ETag again: nothing is rasterized and the picture is untouched, and
    // the next look is a full re-validation interval away, not the 2-minute re-check.
    await tick(PLAN_ATTACHMENT_REVALIDATE_MS - 1);
    assert.equal(f.calls.length, 2, "after an unchanged re-validation the next one came early");
    await tick(1);
    assert.equal(f.calls.length, 3);
    for (let i = 0; i < 2; i++) await tick(PLAN_ATTACHMENT_REVALIDATE_MS);
    assert.equal(f.calls.length, 5);
    assert.equal(decodes, 1, "an unchanged file was rasterized again");
    assert.equal(drawn(view), PNG(0));
    assert.doesNotMatch(text(view), /Loading|Couldn.t load/);
  });

  test("a file that changed is drawn over the old one, which stays up until then", async () => {
    let release!: () => void;
    const f = scriptFetch((n) => (n === 2 ? new Promise<Answer>((r) => { release = () => r("file"); }) : "file"));
    restore.push(f.restore);

    const view = draw();
    await flush();
    assert.equal(drawn(view), PNG(0));

    etag = '"v2"';
    await tick(PLAN_ATTACHMENT_REVALIDATE_MS);
    assert.equal(f.calls.length, 2);
    assert.equal(drawn(view), PNG(0), "the old picture was taken down while the new file was loading");
    assert.doesNotMatch(text(view), /Loading/);

    release();
    await flush();
    assert.equal(drawn(view), PNG(1), "a replaced file was not drawn");
    assert.equal(decodes, 2);

    // And the new ETag is the one compared from now on.
    await tick(PLAN_ATTACHMENT_REVALIDATE_MS);
    assert.equal(decodes, 2, "the new version was redrawn although it had not changed again");
  });

  test("a failed re-validation leaves the picture, whatever it fails with", async () => {
    const f = scriptFetch((n) => (n === 1 ? "file" : n === 2 ? "502" : n === 3 ? "404" : "file"));
    restore.push(f.restore);

    const view = draw();
    await flush();
    for (const expectedCalls of [2, 3, 4]) {
      await tick(PLAN_ATTACHMENT_REVALIDATE_MS - 1);
      assert.equal(f.calls.length, expectedCalls - 1, "after a failed or empty re-validation the next one came early");
      await tick(1);
      assert.equal(f.calls.length, expectedCalls);
      assert.equal(drawn(view), PNG(0), "a failed or empty re-validation replaced the picture");
      assert.doesNotMatch(text(view), /Loading|Couldn.t load|No "stage plot"/);
    }
    assert.equal(f.logs.length, 0, "a good picture with a failed re-validation is not an outage");
  });

  test("a file served without an ETag is not asked about again", async () => {
    // Nothing to compare against, so asking would download and rasterize the file
    // every interval.
    etag = null;
    const f = scriptFetch(() => "file");
    restore.push(f.restore);
    const view = draw();
    await flush();
    assert.equal(drawn(view), PNG(0));
    for (let i = 0; i < 4; i++) await tick(PLAN_ATTACHMENT_REVALIDATE_MS);
    assert.equal(f.calls.length, 1, "a file with no ETag was fetched again");
    assert.equal(decodes, 1);
  });

  test("stops re-validating when unmounted", async () => {
    const f = scriptFetch(() => "file");
    restore.push(f.restore);
    const view = draw();
    await flush();
    view.unmount();
    await tick(60 * 60_000);
    assert.equal(f.calls.length, 1, "a drawn widget kept re-validating after it was unmounted");
  });
});

describe("a plan change", () => {
  test("re-fetches at once, from every state, without waiting for a timer", async () => {
    // First plan: a file. Second: not on it. Third: broken. Each swap must ask now.
    const f = scriptFetch((n) => (n === 1 ? "file" : n === 2 ? "404" : "502"));
    restore.push(f.restore);

    const view = draw("plan-a");
    await flush();
    assert.equal(drawn(view), PNG(0));

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

  test("a response that arrives after the plan changed is not drawn", async () => {
    // Plan A's request is held. The plan changes to B (no file). Then A's file
    // arrives: it belongs to the old plan and must not be drawn over B's notice.
    let release!: () => void;
    const held = new Promise<Answer>((resolve) => { release = () => resolve("file"); });
    const f = scriptFetch((n) => (n === 1 ? held : "404"));
    restore.push(f.restore);

    const view = draw("plan-a");
    await flush();
    assert.equal(f.calls.length, 1);

    view.rerender(tree("plan-b"));
    await flush();
    assert.equal(f.calls.length, 2);
    assert.match(text(view), /No "stage plot" on this plan/);

    release();
    await flush();
    assert.equal(drawn(view), null, "the old plan's file was drawn after the plan changed");
    assert.match(text(view), /No "stage plot" on this plan/);
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

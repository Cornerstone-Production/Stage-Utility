// lazy-preview-kept.test.tsx — a preview on the kept Screens page: it says when it
// is not live, it asks on the way back into view, and the cap holds across the
// page being hidden and shown again.
//
// The Screens page is kept mounted inside <Activity> while the operator is away
// (kept-screens.tsx). Hiding destroys every Effect: each card gives its slot back
// and stops listening to its iframe, while the iframe itself stays. These cases
// render the cards inside a real <Activity> and flip it, which is exactly that.
//
// What jsdom cannot show was driven in a browser instead: the dimmed picture and
// the chip's pixels (no stylesheet here), and a real stream dropping under a kept
// preview. Nothing below passes a DOM node as an assert operand: node:assert
// inspects `actual` to build its failure message, and a jsdom element does not
// finish.

import { strict as assert } from "node:assert";
import { after, afterEach, mock, test } from "node:test";

import { installRenderDom, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, screen, cleanup, act, fireEvent, within } = await import("@testing-library/react");
const React = await import("react");
const { LazyPreview, __previewLimits } = await import("./lazy-preview.js");
const { LIVE_ASK_TIMEOUT_MS } = await import("./use-liveness-probe.js");
const { PREVIEW_MSG } = await import("../../main/preview-messages.js");

const { MAX_LIVE_PREVIEWS, FADE_MS } = __previewLimits;

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  mock.timers.reset();
  cleanup();
  restoreIo?.();
  restoreIo = null;
  __previewLimits.reset();
});

// jsdom has no IntersectionObserver. This one is driven per card: `scroll(i, on)`.
type IoCallback = (entries: { isIntersecting: boolean }[]) => void;
let restoreIo: (() => void) | null = null;
function stubIntersectionObserver() {
  const g = globalThis as unknown as { IntersectionObserver?: unknown };
  const saved = g.IntersectionObserver;
  const byElement = new Map<Element, IoCallback>();
  g.IntersectionObserver = class {
    cb: IoCallback;
    constructor(callback: IoCallback) {
      this.cb = callback;
    }
    observe(el: Element) {
      byElement.set(el, this.cb);
    }
    disconnect() {}
  };
  restoreIo = () => { g.IntersectionObserver = saved; };
  return byElement;
}

function card(i: number) {
  return React.createElement(LazyPreview, {
    key: `c${i}`,
    viewId: `v${i}`,
    outputId: `o${i}`,
    name: `Screen ${i}`,
    onExpand: () => {},
    expandLabel: `Edit ${i}`,
  });
}

/** `n` cards on a page that can be hidden, as the kept Screens page is. */
function page(n: number, mode: "visible" | "hidden") {
  return React.createElement(React.Activity, {
    mode,
    children: React.createElement(
      "div",
      null,
      Array.from({ length: n }, (_, i) => React.createElement("section", { key: i, "data-card": i }, card(i))),
    ),
  });
}

async function mount(n: number) {
  const io = stubIntersectionObserver();
  mock.timers.enable({ apis: ["setTimeout"] });
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(page(n, "visible")); });
  const cardBox = (i: number) => view.container.querySelector(`[data-card="${i}"] > div`)!;
  const scroll = (i: number, on: boolean) => act(async () => { io.get(cardBox(i))!([{ isIntersecting: on }]); });
  for (let i = 0; i < n; i++) await scroll(i, true);
  const frame = (i: number) => view.container.querySelector<HTMLIFrameElement>(`[data-card="${i}"] iframe`);
  const hide = () => act(async () => { view.rerender(page(n, "hidden")); });
  const show = () => act(async () => { view.rerender(page(n, "visible")); });
  const frames = () => view.container.querySelectorAll("iframe").length;
  return { view, scroll, frame, hide, show, frames };
}

const tick = (ms: number) => act(async () => { mock.timers.tick(ms); });

/** What the page inside a card's iframe would post to it (stage-view.tsx). */
const report = (iframe: HTMLIFrameElement, viewId: string, live: boolean, since: number | null = null) =>
  act(async () => {
    const event = new MessageEvent("message", { data: { type: PREVIEW_MSG.LIVE, viewId, live, since, shared: true }, origin: window.location.origin });
    // jsdom's constructor refuses an iframe's window as `source`; the card matches on it.
    Object.defineProperty(event, "source", { value: iframe.contentWindow });
    window.dispatchEvent(event);
  });

function fadeClass(iframe: HTMLIFrameElement): string {
  const wrapper = iframe.closest(".transition-opacity");
  assert.ok(wrapper, "no fading wrapper above the iframe");
  return wrapper.className;
}

test("a live preview whose page says it is not live is dimmed under a Not live chip, until it is again", async () => {
  const { frame, view } = await mount(1);
  const iframe = frame(0)!;
  await report(iframe, "v0", true);
  assert.match(fadeClass(iframe), /opacity-100/);

  await report(iframe, "v0", false, Date.now() - 3 * 60_000);
  assert.equal(within(view.container).getByRole("status").textContent, "Not live", "a frozen frame passed for live");
  assert.match(view.container.textContent ?? "", /Not live·updated 3 min ago/, "the chip does not say how old the picture is");
  assert.match(fadeClass(iframe), /opacity-40/, "the not-live picture was not dimmed");
  assert.match(fadeClass(iframe), /grayscale/);

  await report(iframe, "v0", true);
  assert.equal(within(view.container).getByRole("status").textContent, "", "the status outlived the page going live again");
  assert.doesNotMatch(view.container.textContent ?? "", /updated/, "the chip outlived the page going live again");
  assert.match(fadeClass(iframe), /opacity-100/);
});

test("Retry on a not-live preview loads a new iframe", async () => {
  const { frame, view } = await mount(1);
  const old = frame(0)!;
  await report(old, "v0", true);
  await report(old, "v0", false, Date.now());
  await act(async () => { fireEvent.click(within(view.container).getByRole("button", { name: "Retry preview of Screen 0" })); });
  const fresh = frame(0);
  assert.ok(fresh && fresh !== old, "Retry kept the frozen iframe");
  assert.match(fadeClass(fresh), /opacity-0/, "the retried preview showed before it was live");
});

test("a report lost while the page was hidden: on return the card asks, and silence is Not live", async () => {
  const { frame, hide, show, view } = await mount(1);
  const iframe = frame(0)!;
  await report(iframe, "v0", true);
  const asked: unknown[] = [];
  mock.method(iframe.contentWindow!, "postMessage", (m: unknown) => { asked.push(m); });

  await hide();
  // The stream drops while the operator is away: nobody is listening.
  await report(iframe, "v0", false, Date.now());
  await show();
  assert.ok(frame(0) === iframe, "showing the page again reloaded the preview");
  assert.equal(asked.filter((m) => (m as { type?: string }).type === PREVIEW_MSG.ASK).length, 1, "the card did not ask on its return");
  assert.equal(within(view.container).getByRole("status").textContent, "", "said Not live before the page had a chance to answer");

  await tick(LIVE_ASK_TIMEOUT_MS);
  assert.equal(within(view.container).getByRole("status").textContent, "Not live", "an unanswered kept preview passed for live");
  assert.match(view.container.textContent ?? "", /Not liveRetry/, "a Not live with no known time still showed an age");
});

test("a kept preview that answers on return stays live", async () => {
  const { frame, hide, show, view } = await mount(1);
  const iframe = frame(0)!;
  await report(iframe, "v0", true);
  await hide();
  await show();
  await report(iframe, "v0", true);
  await tick(LIVE_ASK_TIMEOUT_MS);
  assert.equal(within(view.container).getByRole("status").textContent, "", "an answered ask still said Not live");
  assert.match(fadeClass(iframe), /opacity-100/);
});

test("the cap holds across hide and show: kept iframes reclaim before a card that has none", async () => {
  const n = MAX_LIVE_PREVIEWS + 1;
  const { scroll, frame, hide, show, frames } = await mount(n);
  assert.equal(frames(), MAX_LIVE_PREVIEWS, "the cap did not hold on the first load");
  // Card 0 scrolls off and gives its slot to the last card, then comes back and
  // waits: now a card with NO iframe sits before every kept one.
  await scroll(0, false);
  await tick(FADE_MS);
  await scroll(0, true);
  await act(async () => {});
  const lastKept = frame(n - 1);
  assert.ok(lastKept, "the last card never got the freed slot");
  assert.equal(frame(0), null);

  await hide();
  await show();
  await act(async () => {});
  assert.equal(frames(), MAX_LIVE_PREVIEWS, "showing the page again put an iframe past the cap");
  assert.ok(frame(n - 1) === lastKept, "a kept iframe lost its slot to a card that had none");
  assert.ok(screen.getAllByText("Preview paused — tap to load").length === 1, "the card without an iframe is not waiting");
  assert.equal(__previewLimits.liveCount(), MAX_LIVE_PREVIEWS);
});

test("hiding the page tells each kept preview it is hidden, and showing it again says shown", async () => {
  // A preview cannot always see it has been hidden (Firefox keeps telling it its
  // content is on screen), and a Video widget playing in it would go on pulling its
  // feed for the whole keep.
  const { frame, hide, show } = await mount(1);
  const iframe = frame(0)!;
  await report(iframe, "v0", true);
  const told: boolean[] = [];
  mock.method(iframe.contentWindow!, "postMessage", (m: { type?: string; hidden?: boolean }) => {
    if (m?.type === PREVIEW_MSG.HIDDEN) told.push(m.hidden!);
  });
  await hide();
  assert.deepEqual(told, [true], "the preview was not told it is hidden");
  await show();
  assert.deepEqual(told, [true, false], "the preview was not told it is shown again");
});

test("a kept card that had not gone live when the page was hidden keeps its ten seconds, not the ask's three", async () => {
  const lines: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/api/log/client")) {
      const { tag, message } = JSON.parse(String(init?.body)) as { tag: string; message: string };
      lines.push(`[${tag}] ${message}`);
    }
    return new Response("{}");
  }) as typeof fetch;
  mock.method(console, "warn", () => {});
  try {
    const { frame, hide, show, view } = await mount(1);
    // Loaded, and not live yet: its stream has not delivered.
    await report(frame(0)!, "v0", false, null);
    await hide();
    await show();
    await tick(LIVE_ASK_TIMEOUT_MS);
    assert.equal(within(view.container).getByRole("status").textContent, "", "the ask's three seconds failed a card that was still loading");
    await tick(10_000 - LIVE_ASK_TIMEOUT_MS);
    assert.equal(within(view.container).getByRole("status").textContent, "Preview didn’t load");
    assert.deepEqual(lines, ["[preview] Screen 0: the preview did not go live (no answer in 10 s)"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

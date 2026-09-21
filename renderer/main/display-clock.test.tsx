// THE WIRING GUARD: the digits a display actually draws are the server's.
//
// The clock maths is guarded in renderer/lib/server-clock.test.ts and the hooks
// in server-clock-hooks.test.tsx, and both were green while every surface in the
// app read `Date.now()`. Two independent reviews made the smallest faithful
// reversion — one line in `useLayoutData`, one in `useBarContext` — and the whole
// suite stayed at 7057 passing. Nothing connected the clock to the things that
// render one.
//
// Nor does the type checker, whatever it looks like. The collapse from
// `(now, skewMs)` to a single corrected `now` is enforced for ARITY only:
// `computePcoTimer(pcoLive, Date.now())` is two arguments of the right types and
// compiles clean. Nothing in the type system distinguishes the server's instant
// from the browser's, which is the only distinction that matters here.
//
// So this drives the REAL components with the host clock stubbed seven hours
// fast — the Ultritouch's measured drift — and asserts the rendered text. It is
// modelled on calendar-clock.test.tsx, which is the one guard in this repo that
// already did this properly.
//
// 24-HOUR on purpose: a 12-hour reading of a seven-hour drift can land on the
// same digits with a different meridiem, and the meridiem is a separate text
// node. The hour alone has to be unambiguous.
//
// NOT ASSERTED HERE: size, position or legibility. jsdom lays nothing out and
// reports every `offsetHeight` as 0, so Readout — which sizes itself from its box
// — renders at a size no assertion here could tell from any other. That was
// driven in a real browser.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

/** What the server says the time is: 14:05:00 UTC. */
const SERVER_NOW = "2026-08-14T14:05:00.000Z";
/** What this browser thinks it is: seven hours fast, the panel's measured drift. */
const DRIFTED = Date.parse(SERVER_NOW) + 7 * 3_600_000;

/** The hour a clock reading `ms` would draw, in this host's zone. */
const hourOf = (ms: number): string => String(new Date(ms).getHours()).padStart(2, "0");

const STATE = {
  hourCycle: "24h",
  timezone: null,
  barItems: ["clock"],
  barMobileItems: [],
  outputs: [],
  views: [],
  devices: [],
  pcoConfigured: true,
};

(globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
  const path = String(url);
  const body = path.includes("/api/state") ? STATE : null;
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

/** An EventSource that records its listeners, so a frame can be delivered. */
const sseHandlers = new Map<string, Set<(e: { data: string }) => void>>();
(globalThis as unknown as { EventSource: unknown }).EventSource = class {
  addEventListener(channel: string, fn: (e: { data: string }) => void) {
    let set = sseHandlers.get(channel);
    if (!set) sseHandlers.set(channel, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(channel: string, fn: (e: { data: string }) => void) {
    sseHandlers.get(channel)?.delete(fn);
  }
  close() {}
};

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { LayoutRenderer } = await import("./layout-renderer.js");
const { ContextBar } = await import("../app/context-bar.js");
const { SERVER_CLOCK_MIN_SPREAD_MS, serverClock } = await import("../lib/server-clock.js");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

const settle = () => new Promise((r) => setTimeout(r, 0));
const realNow = Date.now;

beforeEach(() => {
  cleanup();
  serverClock.reset();
  // The drifted panel. Restored in afterEach — a leaked clock would make every
  // file that runs after this one behave differently depending on the order.
  Date.now = () => DRIFTED;
});
afterEach(async () => {
  Date.now = realNow;
  cleanup();
  await settle();
});
after(async () => {
  Date.now = realNow;
  await settle();
  teardown();
});

function push(channel: string, payload: unknown): void {
  for (const fn of sseHandlers.get(channel) ?? []) fn({ data: JSON.stringify(payload) });
}

/**
 * Deliver the two `pco:live` frames a real display gets: the hello burst, then
 * the keepalive. One is not a reading — see SERVER_CLOCK_MIN_SPREAD_MS.
 */
async function tellItTheTime(): Promise<void> {
  await act(async () => {
    push("pco:live", { mode: "none", serverNow: SERVER_NOW });
    await settle();
  });
  await new Promise((r) => setTimeout(r, SERVER_CLOCK_MIN_SPREAD_MS + 80));
  await act(async () => {
    push("pco:live", {
      mode: "none",
      serverNow: new Date(Date.parse(SERVER_NOW) + SERVER_CLOCK_MIN_SPREAD_MS).toISOString(),
    });
    await settle();
  });
}

/** Every "HH:MM:SS" the document is currently drawing. */
function clocksOnScreen(): string[] {
  return [...(document.body.textContent ?? "").matchAll(/\b\d{2}:\d{2}:\d{2}\b/g)].map((m) => m[0]);
}

describe("the digits a display draws are the server's", () => {
  test("the two clocks differ, so this file proves something", () => {
    assert.notEqual(
      hourOf(Date.parse(SERVER_NOW)),
      hourOf(DRIFTED),
      "the fixture clocks agree — every assertion below would pass on a component that ignores the clock",
    );
  });

  test("THE GUARD: a clock object on a wall layout", async () => {
    await act(async () => {
      render(
        React.createElement(LayoutRenderer, {
          layout: {
            canvas: { width: 1920, height: 1080 },
            objects: [
              {
                id: "o1",
                x: 0,
                y: 0,
                w: 1920,
                h: 400,
                z: 1,
                config: { type: "clock", showSeconds: true, format: "24h", showMeridiem: false },
              },
            ],
          },
          viewId: "view-1",
        } as never),
      );
      await settle();
    });
    await tellItTheTime();

    const shown = clocksOnScreen();
    assert.ok(shown.length > 0, "the clock object drew no time at all");
    assert.equal(
      shown[0].slice(0, 2),
      hourOf(Date.parse(SERVER_NOW)),
      `the wall clock drew ${shown[0]}, which is this browser's clock (${hourOf(DRIFTED)}:xx) and not the server's`,
    );
  });

  test("THE GUARD: the clock on the context bar", async () => {
    // The bar lives inside the operator shell's providers. Wrapped rather than
    // stubbed: the point of this file is to drive the real thing.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    await act(async () => {
      render(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(ContextBar, { active: null } as never),
        ),
      );
      await settle();
    });
    await tellItTheTime();

    const shown = clocksOnScreen();
    assert.ok(shown.length > 0, "the context bar drew no time at all");
    assert.equal(
      shown[0].slice(0, 2),
      hourOf(Date.parse(SERVER_NOW)),
      `the bar drew ${shown[0]}, which is this browser's clock (${hourOf(DRIFTED)}:xx) and not the server's`,
    );
  });
});

// A wall widget whose status has not answered yet says nothing about it.
//
// Every status hook starts at `null`, and `null` is ALSO the settled answer for
// "nothing connected". The wall widgets read the value alone, so a display that
// had just loaded told the room its recorder was OFFLINE, its stream was
// OFFLINE, no teams were followed and every screen was dark — for as long as the
// first read took, which on the measured Slow-4G profile is most of a second.
//
// Each case below renders the REAL LayoutRenderer, so the hook, useLayoutData,
// the ctx literal and the widget are all on the path: a `known` flag that is
// never threaded, or threaded from the wrong hook, fails here and not only in
// production. Two halves per case:
//
//  - reads in flight: the widget's quiet state, and none of its negative words;
//  - reads answered "nothing connected": the negative words ARE drawn.
//
// The second half is what stops this passing on a widget that simply lost its
// offline state. A negative claim that is TRUE still has to be made.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom } from "../test-dom.js";

const BOX_PX = 240;
const teardown = installRenderDom({ clientHeight: BOX_PX });
// The Readout sizes itself from its own box, which jsdom leaves at 0 — so every
// value would render at 0px and be dropped. Same patch quiet-states.test.ts makes.
for (const [prop, px] of [["offsetHeight", BOX_PX], ["offsetWidth", 520]] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, { get: () => px, configurable: true });
}

const STATE = {
  hourCycle: "24h",
  timezone: null,
  barItems: [],
  barMobileItems: [],
  views: [],
  outputs: [{ id: "out-1", name: "Left Display", viewId: null }],
  devices: [],
  pcoConfigured: false,
};

/** What each status read answers once released: the settled "nothing is
 *  connected" — the answer the widget's negative words are TRUE for. */
const ANSWERS: Record<string, unknown> = {
  "/api/obs/status": { connected: false, recording: false, streaming: false, virtualCam: false },
  "/api/reaper/status": { connected: false, recording: false },
  "/api/resi/status": { connected: false, live: false, startedAt: null },
  "/api/youtube/status": { connected: false, live: false, startedAt: null, viewers: null, scheduledStartAt: null },
  "/api/scores/status": null,
  "/api/integrations": {
    descriptors: [{ id: "obs", label: "OBS" }],
    states: [{ id: "obs", enabled: true, configured: true, connection: "disconnected" }],
  },
  "/api/baptism": null,
  "/api/displays/presence": { connected: [], rev: 1 },
  "/api/propresenter/status": { connected: false },
  "/api/pco/live": null,
};

/** Every read but the stage state waits here until a test releases it. */
const held = new Map<string, () => void>();
/** Per-path answers a single test overrides; cleared between tests. */
let overrides: Record<string, unknown> = {};

(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
  const path = String(url).split("?")[0];
  if (path === "/api/state") {
    return { ok: true, status: 200, json: async () => STATE, text: async () => JSON.stringify(STATE) };
  }
  await new Promise<void>((resolve) => {
    const prev = held.get(path);
    held.set(path, () => { prev?.(); resolve(); });
  });
  const body = path in overrides ? overrides[path] : (ANSWERS[path] ?? null);
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act } = await import("react");
const { TooltipProvider } = await import("../components/ui/tooltip-provider.js");
const { LayoutRenderer } = await import("./layout-renderer.js");
const { StageDisplayView } = await import("./stage-display-view.js");
const { DashboardView } = await import("./dashboard-view.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
/** A fetch, its json() and the hook's then() are three turns apart. */
const drain = async () => { for (let i = 0; i < 5; i++) await settle(); };

function release(...paths: string[]): void {
  for (const [path, go] of [...held]) {
    if (paths.length && !paths.includes(path)) continue;
    held.delete(path);
    go();
  }
}

beforeEach(() => { overrides = {}; });
afterEach(async () => {
  release();
  cleanup();
  await drain();
});
after(async () => { await drain(); teardown(); });

async function draw(element: React.ReactElement): Promise<HTMLElement> {
  let container!: HTMLElement;
  await act(async () => {
    container = render(React.createElement(TooltipProvider as never, null, element)).container;
    await drain();
  });
  return container;
}

/** One widget on a wall of its own, through the real renderer. */
function wall(config: Record<string, unknown>): Promise<HTMLElement> {
  return draw(
    React.createElement(LayoutRenderer, {
      layout: {
        canvas: { width: 1920, height: 1080 },
        objects: [{ id: "o1", x: 0, y: 0, w: 1920, h: 400, z: 1, config }],
      },
      viewId: "view-1",
    } as never),
  );
}

async function answer(...paths: string[]): Promise<void> {
  await act(async () => {
    release(...paths);
    await drain();
  });
}

const text = (el: HTMLElement) => el.textContent ?? "";

/**
 * The shape every text widget below shares: quiet while unknown, the claim once
 * it is known to be true.
 */
async function quietThenClaims(config: Record<string, unknown>, claim: RegExp, quiet = /—/): Promise<void> {
  const el = await wall(config);
  assert.ok(held.size > 0, `${String(config.type)}: no read was held — the fixture is not exercising the unknown window`);
  assert.doesNotMatch(
    text(el),
    claim,
    `${String(config.type)} claimed ${claim} before any read had answered: "${text(el)}"`,
  );
  assert.match(text(el), quiet, `${String(config.type)} drew no quiet placeholder while unknown: "${text(el)}"`);

  await answer();
  assert.match(
    text(el),
    claim,
    `${String(config.type)} never made its claim once the reads said it was true: "${text(el)}"`,
  );
}

describe("a wall widget with no answer yet makes no negative claim", () => {
  test("record-status (any recorder)", async () => {
    await quietThenClaims({ type: "record-status", source: "any" }, /NO RECORDER/i);
  });

  test("obs-status", async () => {
    await quietThenClaims({ type: "obs-status" }, /Offline/i);
  });

  test("reaper-status", async () => {
    await quietThenClaims({ type: "reaper-status" }, /Offline/i);
  });

  test("stream-status (every platform)", async () => {
    await quietThenClaims({ type: "stream-status", platform: "any" }, /Offline|Off air/i);
  });

  test("home-streaming drawn as its wall twin", async () => {
    // Off Home the streaming card is the stream-status widget — same function,
    // separate registry type, so it gets its own line here.
    await quietThenClaims({ type: "home-streaming" }, /Offline|Off air/i);
  });

  test("scores", async () => {
    await quietThenClaims({ type: "scores" }, /No teams followed/i);
  });

  test("integration-status", async () => {
    await quietThenClaims({ type: "integration-status", integrationId: "obs", label: "OBS" }, /Offline/i);
  });

  test("baptism-timer (live)", async () => {
    // "0:00 / ready" over a baptism that is running is the same lie in the
    // other direction: nothing is happening, said before anything was asked.
    await quietThenClaims({ type: "baptism-timer", field: "live" }, /ready|0:00/i);
  });

  test("baptism-timer (count)", async () => {
    await quietThenClaims({ type: "baptism-timer", field: "count" }, /\b0\b/);
  });

  test("screen-embed's status dot", async () => {
    const el = await wall({ type: "screen-embed", outputId: "out-1", showLabel: true, showStatus: true });
    const label = () =>
      el.querySelector("[aria-label='Not connected'], [aria-label='Connected']")?.getAttribute("aria-label") ?? null;
    assert.match(text(el), /Left Display/, "the tile did not draw its label bar — the dot has nowhere to be");
    assert.equal(label(), null, "the dot claimed a connection state before presence had answered");

    await answer();
    assert.equal(label(), "Not connected", "the dot never said so once presence answered with nothing");
  });
});

describe("a widget watching more than one source waits for all of them", () => {
  test("record-status (any) says nothing while one recorder is still unknown", async () => {
    // OBS alone answering "not connected" is not "no recorder": REAPER might be
    // rolling. The card on Home makes the same rule.
    const el = await wall({ type: "record-status", source: "any" });
    await answer("/api/obs/status");
    assert.ok(held.has("/api/reaper/status"), "REAPER's read was not held — the fixture proves nothing");
    assert.doesNotMatch(text(el), /NO RECORDER|STANDBY/i, `claimed on OBS's answer alone: "${text(el)}"`);
  });

  test("record-status (any) says RECORDING as soon as one recorder is", async () => {
    // A true positive does not wait for the other source: whatever REAPER says,
    // something is recording.
    overrides = { "/api/obs/status": { connected: true, recording: true, streaming: false, virtualCam: false } };
    const el = await wall({ type: "record-status", source: "any" });
    await answer("/api/obs/status");
    assert.ok(held.has("/api/reaper/status"), "REAPER's read was not held — the fixture proves nothing");
    assert.match(text(el), /RECORDING/i, `a recorder that IS recording waited on the other: "${text(el)}"`);
  });

  test("stream-status (any) says nothing while one platform is still unknown", async () => {
    const el = await wall({ type: "stream-status", platform: "any" });
    await answer("/api/resi/status", "/api/youtube/status");
    assert.ok(held.has("/api/obs/status"), "OBS's read was not held — the fixture proves nothing");
    assert.doesNotMatch(text(el), /Offline|Off air/i, `claimed on two of three platforms: "${text(el)}"`);
  });
});

describe("the stage and dashboard displays make no negative claim before they know", () => {
  // Not layout objects: two of the per-display kinds, each drawing its own
  // fixed page. The same two channels, the same `null`, the same lie.
  const claims = [
    ["ProPresenter", "/api/propresenter/status", /ProPresenter offline/],
    ["the live service", "/api/pco/live", /No live service/],
  ] as const;
  for (const [name, View] of [["stage display", StageDisplayView], ["dashboard", DashboardView]] as const) {
    for (const [what, path, claim] of claims) {
      test(`${name}: ${what}`, async () => {
        const el = await draw(React.createElement(View, { displayId: "out-1" }));
        assert.ok(held.has(path), `${path} was not held — the fixture proves nothing`);
        assert.doesNotMatch(text(el), claim, `${name} claimed ${claim} before ${what} had answered`);

        await answer();
        assert.match(text(el), claim, `${name} never claimed ${claim} once ${what} answered that it was true`);
      });
    }
  }
});

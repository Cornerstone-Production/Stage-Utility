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
//  - ITS OWN reads answered "nothing connected": the negative words ARE drawn.
//
// The second half is what stops this passing on a widget that simply lost its
// offline state. A negative claim that is TRUE still has to be made. Only the
// widget's own reads are released, every other one still held, so a flag
// threaded off a neighbouring hook leaves the widget quiet and fails here.

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

/** An EventSource that keeps its listeners, so a test can push a frame down it.
 *  Installed before anything imports api.ts, which opens one per module. */
type Frame = (e: { data: string }) => void;
const listeners = new Map<string, Set<Frame>>();
(globalThis as unknown as { EventSource: unknown }).EventSource = class {
  static readonly CONNECTING = 0;
  readyState = 0;
  onmessage: unknown = null;
  onerror: unknown = null;
  onopen: unknown = null;
  addEventListener(channel: string, cb: Frame): void {
    let set = listeners.get(channel);
    if (!set) listeners.set(channel, (set = new Set()));
    set.add(cb);
  }
  removeEventListener(channel: string, cb: Frame): void {
    listeners.get(channel)?.delete(cb);
  }
  close(): void {}
};
function push(channel: string, payload: unknown): void {
  const data = JSON.stringify(payload);
  for (const cb of [...(listeners.get(channel) ?? [])]) cb({ data });
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
  "/api/cues/manifest": { version: 1, switches: [], buttons: [] },
  // What the server answers for an unconfigured Planning Center: an EMPTY
  // rundown, never null.
  "/api/pco/plan-items": { planId: null, items: [], noteCategories: [] },
};

/** Every read but the stage state waits here, oldest first, until a test
 *  releases it. */
const held = new Map<string, (() => void)[]>();
/** Per-path answers a single test overrides; cleared between tests. */
let overrides: Record<string, unknown> = {};
/** Paths a single test answers with a 502, as the server does when its own
 *  read of the integration fails; cleared between tests. */
let failing = new Set<string>();

(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
  const path = String(url).split("?")[0];
  if (path === "/api/state") {
    return { ok: true, status: 200, json: async () => STATE, text: async () => JSON.stringify(STATE) };
  }
  // Decided when the request is made, as a server would: a read released late
  // still carries the answer for the moment it asked.
  const fails = failing.has(path);
  const body = path in overrides ? overrides[path] : (ANSWERS[path] ?? null);
  await new Promise<void>((resolve) => {
    held.set(path, [...(held.get(path) ?? []), resolve]);
  });
  if (fails) {
    const err = { error: "upstream read failed" };
    return { ok: false, status: 502, statusText: "Bad Gateway", json: async () => err, text: async () => JSON.stringify(err) };
  }
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act } = await import("react");
const { TooltipProvider } = await import("../components/ui/tooltip-provider.js");
const { LayoutRenderer } = await import("./layout-renderer.js");
const { StageDisplayView } = await import("./stage-display-view.js");
const { DashboardView } = await import("./dashboard-view.js");
const { SplRundownView } = await import("./spl-rundown-view.js");
const { ObsLiveLabel, ReaperLiveLabel } = await import("../editor/inspector.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
/** A fetch, its json() and the hook's then() are three turns apart. */
const drain = async () => { for (let i = 0; i < 5; i++) await settle(); };

function release(...paths: string[]): void {
  for (const [path, waiting] of [...held]) {
    if (paths.length && !paths.includes(path)) continue;
    held.delete(path);
    for (const go of waiting) go();
  }
}

beforeEach(() => { overrides = {}; failing = new Set(); });
afterEach(async () => {
  release();
  cleanup();
  await drain();
  // A pushed stage state is cached for the next subscriber; the next test's
  // renderer must not start on this one's plan.
  resetReplayCache();
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

const OBS = "/api/obs/status";
const PLAN = "/api/pco/plan-items";
const REAPER = "/api/reaper/status";
const RESI = "/api/resi/status";
const YOUTUBE = "/api/youtube/status";

/**
 * The shape every text widget below shares: quiet while unknown, the claim once
 * the reads it watches — `own`, and only those — say it is true.
 */
async function quietThenClaims(config: Record<string, unknown>, claim: RegExp, own: string[]): Promise<void> {
  const el = await wall(config);
  for (const path of own) {
    assert.ok(held.has(path), `${String(config.type)}: ${path} was not held — the fixture is not exercising the unknown window`);
  }
  assert.doesNotMatch(
    text(el),
    claim,
    `${String(config.type)} claimed ${claim} before any read had answered: "${text(el)}"`,
  );
  assert.match(text(el), /—/, `${String(config.type)} drew no quiet placeholder while unknown: "${text(el)}"`);

  await answer(...own);
  assert.match(
    text(el),
    claim,
    `${String(config.type)} never made its claim once ${own.join(" + ")} said it was true: "${text(el)}"`,
  );
}

describe("a wall widget with no answer yet makes no negative claim", () => {
  test("record-status (any recorder)", async () => {
    await quietThenClaims({ type: "record-status", source: "any" }, /NO RECORDER/i, [OBS, REAPER]);
  });

  test("obs-status", async () => {
    await quietThenClaims({ type: "obs-status" }, /Offline/i, [OBS]);
  });

  test("reaper-status", async () => {
    await quietThenClaims({ type: "reaper-status" }, /Offline/i, [REAPER]);
  });

  test("stream-status (every platform)", async () => {
    await quietThenClaims({ type: "stream-status", platform: "any" }, /Offline|Off air/i, [RESI, YOUTUBE, OBS]);
  });

  test("stream-status (Resi)", async () => {
    await quietThenClaims({ type: "stream-status", platform: "resi" }, /Offline/i, [RESI]);
  });

  test("stream-status (YouTube)", async () => {
    await quietThenClaims({ type: "stream-status", platform: "youtube" }, /Offline/i, [YOUTUBE]);
  });

  test("home-streaming drawn as its wall twin", async () => {
    // Off Home the streaming card is the stream-status widget — same function,
    // separate registry type, so it gets its own line here.
    await quietThenClaims({ type: "home-streaming" }, /Offline|Off air/i, [RESI, YOUTUBE, OBS]);
  });

  test("scores", async () => {
    await quietThenClaims({ type: "scores" }, /No teams followed/i, ["/api/scores/status"]);
  });

  test("integration-status", async () => {
    await quietThenClaims({ type: "integration-status", integrationId: "obs", label: "OBS" }, /Offline/i, ["/api/integrations"]);
  });

  test("baptism-timer (live)", async () => {
    // "0:00 / ready" over a baptism that is running is the same lie in the
    // other direction: nothing is happening, said before anything was asked.
    await quietThenClaims({ type: "baptism-timer", field: "live" }, /ready|0:00/i, ["/api/baptism"]);
  });

  test("baptism-timer (count)", async () => {
    await quietThenClaims({ type: "baptism-timer", field: "count" }, /\b0\b/, ["/api/baptism"]);
  });

  test("cue-button", async () => {
    // No label of its own, so the name comes off the manifest; before the
    // manifest has answered there is nothing to call it but the dash.
    await quietThenClaims({ type: "cue-button", cue: "lights" }, /Unbound/i, ["/api/cues/manifest"]);
  });

  test("service-order: a plan known to be empty", async () => {
    await quietThenClaims({ type: "service-order" }, /No service plan/, [PLAN]);
  });

  test("service-order: a read that failed says so, not \"No service plan\"", async () => {
    failing = new Set([PLAN]);
    const el = await wall({ type: "service-order" });
    assert.doesNotMatch(text(el), /No service plan|Couldn't load/, `claimed before the read answered: "${text(el)}"`);
    await answer(PLAN);
    assert.match(text(el), /Couldn't load the plan/, `a failed read did not say so: "${text(el)}"`);
    assert.doesNotMatch(text(el), /No service plan/, "a failed read was drawn as an empty plan");
  });

  test("screen-embed's status dot", async () => {
    const el = await wall({ type: "screen-embed", outputId: "out-1", showLabel: true, showStatus: true });
    const label = () =>
      el.querySelector("[aria-label='Not connected'], [aria-label='Connected']")?.getAttribute("aria-label") ?? null;
    assert.match(text(el), /Left Display/, "the tile did not draw its label bar — the dot has nowhere to be");
    assert.equal(label(), null, "the dot claimed a connection state before presence had answered");

    await answer("/api/displays/presence");
    assert.equal(label(), "Not connected", "the dot never said so once presence answered with nothing");
  });
});

describe("a widget watching more than one source waits for all of them", () => {
  test("record-status (any) says nothing while one recorder is still unknown", async () => {
    // OBS alone answering "not connected" is not "no recorder": REAPER might be
    // rolling. The card on Home makes the same rule.
    const el = await wall({ type: "record-status", source: "any" });
    await answer(OBS);
    assert.ok(held.has(REAPER), "REAPER's read was not held — the fixture proves nothing");
    assert.doesNotMatch(text(el), /NO RECORDER|STANDBY/i, `claimed on OBS's answer alone: "${text(el)}"`);
  });

  test("record-status (any) says RECORDING as soon as one recorder is", async () => {
    // A true positive does not wait for the other source: whatever REAPER says,
    // something is recording.
    overrides = { [OBS]: { connected: true, recording: true, streaming: false, virtualCam: false } };
    const el = await wall({ type: "record-status", source: "any" });
    await answer(OBS);
    assert.ok(held.has(REAPER), "REAPER's read was not held — the fixture proves nothing");
    assert.match(text(el), /RECORDING/i, `a recorder that IS recording waited on the other: "${text(el)}"`);
  });

  test("stream-status (any) says nothing while one platform is still unknown", async () => {
    const el = await wall({ type: "stream-status", platform: "any" });
    await answer(RESI, YOUTUBE);
    assert.ok(held.has(OBS), "OBS's read was not held — the fixture proves nothing");
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

        await answer(path);
        assert.match(text(el), claim, `${name} never claimed ${claim} once ${what} answered that it was true`);
      });
    }
  }
});

describe("the SPL rundown display says why it has no items, and only once it knows", () => {
  test("Planning Center not configured: said after the read, not before", async () => {
    const el = await draw(React.createElement(SplRundownView, { displayId: "out-1" }));
    assert.ok(held.has(PLAN), "the rundown read was not held — the fixture proves nothing");
    assert.doesNotMatch(text(el), /not configured|No items/, `claimed before the rundown answered: "${text(el)}"`);
    await answer(PLAN);
    // STATE.pcoConfigured is false, and the server answered with its empty rundown.
    assert.match(text(el), /Planning Center not configured/);
  });

  test("a failed read says so, rather than calling Planning Center unconfigured", async () => {
    failing = new Set([PLAN]);
    const el = await draw(React.createElement(SplRundownView, { displayId: "out-1" }));
    await answer(PLAN);
    assert.match(text(el), /Couldn't load the plan/, `a failed read did not say so: "${text(el)}"`);
    assert.doesNotMatch(text(el), /not configured/, "a failed read was drawn as an unconfigured Planning Center");
  });
});

describe("the editor inspector's live line makes no claim before its recorder answers", () => {
  for (const [name, el, path] of [
    ["OBS", () => React.createElement(ObsLiveLabel, { mode: "recording" }), OBS],
    ["REAPER", () => React.createElement(ReaperLiveLabel), REAPER],
  ] as const) {
    test(name, async () => {
      const box = await draw(el());
      assert.ok(held.has(path), `${path} was not held — the fixture proves nothing`);
      assert.doesNotMatch(text(box), /Not connected/, `the ${name} row said "Not connected" before ${name} answered`);
      assert.match(text(box), /—/);
      await answer(path);
      assert.match(text(box), /Not connected/, `the ${name} row never said so once ${name} answered disconnected`);
    });
  }
});

describe("a plan change never shows the old plan's rundown as the new one's", () => {
  // The service order and the SPL rundown share usePlanItemsStatus. Holding on
  // to plan A's items across a switch to plan B drew A's rundown as B's, with no
  // sign anything was wrong — servicecue-view-plan-switch.test.tsx is the same rule
  // for ServiceCue, where it was worse than showing nothing too.
  const item = (title: string) => ({ id: title, title, itemType: "item", lengthSec: 60, sequence: 1, notesByCategory: {}, description: null });
  const onPlan = (planId: string) =>
    act(async () => {
      push("stage:state-changed", { ...STATE, planId });
      await drain();
    });

  for (const [name, mount] of [
    ["service order", () => wall({ type: "service-order" })],
    ["SPL rundown", () => draw(React.createElement(SplRundownView, { displayId: "out-1" }))],
  ] as const) {
    test(`${name}: plan B's read fails`, async () => {
      overrides = { [PLAN]: { planId: "plan-a", items: [item("Welcome (plan A)")], noteCategories: [] } };
      const el = await mount();
      await onPlan("plan-a");
      await answer(PLAN);
      assert.match(text(el), /Welcome \(plan A\)/, "fixture: plan A's rundown never drew");

      failing = new Set([PLAN]);
      await onPlan("plan-b");
      assert.ok(held.has(PLAN), "plan B's read was not held — the fixture proves nothing");
      assert.doesNotMatch(text(el), /plan A/, `plan A's rundown stayed up while plan B's read was in flight: "${text(el)}"`);
      await answer(PLAN);
      assert.doesNotMatch(text(el), /plan A/, `plan A's rundown stayed up after plan B's read failed: "${text(el)}"`);
      assert.match(text(el), /Couldn't load the plan/, `a failed read for plan B did not say so: "${text(el)}"`);
    });
  }
});

test("a slow answer for the plan just left does not overwrite the live plan's", async () => {
  const item = (title: string) => ({ id: title, title, itemType: "item", lengthSec: 60, sequence: 1, notesByCategory: {}, description: null });
  overrides = { [PLAN]: { planId: "plan-a", items: [item("Welcome (plan A)")], noteCategories: [] } };
  const el = await wall({ type: "service-order" });
  await act(async () => { push("stage:state-changed", { ...STATE, planId: "plan-a" }); await drain(); });
  overrides = { [PLAN]: { planId: "plan-b", items: [item("Welcome (plan B)")], noteCategories: [] } };
  await act(async () => { push("stage:state-changed", { ...STATE, planId: "plan-b" }); await drain(); });

  // Plan B's read answers first; plan A's, asked earlier, lands after it.
  const waiting = held.get(PLAN) ?? [];
  assert.ok(waiting.length >= 2, `expected plan A's and plan B's reads in flight, found ${waiting.length}`);
  await act(async () => { waiting.at(-1)!(); await drain(); });
  assert.match(text(el), /Welcome \(plan B\)/, `plan B's own answer did not draw: "${text(el)}"`);
  await answer(PLAN);
  assert.doesNotMatch(text(el), /plan A/, `plan A's late answer overwrote plan B's rundown: "${text(el)}"`);
});

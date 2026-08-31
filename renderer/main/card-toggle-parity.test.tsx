// A setting Home's card menu offers changes what the widget draws.
//
// The failure this exists for: `togglesFor` offered "Elapsed time", "Hide when
// idle" and "Fill the card when live" on each of the three streaming cards, a
// tick ran the same save path every other Home edit uses, the setting PERSISTED
// into the view and redrew checked — and nothing on any surface read it. Nine
// menu entries that rendered, persisted and did nothing. `HomeCard` had been
// changed to take the whole config expressly to end that class, and three of six
// home entries were wired; the comment in card-toggles.ts asserting the class was
// closed was false for the other three.
//
// So this walks TOGGLE_PAIRS — the flattened APPLIES, derived from the record the
// menu itself uses — and renders every pair with the setting on and with it off.
// If the two renders are identical everywhere the object can be drawn, the switch
// is a control that does nothing and this fails naming it.
//
// FOUR PLACES A PAIR MAY SHOW ITS DIFFERENCE, and one is enough:
//
//   surface × data = {Home, wall} × {something happening, nothing happening}
//
// Both axes are needed and neither is a hedge. `hideWhenIdle` can only show
// itself while idle; `fillWhenLive` only while live. And a streaming card is two
// presentations of one object: on Home a Stat in a row of Stats, on a wall the
// filled ALL-CAPS twin that OBS status and REAPER status are — `fillWhenLive` and
// `hideWhenIdle` are the twin's, deliberately, and Home ignores them. Demanding a
// difference on BOTH surfaces would fail on a design decision instead of a bug.
//
// WHAT IT CANNOT SEE: jsdom does no layout, so nothing here is a claim about how
// a widget looks — only that the rendered markup differs. A setting that changed
// a colour to an identical colour would pass. What it proves is the thing that
// was broken: that the value reaches the render at all.

import { strict as assert } from "node:assert";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

class StubEventSource {
  readyState = 0;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

// ── The data, in two flavours ────────────────────────────────────────────────
// "Something happening" and "nothing happening". Every widget under test reads
// one of these; which one makes its setting visible is the widget's business.

const NOW = Date.parse("2026-08-31T15:20:41.000Z");
const SINCE = new Date(NOW - 95_000).toISOString();

const OBS_LIVE: ObsStatusDTO = { connected: true, recording: true, recordPaused: false, streaming: true, virtualCam: false, recordTimecode: "00:07:12" };
const OBS_IDLE: ObsStatusDTO = { connected: true, recording: false, recordPaused: false, streaming: false, virtualCam: false, recordTimecode: null };
const REAPER_LIVE: ReaperStatusDTO = { connected: true, recording: true, recordPaused: false, playing: true, positionSeconds: 432, positionString: "0:07:12.480" };
const REAPER_IDLE: ReaperStatusDTO = { connected: true, recording: false, recordPaused: false, playing: false, positionSeconds: 0, positionString: "0:00.000" };
const STREAM_LIVE: StreamStatusDTO = { connected: true, live: true, startedAt: SINCE, detail: "Main encoder" };
const STREAM_IDLE: StreamStatusDTO = { connected: true, live: false, startedAt: null, detail: null };

const LAYER: PvpLayerDTO = {
  uuid: "layer-1",
  name: "Lower third",
  index: 0,
  state: "video",
  mediaName: "roll-in.mov",
  mediaUuid: "media-1",
  lastCueName: "Roll in",
  lastCueUuid: "cue-1",
  nextCueName: "Bumper",
  hidden: false,
  muted: false,
  opacity: 1,
  playbackRate: 1,
  anchorElapsedSec: 12,
  durationSec: 90,
};
const PVP_LIVE: PvpStatusDTO = { connected: true, layers: [LAYER], sampledAt: new Date(NOW).toISOString() };
const PVP_IDLE: PvpStatusDTO = { connected: true, layers: [], sampledAt: null };

const PRO_LIVE: ProPresenterStatusDTO = {
  connected: true,
  currentItem: null,
  nextItem: null,
  slideIndex: null,
  slideCount: null,
  slidesRemaining: null,
  currentSlideText: null,
  nextSlideText: null,
  currentNotes: null,
  nextNotes: null,
  currentSection: null,
  nextSection: null,
  nextArrangementSection: null,
  currentServiceItem: null,
  nextServiceItem: null,
  // Overrun, which is the only state `warnStates` colours.
  timers: [{ name: "Sermon", time: "-0:42", state: "overrun" }],
  slidePreviewKey: null,
};

/** A service running four minutes behind, so `service-pacing` has a drift to
 *  report and its two display modes cannot come out the same. */
const TIMELINE: ServiceTimeline = {
  serviceKey: "st-1:plan-1:2026-08-31",
  serviceTypeId: "st-1",
  planId: "plan-1",
  planTitle: "Sample plan",
  seriesTitle: null,
  serviceDate: "2026-08-31",
  serviceTimeId: null,
  serviceTimeStartsAt: null,
  startedAt: new Date(NOW - 900_000).toISOString(),
  endedAt: null,
  items: [
    { itemId: "i1", title: "Opener", sequence: 1, plannedLengthSec: 300, startedAt: new Date(NOW - 900_000).toISOString(), endedAt: new Date(NOW - 600_000).toISOString(), actualDurationSec: 300 },
    { itemId: "i2", title: "Message", sequence: 2, plannedLengthSec: 360, startedAt: new Date(NOW - 600_000).toISOString(), endedAt: null, actualDurationSec: null },
  ],
};

/** What the hooks a HOME card opens for itself are answered with. Home cards
 *  subscribe on their own — StreamingCard reaches for Resi, YouTube and OBS, the
 *  PVP cards for PVP — so a ctx fixture alone leaves them looking at nothing. */
let happening = true;
(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  const url = String(input);
  const pick = <T,>(live: T, idle: T): T => (happening ? live : idle);
  const body =
    url.includes("/api/obs/status") ? pick(OBS_LIVE, OBS_IDLE)
    : url.includes("/api/reaper/status") ? pick(REAPER_LIVE, REAPER_IDLE)
    : url.includes("/api/resi/status") || url.includes("/api/youtube/status") ? pick(STREAM_LIVE, STREAM_IDLE)
    : url.includes("/api/pvp/status") ? pick(PVP_LIVE, PVP_IDLE)
    : {};
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");
const { LAYOUT_OBJECTS } = await import("./layout-objects.js");
const { TOGGLE_PAIRS } = await import("../app/home/card-toggles.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
before(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
after(async () => { await settle(); teardown(); });
beforeEach(() => cleanup());
afterEach(async () => { cleanup(); await settle(); });

function ctxFor(home: boolean, live: boolean) {
  return makeRenderCtx({
    home,
    interactive: home,
    now: NOW,
    obs: live ? OBS_LIVE : OBS_IDLE,
    reaper: live ? REAPER_LIVE : REAPER_IDLE,
    resi: live ? STREAM_LIVE : STREAM_IDLE,
    youtube: live ? STREAM_LIVE : STREAM_IDLE,
    pvp: live ? PVP_LIVE : PVP_IDLE,
    propresenter: live ? PRO_LIVE : null,
    serviceTimeline: live ? TIMELINE : null,
  });
}

/**
 * The two values a setting is flipped between.
 *
 * `format` is the one that is not a boolean — it stores the hour cycle itself.
 * Any other non-boolean setting added to the menu lands here as `[true, false]`
 * and fails to differ, which is the right way round: it says so rather than
 * quietly testing nothing.
 */
const VALUES: Record<string, [unknown, unknown]> = { format: ["24h", "12h"] };
const valuesFor = (key: string) => VALUES[key] ?? [true, false];

/** One render of one object, as markup. */
async function draw(type: string, key: string, value: unknown, home: boolean, live: boolean): Promise<string> {
  happening = live;
  const base = LAYOUT_OBJECTS[type as keyof typeof LAYOUT_OBJECTS].config() as Record<string, unknown>;
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(
      React.createElement(ObjectContent, {
        o: { id: "o1", x: 0, y: 0, w: 6, h: 4, z: 1, config: { ...base, [key]: value }, style: {} },
        ctx: ctxFor(home, live),
      } as never),
    ));
    await settle();
  });
  const html = container.innerHTML;
  cleanup();
  return html;
}

describe("every setting Home's card menu offers changes what the widget draws", () => {
  test("the pair list is the menu's own, and it is not empty", () => {
    // The anchor. Everything below walks TOGGLE_PAIRS, so a TOGGLE_PAIRS that
    // came back empty would pass the whole file on nothing.
    assert.ok(TOGGLE_PAIRS.length > 0, "TOGGLE_PAIRS is empty — the guard below would check nothing");
    for (const { type } of TOGGLE_PAIRS) {
      assert.ok(type in LAYOUT_OBJECTS, `the menu offers a setting on "${type}", which is not an object type`);
    }
  });

  for (const { type, key } of TOGGLE_PAIRS) {
    test(`${type} reads ${key}`, async () => {
      const [on, off] = valuesFor(key);
      const tried: string[] = [];
      for (const home of [false, true]) {
        for (const live of [true, false]) {
          const a = await draw(type, key, on, home, live);
          const b = await draw(type, key, off, home, live);
          if (a !== b) return;
          tried.push(`${home ? "Home" : "wall"}/${live ? "live" : "idle"}`);
        }
      }
      assert.fail(
        `${key} on a ${type} draws exactly the same thing whether it is on or off, on all four of ` +
          `${tried.join(", ")} — the menu writes it into the object and persists it, and nothing reads it`,
      );
    });
  }
});

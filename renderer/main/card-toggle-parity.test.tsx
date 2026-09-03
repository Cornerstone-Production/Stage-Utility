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

/** Two followed games with different teams and different scores, so "any
 *  followed team" (which takes the first) and a pin to the SECOND cannot draw
 *  the same thing. Invented teams and ids — this is a public repo. */
const team = (id: string, name: string, score: number): ScoreTeamDTO => ({
  id,
  abbreviation: name.slice(0, 3).toUpperCase(),
  name,
  displayName: `City of ${name}`,
  color: null,
  logo: null,
  record: null,
  score,
});
const game = (eventId: string, away: ScoreTeamDTO, home: ScoreTeamDTO, state: ScoreState): ScoreGameDTO => ({
  eventId,
  league: "mlb" as LeagueId,
  sport: "baseball" as SportKind,
  state,
  delayed: false,
  detail: state === "in" ? "Top 3rd" : "Final",
  shortDetail: state === "in" ? "Top 3rd" : "Final",
  clock: "",
  startsAt: new Date(NOW - 3_600_000).toISOString(),
  venue: null,
  away,
  home,
  situation: null,
});
const GAME_A = game("evt-a", team("t-100", "Anvils", 3), team("t-101", "Beacons", 1), "in");
const GAME_B = game("evt-b", team("t-200", "Cyphers", 7), team("t-201", "Drifters", 5), "in");
const SCORES_LIVE: ScoresStatusDTO = {
  connected: true,
  games: [GAME_A, GAME_B],
  scoreRev: 1,
  lastEvents: [],
  fetchedAt: new Date(NOW).toISOString(),
  error: null,
};
/** Connected with nothing on today — both choices draw the same empty card, which
 *  is why the guard only needs ONE of its four cells to differ. */
const SCORES_IDLE: ScoresStatusDTO = { ...SCORES_LIVE, games: [], scoreRev: 0, fetchedAt: null };

/**
 * Three weekends of history, so `home-recent-services` has a chart to draw at all
 * (it renders nothing below two points) and the SPL line has something to differ
 * about — the levels are far apart so a metric swap cannot come out the same.
 */
const WEEKENDS = ["2026-08-16", "2026-08-23", "2026-08-30"];
const attendance = (day: string, peak: number): ServiceAttendance => ({
  serviceKey: `st-1:plan-${day}:${day}`,
  serviceTypeId: "st-1",
  serviceTypeName: "Weekend",
  planId: `plan-${day}`,
  planTitle: "Sample plan",
  seriesTitle: null,
  serviceDate: day,
  serviceTimeId: null,
  serviceTimeStartsAt: `${day}T15:00:00.000Z`,
  startedAt: `${day}T15:00:00.000Z`,
  endedAt: `${day}T16:30:00.000Z`,
  samples: [],
  attendanceBaseline: 0,
  totalAttendance: peak,
  peakAttendance: peak,
  peakOccupancy: peak,
  minOccupancy: 0,
  lastAttendance: peak,
  lastOccupancy: peak,
});
const ATTENDANCE: ServiceAttendance[] = [
  attendance(WEEKENDS[0], 210),
  attendance(WEEKENDS[1], 245),
  attendance(WEEKENDS[2], 232),
];
/** Two metrics, far apart, so "which metric" changes the drawing. */
const SPL_SUMMARY: SplServiceSummary[] = WEEKENDS.map((day, i) => ({
  serviceKey: `st-1:plan-${day}:${day}`,
  serviceTypeId: "st-1",
  serviceTypeName: "Weekend",
  serviceDate: day,
  endedAt: `${day}T16:30:00.000Z`,
  metrics: {
    "LAeq 10": { leq: 88 + i * 2, count: 1000 },
    "SPL C Fast": { leq: 101 - i * 3, count: 1000 },
  },
}));

/** Two calibrated meters at DIFFERENT levels, so "loudest" and a pinned quiet
 *  channel cannot come out the same number. Balcony is the quiet one. */
const SPL_LIVE: SplMetricsDTO = {
  connected: true,
  apiVersion: "4",
  meters: {
    "Console::Main": { deviceName: "Console", channelName: "Main", metrics: { "SPL A Slow": 92.4 }, ts: SINCE },
    "Console::Balcony": { deviceName: "Console", channelName: "Balcony", metrics: { "SPL A Slow": 78.1 }, ts: SINCE },
  },
};
/** Connected, reporting nothing — the loudest-meter path says "no readings yet"
 *  and a pinned meter says that meter is not reporting, which still differ. */
const SPL_IDLE: SplMetricsDTO = { connected: true, apiVersion: "4", meters: {} };

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
    : url.includes("/api/spl/metrics") ? pick(SPL_LIVE, SPL_IDLE)
    : url.includes("/api/scores/status") ? pick(SCORES_LIVE, SCORES_IDLE)
    : url.includes("/api/attendance/history") ? ATTENDANCE
    : url.includes("/api/spl/summary") ? SPL_SUMMARY
    : url.includes("/api/service-timeline") ? []
    : {};
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");
const { LAYOUT_OBJECTS } = await import("./layout-objects.js");
// A router IN CONTEXT, because one of the cards under test carries a link.
// `home-recent-services` renders "Open History" as a real <Link>, and a Link asks
// the router to build its location — with none in context it throws, and the pair
// test would fail for the harness's reasons rather than the widget's.
const { RouterContextProvider, createRootRoute, createRouter, createMemoryHistory } =
  await import("@tanstack/react-router");
const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
// Loaded before any render: an unloaded router cannot build a location.
await router.load();
const { TOGGLE_PAIRS, PICK_PAIRS } = await import("../app/home/card-toggles.js");

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
    spl: live ? SPL_LIVE : SPL_IDLE,
    // The WALL scores object reads ctx; the Home card opens its own hook. Both
    // are fed, because the guard renders each pair on both surfaces.
    scores: live ? SCORES_LIVE : SCORES_IDLE,
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

/**
 * Config a setting needs switched on before it can do anything.
 *
 * `splMetric` chooses which metric the SPL trend line plots, and there is no line
 * until `showSpl` is on. Without this the pair renders two identical cards and
 * reports a live setting as dead — the false negative that mirrors the false
 * positive above, and just as misleading.
 *
 * Deliberately narrow: a setting that needs a prerequisite is a setting the menu
 * should be hiding until then, and both of these are.
 */
const PREREQ: Record<string, Record<string, unknown>> = {
  splMetric: { showSpl: true },
};

/** One render of one object, as markup. */
async function draw(type: string, key: string, value: unknown, home: boolean, live: boolean): Promise<string> {
  happening = live;
  const base = LAYOUT_OBJECTS[type as keyof typeof LAYOUT_OBJECTS].config() as Record<string, unknown>;
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(
      React.createElement(
        RouterContextProvider as never,
        { router },
        React.createElement(ObjectContent, {
          o: {
            id: "o1", x: 0, y: 0, w: 6, h: 4, z: 1,
            config: { ...base, ...(PREREQ[key] ?? {}), [key]: value },
            style: {},
          },
          ctx: ctxFor(home, live),
        } as never),
      ),
    ));
    await settle();
  });
  // React's useId values are NOT evidence of anything. They increment per render
  // tree, so two renders of the same card carry different ids by construction —
  // and any card whose markup contains one differs from itself no matter what the
  // setting does. `home-recent-services` draws the trend chart, which mints two
  // gradient ids, so both of its pair tests passed on `_r_0_` vs `_r_2_` alone;
  // deleting the whole feature left them green. Normalised, the comparison is
  // about the widget again.
  const html = container.innerHTML.replace(/_r_[0-9a-z]+_/gi, "_id_");
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

/**
 * The two values a PICK is compared between.
 *
 * A pick is a choice from a list, not a flip, so there is no "off" to compute —
 * each key names its default and one real alternative. A pick added without an
 * entry here lands as [undefined, undefined] and fails to differ, which is the
 * right way round: it says so rather than quietly testing nothing.
 */
const PICK_VALUES: Record<string, [unknown, unknown]> = {
  meterId: ["loudest", "Console::Balcony"],
  // "auto" takes the first followed game; the pin names the second.
  game: ["auto", "mlb:t-200"],
  // Every recorder at once vs one of them. REAPER is idle in the LIVE fixture
  // while OBS is rolling, so "any" and "reaper" cannot draw the same thing.
  recorder: ["any", "reaper"],
  // Same idea: "any" answers for all three streamers, "youtube" for one.
  platform: ["any", "youtube"],
  // Two metrics whose levels are nowhere near each other, so the line moves.
  splMetric: ["LAeq 10", "SPL C Fast"],
};

describe("every CHOICE Home's card menu offers changes what the widget draws", () => {
  // The picks were outside this file entirely. TOGGLE_PAIRS is derived from
  // APPLIES, and PICKS is a separate record — so "Game" had shipped unguarded
  // against exactly the failure the toggles above exist to catch, and a new pick
  // would have inherited that hole.
  test("the pick list is the menu's own, and it is not empty", () => {
    assert.ok(PICK_PAIRS.length > 0, "PICK_PAIRS is empty — the guard below would check nothing");
    for (const { type } of PICK_PAIRS) {
      assert.ok(type in LAYOUT_OBJECTS, `the menu offers a choice on "${type}", which is not an object type`);
    }
  });

  for (const { type, key } of PICK_PAIRS) {
    test(`${type} reads ${key}`, async () => {
      const [on, off] = PICK_VALUES[key] ?? [undefined, undefined];
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
        `${key} on a ${type} draws exactly the same thing whichever of ${JSON.stringify(on)} / ` +
          `${JSON.stringify(off)} it holds, on all four of ${tried.join(", ")} — the menu writes it ` +
          `into the object and persists it, and nothing reads it`,
      );
    });
  }
});

describe("a pick that both surfaces read is read on BOTH", () => {
  // The four-cell rule above is right in general: a setting may legitimately
  // belong to one surface, and demanding a difference on both would fail on a
  // design decision instead of a bug.
  //
  // `platform` is not one of those. It decides which platform the HOME card
  // filters to and names itself after, AND which twin the wall draws — and the
  // two read it through different code (`STREAMER_FOR` at the card, the wall-twin
  // lookup at the renderer). So a Home card that ignored the setting completely
  // still differs on the wall, and the pair test above passes on the wall cell
  // alone. Caught exactly that way: hardcoding the card to "any" left it green.
  test("home-streaming reads platform on Home, not only on its wall twin", async () => {
    const any = await draw("home-streaming", "platform", "any", true, true);
    const one = await draw("home-streaming", "platform", "youtube", true, true);
    assert.notEqual(any, one,
      "the Home card draws the same thing for every platform and for one — it is ignoring the setting " +
        "and only its wall twin reads it");
  });
});

describe("a retired per-source card draws exactly what its replacement draws", () => {
  // The whole promise of the retirement: the four cards left the palette, and
  // NOTHING about what they draw changed. Each was the general card with one prop
  // fixed, so the general card carrying the equivalent choice has to be
  // indistinguishable from it — same markup, on both surfaces, live and idle.
  //
  // Anything less and an operator with one of these already on a page sees their
  // page change under them, which is the one outcome the retirement was supposed
  // to avoid. A saved card is not migrated, so both code paths stay live and both
  // have to agree.
  //
  // WHAT IT CANNOT SEE: the two arms hand the SAME component different props, so a
  // change inside that component moves both sides together and this stays green.
  // Found the honest way — relabelling `RecordingCard` to prove this red did
  // nothing, because it relabelled the retired card too. What it pins is that the
  // two DISPATCHES agree, which is where a retirement actually goes wrong; the
  // component's own drawing is the pair tests' job above.
  const PAIRS: { retired: string; replacement: string; key: string; value: string }[] = [
    { retired: "home-recording-obs", replacement: "home-recording", key: "recorder", value: "obs" },
    { retired: "home-recording-reaper", replacement: "home-recording", key: "recorder", value: "reaper" },
    { retired: "home-streaming-resi", replacement: "home-streaming", key: "platform", value: "resi" },
    { retired: "home-streaming-youtube", replacement: "home-streaming", key: "platform", value: "youtube" },
  ];

  for (const { retired, replacement, key, value } of PAIRS) {
    for (const home of [true, false]) {
      for (const live of [true, false]) {
        const where = `${home ? "Home" : "wall"}, ${live ? "live" : "idle"}`;
        test(`${retired} === ${replacement} ${key}=${value} (${where})`, async () => {
          // The retired card takes no such key — its source is in its type — so it
          // is drawn from its own default config, untouched.
          const old = await draw(retired, "__unused", undefined, home, live);
          const now = await draw(replacement, key, value, home, live);
          assert.equal(now, old,
            `${replacement} with ${key}="${value}" no longer draws what ${retired} draws on ${where} — ` +
              `retiring it changed somebody's page`);
        });
      }
    }
  }
});

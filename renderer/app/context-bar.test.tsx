import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

// The DOM must exist before the component modules are evaluated - a `before`
// hook runs after the module body, so a static import would render into nothing.
import { installDom } from "../test-dom.js";

const teardown = installDom();

const { contextBarState, renderBarItem, integrationHealth } = await import("./context-bar.js");
const { BAR_ITEMS, BAR_PROSE_ITEMS } = await import("./bar-items.js");
const { renderToStaticMarkup } = await import("react-dom/server");

after(() => {
  teardown();
});

// The timer maths itself is covered by pco-timer's own tests. What is new here
// is the bar's own decisions: when to claim a service is live, and that it does
// not invent its own formatting or ignore clock skew.
const LIVE_ITEM: PcoLiveDTO = {
  mode: "item",
  currentItemId: "i1",
  label: "Message",
  lengthSec: 1200,
  liveStartAt: "2026-08-14T14:00:00.000Z",
  targetAt: null,
  serverNow: "2026-08-14T14:05:00.000Z",
  currentItemTitle: "Message",
  nextItemTitle: "Closing",
  serviceTimeId: "st1",
  serviceTimeStartsAt: "2026-08-14T13:30:00.000Z",
} as PcoLiveDTO;

/** A followed game actually in progress. The capsule is the only bar item whose
 *  non-idle branch is a control rather than a reading, so it needs its own
 *  fixture to be walked at all. */
const LIVE_GAME = {
  eventId: "e1",
  league: "mlb",
  sport: "baseball",
  state: "in",
  delayed: false,
  detail: "Top 3rd",
  shortDetail: "Top 3rd",
  clock: "0:00",
  startsAt: "2026-08-14T18:05:00.000Z",
  venue: "Wrigley Field",
  away: {
    id: "17",
    abbreviation: "CIN",
    name: "Reds",
    displayName: "Cincinnati Reds",
    color: "#c6011f",
    logo: null,
    record: "70-64",
    score: 2,
  },
  home: {
    id: "16",
    abbreviation: "CHC",
    name: "Cubs",
    displayName: "Chicago Cubs",
    color: "#0e3386",
    logo: null,
    record: "78-56",
    score: 6,
  },
  situation: {
    kind: "baseball",
    onFirst: false,
    onSecond: true,
    onThird: false,
    balls: 1,
    strikes: 0,
    outs: 2,
  },
} as ScoreGameDTO;

describe("context bar state", () => {
  test("reports not-live when there is no live payload at all", () => {
    const s = contextBarState(null, Date.parse("2026-08-14T14:05:00.000Z"), 0);
    assert.equal(s.isLive, false);
    assert.equal(s.timerText, null);
  });

  test("reports not-live in mode none, even though a payload exists", () => {
    // A pco:live broadcast with mode "none" is the server saying the service
    // ENDED. Treating any payload as live leaves a Live pill lit all week.
    const s = contextBarState({ ...LIVE_ITEM, mode: "none" }, Date.now(), 0);
    assert.equal(s.isLive, false);
    assert.equal(s.timerText, null);
  });

  test("reports live with the current item and a formatted timer", () => {
    const s = contextBarState(LIVE_ITEM, Date.parse("2026-08-14T14:05:00.000Z"), 0);
    assert.equal(s.isLive, true);
    assert.equal(s.itemTitle, "Message");
    // 1200s planned, 300s elapsed -> 900s remaining, via fmtDuration.
    assert.equal(s.timerText, "15:00");
  });

  test("applies clock skew, so a drifted browser matches the server", () => {
    // The browser clock is 60s BEHIND the server. Without applying skew the
    // timer reads a minute long for the whole service, disagreeing with the
    // countdown on the wall.
    const browserNow = Date.parse("2026-08-14T14:04:00.000Z");
    const s = contextBarState(LIVE_ITEM, browserNow, 60_000);
    assert.equal(s.timerText, "15:00");
  });

  test("shows an overrun as negative rather than clamping it", () => {
    // PCO counts past zero when an item runs long, and so must this - an
    // operator needs to see HOW far over, not a frozen 0:00.
    const s = contextBarState(LIVE_ITEM, Date.parse("2026-08-14T14:25:00.000Z"), 0);
    assert.equal(s.isLive, true);
    assert.equal(s.isOver, true);
    assert.ok(s.timerText?.startsWith("−"), `expected a negative timer, got ${s.timerText}`);
  });

  const preservice = (targetAt: string) =>
    ({
      ...LIVE_ITEM,
      mode: "preservice",
      label: "Service starts",
      liveStartAt: null,
      targetAt,
    }) as PcoLiveDTO;

  test("counts a pre-service countdown down to the service start", () => {
    const s = contextBarState(preservice("2026-08-14T14:30:00.000Z"), Date.parse("2026-08-14T14:25:00.000Z"), 0);
    assert.equal(s.timerText, "5:00");
  });

  test("a pre-service countdown is NOT live", () => {
    // THE guard, and this test used to assert the opposite. isLive was true for
    // any timer at all, so a service two days out — which produces a perfectly
    // good countdown — lit the green LIVE badge above every page. The bar said
    // "starts in 2d 0h" and "LIVE" at the same time.
    const s = contextBarState(preservice("2026-08-14T14:30:00.000Z"), Date.parse("2026-08-14T14:25:00.000Z"), 0);
    assert.equal(s.isLive, false, "a countdown to a future service reported itself live");
  });

  test("still not live when the service is days away", () => {
    // The case actually reported. Five minutes out and two days out are the same
    // state, and neither is live.
    const s = contextBarState(preservice("2026-08-16T14:30:00.000Z"), Date.parse("2026-08-14T14:30:00.000Z"), 0);
    assert.equal(s.isLive, false);
    assert.equal(s.timerText, "2d 0h");
  });

  test("still not live once the start time has PASSED", () => {
    // The subtle one. PCO stays in preservice until an item is actually started,
    // so the countdown goes negative while nothing is running — and "we are past
    // the start time" is the moment a false LIVE is most believable and most
    // wrong, because nobody has begun anything yet.
    const s = contextBarState(preservice("2026-08-14T14:30:00.000Z"), Date.parse("2026-08-14T14:35:00.000Z"), 0);
    assert.equal(s.isLive, false, "an overdue start reported itself live");
    assert.equal(s.isOver, true);
  });

  test("a running ITEM is live", () => {
    // The other half: the badge has to still appear when it should, or this is
    // just a different bug.
    const s = contextBarState(LIVE_ITEM, Date.parse("2026-08-14T14:05:00.000Z"), 0);
    assert.equal(s.isLive, true);
  });
});

describe("nothing appears or disappears", () => {
  // Items used to return null when they had nothing to say, so the bar reflowed
  // as the state changed: integration health arrived only once something broke,
  // and between services the right-hand group was absent entirely. An operator
  // cannot learn where to look on a strip that rearranges itself.
  //
  // This walks the REAL renderer over every registered id, so an idle branch
  // deleted from any one of them fails here by name.
  //
  // THE RULE IS NOW NARROWED, NOT WEAKENED. Exactly one item — the score capsule
  // — is allowed to render nothing, because for most of the year no followed
  // team is playing and a permanent "No games" is a word that never changes on a
  // strip where every other reading means something. The exception is declared
  // on the item itself (BarItem.canBeEmpty, which carries the full reasoning),
  // read from there rather than hard-coded here, and its membership is asserted
  // EXACTLY below — so a second item cannot quietly join it, and the other eight
  // are still proven never to vanish in any of the four fixtures.
  const NOW = Date.parse("2026-08-14T14:05:00.000Z");
  const ALL = Object.keys(BAR_ITEMS) as (keyof typeof BAR_ITEMS)[];
  /** The items still bound by the rule: every one without the exception flag. */
  const MUST_RENDER = ALL.filter((id) => !BAR_ITEMS[id].canBeEmpty);

  /** The deadest state the app has: no service, no recorder, no integrations. */
  const idle = {
    state: null,
    bar: contextBarState(null, NOW, 0),
    now: NOW,
    obs: null,
    reaper: null,
    integrations: { states: [], labels: {} },
    resi: null,
    youtube: null,
    scores: null,
  };

  test("the registry is the list, and it has grown by the score capsule", () => {
    // The count is asserted EXACTLY, not as a floor: the loops below walk
    // Object.keys(BAR_ITEMS), so an item that never reached the registry is an
    // item they silently do not cover.
    assert.equal(ALL.length, 9);
    assert.ok(ALL.includes("scores"), "the score capsule is not a bar item");
    // Two items, not one compound. The operator asked to be able to put the
    // service type on the bar without the plan title.
    assert.ok(ALL.includes("service-type"), "the service type is not a bar item of its own");
    assert.ok(ALL.includes("plan"), "the plan title is not a bar item");
  });

  test("THE GUARD: exactly one item is exempt from the no-reflow rule", () => {
    // The narrowing is the whole point. Flag a second item as canBeEmpty and
    // this fails by name before its idle branch can be deleted — which is what
    // stops "scores may vanish" being read as "any item may vanish".
    assert.deepEqual(
      ALL.filter((id) => BAR_ITEMS[id].canBeEmpty),
      ["scores"],
    );
    assert.equal(MUST_RENDER.length, 8);
  });

  test("every item bound by the rule renders with no service, no recorder and no integrations", () => {
    for (const id of MUST_RENDER) {
      assert.notEqual(renderBarItem(id, idle), null, `${id} vanishes when there is nothing to report`);
    }
  });

  test("every item bound by the rule still renders mid-service", () => {
    // The other half. An item that only renders when idle is the same bug.
    const live = { ...idle, bar: contextBarState(LIVE_ITEM, NOW, 0) };
    for (const id of MUST_RENDER) {
      assert.notEqual(renderBarItem(id, live), null, `${id} vanishes during a live service`);
    }
  });

  test("every item bound by the rule renders while a recorder is connected but stopped", () => {
    // The state the bar exists to surface, and the one that reaches the
    // branches an idle-only fixture never touches.
    const rolling = {
      ...idle,
      bar: contextBarState(LIVE_ITEM, NOW, 0),
      obs: { connected: true, recording: false, recordTimecode: null },
      integrations: {
        states: [{ id: "obs", enabled: true, configured: true, connection: "disconnected" }],
        labels: { obs: "OBS" },
      },
    };
    for (const id of MUST_RENDER) {
      assert.notEqual(renderBarItem(id, rolling as never), null, `${id} vanishes with a recorder stopped`);
    }
  });

  const scoresCtx = (games: ScoreGameDTO[], over: Record<string, unknown> = {}) => ({
    ...idle,
    bar: contextBarState(LIVE_ITEM, NOW, 0),
    scores: {
      connected: true,
      games,
      scoreRev: 0,
      lastEvents: [],
      fetchedAt: "2026-08-14T14:05:00.000Z",
      error: null,
      ...over,
    },
  });

  test("EVERY item, the capsule included, renders with a followed game in play", () => {
    // The fourth state: the three fixtures above all leave `scores` null, which
    // is now the capsule's EMPTY branch. Without this the one branch that is not
    // a plain reading -- the capsule itself -- would be walked by nothing, and
    // "the capsule may be empty" would be satisfied by a capsule that is always
    // empty.
    for (const id of ALL) {
      assert.notEqual(
        renderBarItem(id, scoresCtx([LIVE_GAME]) as never),
        null,
        `${id} vanishes with a game in play`,
      );
    }
  });

  test("THE GUARD: the capsule renders NOTHING when no team is followed", () => {
    // The operator's report. This item used to print "No teams" every day of the
    // year on a strip whose other seven readings all mean something. Restore any
    // of the four idle texts and this fails.
    assert.equal(
      renderBarItem("scores", idle),
      null,
      "the score capsule still draws something with no followed team",
    );
  });

  test("THE GUARD: the capsule renders NOTHING when every followed game is Final", () => {
    // The case that made it noise rather than merely quiet: teams ARE followed,
    // the poll succeeded, and the games all finished hours ago.
    const done = { ...LIVE_GAME, state: "post" as const, shortDetail: "Final" };
    assert.equal(
      renderBarItem("scores", scoresCtx([done]) as never),
      null,
      "a finished game still draws a capsule",
    );
  });

  test("and nothing when a followed game has not started yet", () => {
    const soon = { ...LIVE_GAME, state: "pre" as const, shortDetail: "7:05 PM ET" };
    assert.equal(renderBarItem("scores", scoresCtx([soon]) as never), null);
  });

  test("and nothing when the poll itself failed", () => {
    // A failed poll with no games to keep leaves nothing to say either. The
    // failure still reaches the operator, on the Integrations card and in the
    // panel's own "Last update failed" line -- not as a permanent word up here.
    assert.equal(
      renderBarItem("scores", scoresCtx([], { connected: false, error: "timeout" }) as never),
      null,
    );
  });
});

describe("what counts as an integration being down", () => {
  // Both exclusions are things the bar used to complain about forever.
  const st = (over: Partial<IntegrationState>): IntegrationState =>
    ({ id: "x", enabled: true, configured: true, connection: "disconnected", message: null, config: {}, ...over }) as IntegrationState;

  test("a set-up integration that is disconnected is down", () => {
    const { down } = integrationHealth([st({ id: "obs" })]);
    assert.deepEqual(down.map((d) => d.id), ["obs"]);
  });

  test("one nobody set up is absent, not down", () => {
    const { setUp, down } = integrationHealth([st({ id: "resi", configured: false })]);
    assert.deepEqual(setUp, []);
    assert.deepEqual(down, []);
  });

  test("an INBOUND one is never down, however it reports itself", () => {
    // Companion's module dials us. With no Stream Deck plugged in it sits at
    // "disconnected" for weeks, and the bar was counting that as a fault.
    const { setUp, down } = integrationHealth([st({ id: "companion", inbound: true })]);
    assert.deepEqual(down, [], "an inbound integration was counted as down");
    assert.deepEqual(setUp, [], "an inbound integration was counted at all");
  });

  test("and it does not hide the ones that ARE down beside it", () => {
    const { down } = integrationHealth([st({ id: "companion", inbound: true }), st({ id: "obs" })]);
    assert.deepEqual(down.map((d) => d.id), ["obs"]);
  });
});

// ── The fit ladder, as far as it can be checked without a browser ───────────
//
// The ladder itself is CSS keyed off `data-fit`, and jsdom has no layout, so
// nothing here can say a strip fits. What it CAN say is what each rung leaves
// behind, because the rungs are expressed as classes on the markup: `bar-drop-1`
// and `bar-drop-2` are clipped out of the layout from their rung down, and
// `bar-glyph` is drawn only from level 2. Applying those rules to the rendered
// markup is the rung, minus the pixels.
//
// The pixel half — one row, no scroll, no wrap, nothing cut — was checked in a
// real browser at 320 / 390 / 640 / 1440px in both themes, over the service type
// alone, the plan alone, the two together, an upgraded bar and every item at
// once. The numbers are written down in docs/features/context-bar.md.

describe("what a rung leaves behind", () => {
  const NOW = Date.parse("2026-08-14T14:05:00.000Z");
  const ALL = Object.keys(BAR_ITEMS) as (keyof typeof BAR_ITEMS)[];
  const MUST_RENDER = ALL.filter((id) => !BAR_ITEMS[id].canBeEmpty);

  const idle = {
    state: null,
    bar: contextBarState(null, NOW, 0),
    now: NOW,
    obs: null,
    reaper: null,
    integrations: { states: [], labels: {} },
    resi: null,
    youtube: null,
    scores: null,
  };

  /** A plan loaded, so the two readings that used to be one item both have
   *  something to say. Both names are invented — this is a public repo. */
  const SERVICE_TYPE = "Weekend Service";
  const PLAN_TITLE = "Carry The Light";
  const loaded = {
    ...idle,
    state: { serviceTypeName: SERVICE_TYPE, planTitle: PLAN_TITLE } as unknown as StageState,
    bar: contextBarState(LIVE_ITEM, NOW, 0),
  };

  /**
   * What an item still SHOWS at a given rung.
   *
   * Words clipped by a rung are removed, glyphs are added at level 2 — which is
   * exactly what the CSS does — and what comes back is the visible reading:
   * its text, plus a marker for each mark still drawn.
   */
  function visibleAt(level: number, node: unknown): string {
    const box = document.createElement("div");
    box.innerHTML = renderToStaticMarkup(node as never);
    if (level >= 1) box.querySelectorAll(".bar-drop-1").forEach((n) => n.remove());
    if (level >= 2) box.querySelectorAll(".bar-drop-2").forEach((n) => n.remove());
    // Below level 2 the marks are `display: none`, so they are not a reading yet.
    if (level < 2) box.querySelectorAll(".bar-glyph").forEach((n) => n.remove());
    const marks = box.querySelectorAll("svg").length;
    // The screen-reader-only state word is not something anybody can see.
    box.querySelectorAll(".sr-only").forEach((n) => n.remove());
    // The marker must carry NO DIGITS: the digit guard below counts what is left,
    // and a "[1 mark]" suffix would read as a number the rung had added.
    return (box.textContent ?? "").replace(/\s+/g, " ").trim() + " [mark]".repeat(marks);
  }

  test("THE GUARD: no rung can leave an item showing nothing", () => {
    // The failure this exists for: giving an idle word `bar-drop-2` and
    // forgetting the mark that stands in for it. The item does not vanish — it
    // renders, so the no-reflow guards above stay green — it just becomes a
    // zero-width box that still charges the strip a gap. A hole exactly where a
    // reading used to be, at the only width anybody would have noticed.
    for (const id of MUST_RENDER) {
      for (let level = 0; level <= 3; level++) {
        const shown = visibleAt(level, renderBarItem(id, idle));
        assert.notEqual(shown, "", `${id} shows nothing at level ${level}`);
      }
    }
  });

  test("and not mid-service either, where the readings are different", () => {
    const live = { ...idle, bar: contextBarState(LIVE_ITEM, NOW, 0) };
    for (const id of MUST_RENDER) {
      for (let level = 0; level <= 3; level++) {
        assert.notEqual(
          visibleAt(level, renderBarItem(id, live)),
          "",
          `${id} shows nothing at level ${level} during a live service`,
        );
      }
    }
  });

  test("THE GUARD: every digit on the strip survives every rung", () => {
    // The invariant the whole ladder is built around. A rung may take a word, a
    // qualifier or a decoration; it may never take a value. The clock's SECONDS
    // are the one deliberate exception — a reading at lower precision rather
    // than a value removed — so the clock is checked separately below.
    const live = { ...idle, bar: contextBarState(LIVE_ITEM, NOW, 0) };
    const digits = (s: string) => (s.match(/\d/g) ?? []).join("");
    for (const id of MUST_RENDER) {
      if (id === "clock") continue;
      for (const ctx of [idle, live]) {
        const full = digits(visibleAt(0, renderBarItem(id, ctx)));
        for (let level = 1; level <= 3; level++) {
          assert.equal(
            digits(visibleAt(level, renderBarItem(id, ctx))),
            full,
            `${id} lost a digit at level ${level}`,
          );
        }
      }
    }
  });

  test("the clock gives up its seconds at level 1, and nothing else, ever", () => {
    // Named rather than waved through. It is the only place the ladder touches
    // digits, and what it costs is precision, not a value: hh:mm is still the
    // time. The instrument anybody actually times a service with is the timer,
    // which keeps every character at every rung — asserted above.
    const at0 = visibleAt(0, renderBarItem("clock", idle));
    const at1 = visibleAt(1, renderBarItem("clock", idle));
    assert.ok(at0.length > at1.length, `level 1 did not shorten the clock: ${at0} / ${at1}`);
    assert.ok(at1.length > 0, "the clock disappeared entirely");
    assert.equal(visibleAt(3, renderBarItem("clock", idle)), at1, "the clock kept shrinking past level 1");
  });

  test("THE GUARD: prose is the only thing that can be cut, and it says so", () => {
    // `truncate` is what puts the ellipsis there. A prose reading that lost it
    // would still be cut at the floor — by `overflow: hidden` on the strip —
    // but with nothing to tell the reader a word had gone.
    //
    // Read off BAR_PROSE_ITEMS rather than listed here, so an item added to that
    // set without a `.bar-prose` hook fails by name instead of being warned
    // about in the configurator and then silently clipped in the bar.
    for (const id of Object.keys(BAR_PROSE_ITEMS) as (keyof typeof BAR_PROSE_ITEMS)[]) {
      const html = renderToStaticMarkup(renderBarItem(id, loaded) as never);
      assert.match(html, /bar-prose/, `${id} is prose but carries no bar-prose hook`);
      assert.match(html, /truncate/, `${id} can be cut at the floor with no ellipsis to show it`);
    }
  });

  test("THE GUARD: the service type survives every rung, because somebody chose it", () => {
    // THE DECISION THIS SPLIT TURNED ON. While the service-type name was printed
    // inside the plan item it carried `bar-drop-1`, and level 1 clipped it — the
    // rung was shortening one item, not emptying one. As an item of its own it is
    // the operator's choice, and clipping its only reading drops it: the row
    // still renders, so the no-reflow guards above stay green, but it renders to
    // zero width and the strip still charges it a gap.
    //
    // Put `bar-drop-1` back on that span and this goes red at level 1.
    for (let level = 0; level <= 3; level++) {
      assert.match(
        visibleAt(level, renderBarItem("service-type", loaded)),
        new RegExp(SERVICE_TYPE),
        `the service type is gone at level ${level}`,
      );
    }
  });

  test("and so does the plan title beside it, at every rung", () => {
    // The other half of the pair a migrated bar carries. Level 1 no longer has
    // anything to take from either of them.
    for (let level = 0; level <= 3; level++) {
      assert.match(
        visibleAt(level, renderBarItem("plan", loaded)),
        new RegExp(PLAN_TITLE),
        `the plan title is gone at level ${level}`,
      );
    }
  });

  test("a migrated bar reads exactly like the one item it replaced", () => {
    // What an operator with `plan` in their saved bar saw before the split: the
    // service-type name, then the plan title. The pair the migration writes has
    // to say the same two things, in that order, at full width.
    const pair = ["service-type", "plan"] as const;
    assert.deepEqual(
      pair.map((id) => visibleAt(0, renderBarItem(id, loaded))),
      [SERVICE_TYPE, PLAN_TITLE],
    );
  });
});

// What the Timer draws, and that each of the four widgets it replaced still draws
// what it always did.
//
// The old renderers are gone — an object saved as `countdown-timer`, `pp-timer`,
// `home-live-status` or `baptism-timer` is read as a Timer before anything draws
// it (timer-config.ts) — so "the same as before" can no longer be compared against
// the old code. It is pinned instead: each case below states the caption, value,
// sub-line and colour the OLD widget produced for that state, taken from the
// renderer it replaced, and renders the OLD config through the real ObjectContent.
// Delete the mapping and these go red; so does a Timer that draws a state
// differently from the widget it took over.
//
// NOT covered: how any of it looks. jsdom loads no stylesheet and reports every
// offsetHeight as 0 (patched below so Readout draws its rows at all), so size,
// spacing and the Home card's frame were checked in a browser instead.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import type { LayoutRenderCtx } from "./layout-renderer.js";
import { installDom } from "../test-dom.js";
import { baptismState } from "../test-fixtures/baptism-state.js";
import { NoStream } from "../test-fixtures/no-stream.js";

const teardown = installDom();
(globalThis as { EventSource?: unknown }).EventSource = NoStream;
// Readout sizes its rows from its own box, which jsdom leaves at 0 — so every row
// would be dropped. The same patch wall-status-unknown.test.tsx makes.
for (const [prop, px] of [["offsetHeight", 240], ["offsetWidth", 520]] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, { get: () => px, configurable: true });
}

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");

after(() => {
  cleanup();
  teardown();
});
afterEach(() => cleanup());

const NOW = Date.parse("2026-10-18T15:20:41.000Z");
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

/** A live item with a length: `left` seconds remain (negative once over). */
function item(left: number, over: Partial<PcoLiveDTO> = {}): PcoLiveDTO {
  return {
    mode: "item",
    currentItemId: "item-1",
    label: "Message",
    lengthSec: 60,
    liveStartAt: iso(-(60 - left) * 1000),
    targetAt: null,
    serverNow: iso(0),
    currentItemTitle: "Message",
    nextItemTitle: "Announcements",
    serviceTimeId: null,
    serviceTimeStartsAt: null,
    ...over,
  } as PcoLiveDTO;
}

const PRO = (timers: { name: string; time: string; state: string }[], connected = true) =>
  ({ connected, timers } as unknown as ProPresenterStatusDTO);

interface Drawn {
  text: string;
  caption: string | null;
  value: string | null;
  color: string | null;
  sub: string | null;
}

/** One object, drawn through the real ObjectContent, read back as its rows. */
function draw(config: Record<string, unknown>, ctx: Partial<LayoutRenderCtx> = {}): Drawn {
  cleanup();
  const o = { id: "o1", x: 0, y: 0, w: 0.3, h: 0.2, z: 1, config, style: {} } as never;
  const { container } = render(React.createElement(ObjectContent as never, { o, ctx: makeRenderCtx({ now: NOW, ...ctx }) }));
  const valueBox = container.querySelector("[data-readout-value]");
  const valueEl = valueBox?.firstElementChild as HTMLElement | null;
  const subEl = container.querySelector("[title]");
  return {
    text: container.textContent ?? "",
    caption: valueBox?.previousElementSibling?.textContent ?? null,
    value: valueEl?.textContent ?? null,
    color: valueEl?.style.color ?? null,
    sub: subEl?.textContent ?? null,
  };
}

const NEUTRAL = /readout-value-color/;
const RED_WALL = "var(--red-10)";
const AMBER_WALL = "var(--yellow-10)";

describe("a saved PCO countdown draws what it always drew", () => {
  test("over time: the caption it was given, a negative time, red", () => {
    const d = draw({ type: "countdown-timer", caption: "Service starts in" }, { pcoLive: item(-12) });
    assert.equal(d.caption, "Service starts in");
    assert.equal(d.value, "−0:12");
    assert.equal(d.color, RED_WALL);
    assert.equal(d.sub, null);
  });

  test("amber at or under Warn at, and only then", () => {
    const warned = { type: "countdown-timer", warnSeconds: 60, caption: "Time left" };
    assert.equal(draw(warned, { pcoLive: item(48) }).color, AMBER_WALL);
    assert.match(draw({ ...warned, warnSeconds: 30 }, { pcoLive: item(48) }).color ?? "", NEUTRAL);
    // No Warn at saved: never amber.
    assert.match(draw({ type: "countdown-timer" }, { pcoLive: item(5) }).color ?? "", NEUTRAL);
  });

  test("an object saved with no caption draws none", () => {
    // "No layout anybody built gains a caption it did not ask for."
    const d = draw({ type: "countdown-timer" }, { pcoLive: item(48) });
    assert.equal(d.caption, null);
    assert.equal(d.value, "0:48");
    assert.equal(d.sub, null, "a countdown never drew the next item");
  });

  test("nothing live: a dash, or nothing at all under Hide when idle", () => {
    assert.equal(draw({ type: "countdown-timer", caption: "Time left" }, { pcoLive: null }).value, "—");
    assert.equal(draw({ type: "countdown-timer", hideWhenIdle: true }, { pcoLive: null }).text, "");
  });

  test("before the service: counts down to the start", () => {
    const pre = { mode: "preservice", label: "Service starts", targetAt: iso(95_000), serverNow: iso(0) } as unknown as PcoLiveDTO;
    assert.equal(draw({ type: "countdown-timer" }, { pcoLive: pre }).value, "1:35");
  });
});

describe("a saved ProPresenter timer draws what it always drew", () => {
  const sermon = { name: "Sermon", time: "-00:00:02", state: "overran" };
  const stage = { name: "Stage", time: "00:03:00", state: "running" };
  const saved = { type: "pp-timer", timerName: null, propresenterInstanceId: null, warnStates: true, hideWhenIdle: false, showLabel: true, caption: "Stage timer" };

  test("red once the state says the time is up, with the timer's name under it", () => {
    const d = draw(saved, { propresenter: PRO([sermon]) });
    assert.equal(d.caption, "Stage timer");
    assert.equal(d.value, "-00:00:02");
    assert.equal(d.color, RED_WALL);
    assert.equal(d.sub, "Sermon");
  });

  test("Color on overrun off: the same state stays neutral", () => {
    assert.match(draw({ ...saved, warnStates: false }, { propresenter: PRO([sermon]) }).color ?? "", NEUTRAL);
  });

  test("a running timer is neutral, and Show timer name off drops the sub-line", () => {
    const d = draw({ ...saved, showLabel: false }, { propresenter: PRO([stage]) });
    assert.match(d.color ?? "", NEUTRAL);
    assert.equal(d.sub, null);
    assert.equal(d.value, "00:03:00");
  });

  test("a named timer is found among several; blank takes the first", () => {
    const both = PRO([stage, sermon]);
    assert.equal(draw({ ...saved, timerName: "Sermon" }, { propresenter: both }).value, "-00:00:02");
    assert.equal(draw(saved, { propresenter: both }).value, "00:03:00");
  });

  test("a named instance reads that machine, not the default one", () => {
    const d = draw(
      { ...saved, propresenterInstanceId: "room-2" },
      {
        propresenter: PRO([stage]),
        propInstances: { list: [], conn: {}, status: { "room-2": PRO([sermon]) } } as unknown as PropInstancesDTO,
      },
    );
    assert.equal(d.value, "-00:00:02");
  });

  test("no timer: a dash, or nothing under Hide when idle", () => {
    assert.equal(draw(saved, { propresenter: PRO([]) }).value, "—");
    assert.equal(draw({ ...saved, hideWhenIdle: true }, { propresenter: PRO([]) }).text, "");
  });

  test("an object saved with no caption draws none", () => {
    const { caption: _caption, ...bare } = saved;
    assert.equal(draw(bare, { propresenter: PRO([stage]) }).caption, null);
  });
});

describe("a saved Service timer card draws what it always drew, on Home", () => {
  // The card was LiveStatusCard: a Stat with the item's name for caption, the time,
  // "Next · <title>" under it, and the danger colour only when over.
  const home = { home: true, interactive: true };

  test("a running item: its name, its time, the next item", () => {
    const d = draw({ type: "home-live-status" }, { ...home, pcoLive: item(48) });
    assert.equal(d.caption, "Message");
    assert.equal(d.value, "0:48");
    assert.equal(d.sub, "Next · Announcements");
    assert.match(d.color ?? "", NEUTRAL);
  });

  test("over: the danger colour, and never amber however little is left", () => {
    assert.equal(draw({ type: "home-live-status" }, { ...home, pcoLive: item(-12) }).color, "var(--color-danger-11)");
    assert.match(draw({ type: "home-live-status" }, { ...home, pcoLive: item(5) }).color ?? "", NEUTRAL);
  });

  test("nothing live: the word Service over a dash", () => {
    const d = draw({ type: "home-live-status" }, { ...home, pcoLive: null });
    assert.equal(d.caption, "Service");
    assert.equal(d.value, "—");
    assert.equal(d.sub, null);
  });

  test("the next item shows even with nothing counting", () => {
    // The old card read nextItemTitle off pco:live whether or not a timer existed.
    const d = draw({ type: "home-live-status" }, { ...home, pcoLive: { mode: "none", nextItemTitle: "Welcome" } as unknown as PcoLiveDTO });
    assert.equal(d.value, "—");
    assert.equal(d.sub, "Next · Welcome");
  });
});

describe("a saved Baptism timer draws what it always drew", () => {
  const idle = baptismState({});

  test("an empty Label with Show label on drew no sub-line, and still draws none", () => {
    // The registry wrote label "" and the old readout drew `label ?? the word`, so
    // the line never appeared although the switch said it would.
    const d = draw({ type: "baptism-timer", field: "live", showLabel: true, label: "", caption: "Baptisms" }, { baptism: idle });
    assert.equal(d.value, "0:00");
    assert.equal(d.sub, null);
  });

  test("no label saved: the readout's own word", () => {
    const d = draw({ type: "baptism-timer", field: "live", showLabel: true }, { baptism: idle });
    assert.equal(d.sub, "ready");
  });

  test("no Show label saved draws no sub-line at all", () => {
    // `showLabel` unset read as off in the old readout — unlike the Timer's default.
    assert.equal(draw({ type: "baptism-timer", field: "count" }, { baptism: idle }).sub, null);
  });

  test("a caption saved as nothing draws none", () => {
    assert.equal(draw({ type: "baptism-timer", field: "count", showLabel: true }, { baptism: idle }).caption, null);
  });

  test("not answered yet: a dash, and live's ready is not claimed", () => {
    const d = draw({ type: "baptism-timer", field: "live", showLabel: true }, { baptism: null, baptismKnown: false });
    assert.equal(d.value, "—");
    assert.equal(d.sub, null);
  });
});

describe("the Timer itself", () => {
  test("a new Timer is the service clock, captioned with the item's name", () => {
    const d = draw({ type: "timer", source: "service" }, { pcoLive: item(48) });
    assert.equal(d.caption, "Message");
    assert.equal(d.value, "0:48");
    assert.equal(d.sub, null, "Show the next item is off until switched on");
  });

  test("Show the next item adds the line, and Show the sub-line off removes it", () => {
    const live = { pcoLive: item(48) };
    assert.equal(draw({ type: "timer", source: "service", nextItem: true }, live).sub, "Next · Announcements");
    assert.equal(draw({ type: "timer", source: "service", nextItem: true, showLabel: false }, live).sub, null);
  });

  test("Red on overrun off leaves an overrun neutral", () => {
    const over = { pcoLive: item(-12) };
    assert.equal(draw({ type: "timer", source: "service" }, over).color, RED_WALL);
    assert.match(draw({ type: "timer", source: "service", redOnOverrun: false }, over).color ?? "", NEUTRAL);
  });

  test("a live item with no length counts up and is never amber", () => {
    // Its seconds are elapsed, not remaining, so Warn at has nothing to warn about.
    const up = item(0, { lengthSec: null, liveStartAt: iso(-20_000) });
    const d = draw({ type: "timer", source: "service", warnSeconds: 60 }, { pcoLive: up });
    assert.equal(d.value, "0:20");
    assert.match(d.color ?? "", NEUTRAL);
  });

  test("a ProPresenter timer goes amber near the end, from the time it reports", () => {
    const at = (time: string, state = "running") => ({ propresenter: PRO([{ name: "Stage", time, state }]) });
    const cfg = { type: "timer", source: "propresenter", warnSeconds: 60 };
    assert.equal(draw(cfg, at("00:00:45")).color, AMBER_WALL);
    assert.equal(draw(cfg, at("00:01:00")).color, AMBER_WALL, "at the threshold is amber");
    assert.match(draw(cfg, at("00:01:01")).color ?? "", NEUTRAL);
    assert.match(draw({ type: "timer", source: "propresenter" }, at("00:00:10")).color ?? "", NEUTRAL, "Amber near the end is off until switched on");
    assert.equal(draw(cfg, at("-00:00:02", "overrunning")).color, RED_WALL, "over is red, not amber");
  });

  test("a baptism Timer hides while idle once the session has answered", () => {
    const cfg = { type: "timer", source: "baptism", hideWhenIdle: true };
    assert.equal(draw(cfg, { baptism: baptismState({}), baptismKnown: true }).text, "");
    assert.notEqual(draw(cfg, { baptism: baptismState({ phase: "testimony", personNumber: 1 }), baptismKnown: true }).text, "");
  });

  test("on Home it is a stat card in Home's own colours", () => {
    const d = draw({ type: "timer", source: "service", warnSeconds: 60 }, { home: true, interactive: true, pcoLive: item(48) });
    assert.equal(d.color, "var(--color-warn-11)");
    assert.equal(draw({ type: "timer", source: "service" }, { home: true, interactive: true, pcoLive: item(-5) }).color, "var(--color-danger-11)");
  });
});

describe("a source that has not answered", () => {
  // The wall-status-unknown rule: while a read is in flight the widget draws the
  // plain dash and makes no claim. Only a source KNOWN to be down says so.
  test("loading draws a dash and no sentence, for service and ProPresenter", () => {
    const service = draw({ type: "timer", source: "service" }, { pcoLive: null, pcoLiveKnown: false });
    assert.equal(service.value, "\u2014");
    assert.equal(service.sub, null);
    assert.doesNotMatch(service.text, /answering/);
    const pro = draw({ type: "timer", source: "propresenter" }, { propresenter: null, propresenterKnown: false });
    assert.equal(pro.value, "\u2014");
    assert.equal(pro.sub, null);
    assert.doesNotMatch(pro.text, /answering/);
  });

  test("Planning Center answered with nothing live is idle, with no sentence", () => {
    const idle = draw({ type: "timer", source: "service" }, { pcoLive: null, pcoLiveKnown: true });
    assert.equal(idle.value, "\u2014");
    assert.equal(idle.sub, null);
  });

  test("ProPresenter says it is not answering only after it has answered that it is down", () => {
    const cfg = { type: "timer", source: "propresenter" };
    assert.equal(draw(cfg, { propresenter: PRO([], false), propresenterKnown: true }).sub, "ProPresenter isn\u2019t answering");
    assert.equal(draw(cfg, { propresenter: PRO([], true), propresenterKnown: true }).sub, null, "connected with no timer running is idle");
  });

  test("Hide when idle stays hidden through the first read", () => {
    assert.equal(draw({ type: "timer", source: "service", hideWhenIdle: true }, { pcoLiveKnown: false }).text, "");
    assert.equal(draw({ type: "timer", source: "propresenter", hideWhenIdle: true }, { propresenter: null, propresenterKnown: false }).text, "");
  });

  test("a ProPresenter known to be down still says so under Hide when idle", () => {
    const d = draw({ type: "timer", source: "propresenter", hideWhenIdle: true }, { propresenter: PRO([], false), propresenterKnown: true });
    assert.equal(d.sub, "ProPresenter isn\u2019t answering");
  });
});

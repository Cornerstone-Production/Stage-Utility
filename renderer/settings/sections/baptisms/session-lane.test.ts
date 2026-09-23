// session-lane.test.ts — the Session chart's arithmetic: which stretches are
// gaps, how far the domain reaches, and what a hovered span says.
//
// No DOM, no invoke, no SSE — everything here is pure, like history-chart's own
// geometry.test.ts and lane.test.ts. The component that renders this (and the
// fetch-on-push behaviour) is session-chart.tsx, proven separately in
// session-chart-refetch.test.tsx because that guard needs a real render.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { formatClock as formatClockFixture } from "../../../lib/clock-format.js";
import type { LaneItem } from "../history-chart/lane.js";
import {
  clipToSession,
  gapSpans,
  planLaneItems,
  sessionAxisLabel,
  sessionAxisTicks,
  sessionSpans,
  sessionWindow,
  timerHoverFigures,
  timerLaneItems,
  type TimerLaneItem,
} from "./session-lane.js";

type Span = { kind: "testimony" | "baptism"; person: number; startedAt: string; endedAt: string | null };

const T0 = Date.parse("2026-09-20T15:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function span(over: Partial<Span> = {}): Span {
  return { kind: "testimony", person: 1, startedAt: iso(T0), endedAt: iso(T0 + 60_000), ...over };
}

describe("gapSpans", () => {
  test("a continuous run — spans touching exactly — returns nothing", () => {
    const spans = [
      span({ person: 1, startedAt: iso(T0), endedAt: iso(T0 + 60_000) }),
      span({ person: 2, startedAt: iso(T0 + 60_000), endedAt: iso(T0 + 120_000) }),
    ];
    assert.deepEqual(gapSpans(spans, iso(T0 + 120_000)), []);
  });

  test("a pause — daylight between two closed spans — is the gap between them", () => {
    const spans = [
      span({ person: 1, startedAt: iso(T0), endedAt: iso(T0 + 60_000) }),
      // Paused for 30s before person 2 resumes.
      span({ person: 2, startedAt: iso(T0 + 90_000), endedAt: iso(T0 + 150_000) }),
    ];
    assert.deepEqual(gapSpans(spans, iso(T0 + 150_000)), [
      { startedAt: iso(T0 + 60_000), endedAt: iso(T0 + 90_000) },
    ]);
  });

  test("the armed stretch — last span closed, nothing open yet — reaches to windowEndIso", () => {
    // baptisms-armed closes the last testimony and opens nothing (see
    // baptism-lane.ts): the gap is everything from there to "now".
    const spans = [span({ person: 1, startedAt: iso(T0), endedAt: iso(T0 + 200_000) })];
    assert.deepEqual(gapSpans(spans, iso(T0 + 260_000)), [
      { startedAt: iso(T0 + 200_000), endedAt: iso(T0 + 260_000) },
    ]);
  });

  test("a still-running span is never a gap's start — there is nothing after it yet", () => {
    const spans = [span({ person: 1, startedAt: iso(T0), endedAt: null })];
    assert.deepEqual(gapSpans(spans, iso(T0 + 60_000)), []);
  });

  test("windowEndIso equal to the last span's own end is not a gap of zero width", () => {
    const spans = [span({ person: 1, startedAt: iso(T0), endedAt: iso(T0 + 60_000) })];
    assert.deepEqual(gapSpans(spans, iso(T0 + 60_000)), []);
  });

  test("no spans at all returns nothing — there is no session to have a gap in", () => {
    assert.deepEqual(gapSpans([], iso(T0)), []);
  });

  test("two separate pauses both come back, oldest first", () => {
    const spans = [
      span({ person: 1, startedAt: iso(T0), endedAt: iso(T0 + 60_000) }),
      span({ person: 1, kind: "baptism", startedAt: iso(T0 + 90_000), endedAt: iso(T0 + 120_000) }),
      span({ person: 2, kind: "baptism", startedAt: iso(T0 + 180_000), endedAt: iso(T0 + 200_000) }),
    ];
    assert.deepEqual(gapSpans(spans, iso(T0 + 200_000)), [
      { startedAt: iso(T0 + 60_000), endedAt: iso(T0 + 90_000) },
      { startedAt: iso(T0 + 120_000), endedAt: iso(T0 + 180_000) },
    ]);
  });
});

describe("sessionWindow", () => {
  // Important 1 (final review): this used to take every span and plan item
  // the WHOLE SERVICE ever had and widen the domain to whatever any of them
  // covered. Seeded with a realistic service and driven for real, a session
  // that actually ran about 25m to 47m read as an 0m-85m axis, because a
  // countdown 25 minutes before it and a 38-minute sermon after it were still
  // feeding the same min/max. Rebuilt to read ONLY the session's own recorded
  // boundary (sessionStartedAt/finishedAt) — this function no longer has a
  // parameter a plan item or a stray span COULD widen it with. See
  // clipToSession and sessionSpans below for how those are kept off the chart
  // now that this no longer reaches for them.
  //
  // The whole "a dangling open span from a crash, read back two days later"
  // test family Fix round 1 added here is gone, not just renamed: that class
  // of bug lived in treating an OPEN SPAN's absence of an end as "maybe now,
  // maybe not" (see the old take()). This function no longer looks at a span
  // at all, so a dangling one — from this session or any other in the same
  // file — cannot reach it.
  test("no session started at all — nothing to draw", () => {
    assert.equal(sessionWindow(null, null, { live: true, nowMs: T0 }), null);
  });

  test("an unparseable start is the same as no session", () => {
    assert.equal(sessionWindow("not-a-date", null, { live: false, nowMs: T0 }), null);
  });

  test("live reaches nowMs regardless of finishedAt — a running session has none yet", () => {
    const win = sessionWindow(iso(T0), null, { live: true, nowMs: T0 + 300_000 });
    assert.deepEqual(win, { startMs: T0, endMs: T0 + 300_000 });
  });

  test("not live stops at the session's own finish, however much later nowMs is", () => {
    const win = sessionWindow(iso(T0), iso(T0 + 27 * 60_000), { live: false, nowMs: T0 + 999_999_999 });
    assert.deepEqual(win, { startMs: T0, endMs: T0 + 27 * 60_000 });
  });

  test("not live with no finishedAt — a shape this function's one caller never actually produces — draws as an instant, never reaching for now", () => {
    const win = sessionWindow(iso(T0), null, { live: false, nowMs: T0 + 999_999 });
    assert.deepEqual(win, { startMs: T0, endMs: T0 + 1 });
  });
});

describe("clipToSession", () => {
  const item = (a: number, b: number | null, over: Partial<LaneItem> = {}): LaneItem => ({
    itemId: "i1",
    title: "X",
    sequence: 0,
    startedAt: iso(a),
    endedAt: b === null ? null : iso(b),
    preService: false,
    plannedSec: null,
    actualSec: null,
    ...over,
  });

  test("fully inside the window is unchanged", () => {
    const [out] = clipToSession([item(T0 + 60_000, T0 + 120_000)], T0, T0 + 300_000);
    assert.equal(out!.startedAt, iso(T0 + 60_000));
    assert.equal(out!.endedAt, iso(T0 + 120_000));
  });

  test("straddling the start is clamped to the window's own start", () => {
    const [out] = clipToSession([item(T0 - 60_000, T0 + 60_000)], T0, T0 + 300_000);
    assert.equal(out!.startedAt, iso(T0));
    assert.equal(out!.endedAt, iso(T0 + 60_000));
  });

  test("straddling the end is clamped to the window's own end", () => {
    const [out] = clipToSession([item(T0 + 240_000, T0 + 600_000)], T0, T0 + 300_000);
    assert.equal(out!.startedAt, iso(T0 + 240_000));
    assert.equal(out!.endedAt, iso(T0 + 300_000));
  });

  test("still open (endedAt null) is clamped to the window's own end, like a live item", () => {
    const [out] = clipToSession([item(T0 + 60_000, null)], T0, T0 + 300_000);
    assert.equal(out!.endedAt, iso(T0 + 300_000));
  });

  // This is Important 1's own bug, at the arithmetic level: before this fix,
  // an item entirely outside the session (the sermon, the closing) still fed
  // sessionWindow's min/max and drew as a wide "not counted" block covering
  // it, or a bare-number label once the whole domain widened around it.
  test("entirely before the window is dropped", () => {
    assert.deepEqual(clipToSession([item(T0 - 600_000, T0 - 300_000)], T0, T0 + 300_000), []);
  });

  test("entirely after the window is dropped", () => {
    assert.deepEqual(clipToSession([item(T0 + 400_000, T0 + 700_000)], T0, T0 + 300_000), []);
  });

  test("touching exactly at either edge is kept, matching laneSegments' own inclusive boundary", () => {
    const out = clipToSession([item(T0 - 60_000, T0), item(T0 + 300_000, T0 + 360_000)], T0, T0 + 300_000);
    assert.equal(out.length, 2);
  });

  test("an unreadable timestamp is left alone rather than dropped", () => {
    const [out] = clipToSession([item(T0, T0 + 60_000, { startedAt: "not-a-date" })], T0, T0 + 300_000);
    assert.equal(out!.startedAt, "not-a-date");
  });
});

describe("sessionSpans", () => {
  test("keeps only spans starting inside [startMs, endMs] — an earlier, unrelated session's own is dropped", () => {
    // The lane route returns every session in the service's baptism.csv
    // concatenated (baptism-lane.ts's own header) — Important 1's other half.
    const spans = [
      span({ person: 1, startedAt: iso(T0 - 3_600_000), endedAt: iso(T0 - 3_500_000) }),
      span({ person: 1, startedAt: iso(T0), endedAt: iso(T0 + 60_000) }),
      span({ person: 2, kind: "baptism", startedAt: iso(T0 + 90_000), endedAt: iso(T0 + 150_000) }),
    ];
    const out = sessionSpans(spans, T0, T0 + 300_000);
    assert.equal(out.length, 2);
    assert.equal(out[0]!.startedAt, iso(T0));
    assert.equal(out[1]!.startedAt, iso(T0 + 90_000));
  });

  test("a still-open last span is kept when its start is inside the window", () => {
    const spans = [span({ startedAt: iso(T0 + 60_000), endedAt: null })];
    assert.deepEqual(sessionSpans(spans, T0, T0 + 120_000), spans);
  });

  test("an unparseable startedAt is dropped, not kept by default", () => {
    assert.deepEqual(sessionSpans([span({ startedAt: "not-a-date" })], T0, T0 + 300_000), []);
  });
});

describe("timerLaneItems", () => {
  test("carries kind and person, and labels by person number", () => {
    const [item] = timerLaneItems([span({ kind: "baptism", person: 3, startedAt: iso(T0), endedAt: iso(T0 + 40_000) })]);
    assert.equal(item.kind, "baptism");
    assert.equal(item.person, 3);
    assert.equal(item.title, "Person 3");
    // sequence + 1 (laneLabel's number fallback) must ALSO read as "3", the
    // same identity as the title — there is no second, shorter name for a span.
    assert.equal(item.sequence + 1, 3);
    assert.equal(item.startedAt, iso(T0));
    assert.equal(item.endedAt, iso(T0 + 40_000));
  });

  test("a running span's endedAt stays null, not coerced to a placeholder", () => {
    const [item] = timerLaneItems([span({ endedAt: null })]);
    assert.equal(item.endedAt, null);
  });

  test("order is preserved — the same order the spans were recorded in", () => {
    const spans = [span({ person: 1 }), span({ person: 2, kind: "baptism" }), span({ person: 3, kind: "baptism" })];
    assert.deepEqual(timerLaneItems(spans).map((i) => i.person), [1, 2, 3]);
  });
});

describe("planLaneItems", () => {
  const base = { itemId: "i1", title: "Baptism Stories", sequence: 0, plannedLengthSec: 300, actualDurationSec: 280 };

  test("maps planned/actual off the timeline's own field names", () => {
    const [item] = planLaneItems([{ ...base, startedAt: iso(T0), endedAt: iso(T0 + 280_000) }]);
    assert.equal(item.plannedSec, 300);
    assert.equal(item.actualSec, 280);
  });

  test("an item PCO never showed live (no startedAt) is dropped", () => {
    assert.deepEqual(planLaneItems([{ ...base, startedAt: "", endedAt: null }]), []);
  });

  test("preService is always false here, even when the source item says otherwise", () => {
    // This chart has one plan lane, not History's pre/service split — see the
    // doc comment on planLaneItems for why forcing it is what keeps the one
    // lane's own overlap stacking correct.
    const [item] = planLaneItems([{ ...base, startedAt: iso(T0), endedAt: null, preService: true } as never]);
    assert.equal(item.preService, false);
  });
});

describe("sessionAxisTicks", () => {
  // Fix round 1 (from drive 2), the TIME AXIS finding: a domain under
  // history-chart's own 10-minute tick floor drew no axis at all — confirmed
  // live against a real seeded ~30-second session (zero <line> and zero
  // axis <text> elements in the rendered SVG). This is a SEPARATE, local
  // tick function precisely so history-chart/geometry.ts's timeTicks() does
  // not have to change for every other chart that uses it.
  test("a 4-minute session — at most 8 minutes — steps by 1 minute, 0m through 4m", () => {
    const ticks = sessionAxisTicks(T0, T0 + 4 * 60_000);
    assert.deepEqual(
      ticks.map((t) => sessionAxisLabel(t, T0)),
      ["0m", "1m", "2m", "3m", "4m"],
    );
  });

  test("an 8-minute session — the boundary itself — is still the 1-minute step", () => {
    const ticks = sessionAxisTicks(T0, T0 + 8 * 60_000);
    assert.equal(ticks.length, 9); // 0m..8m
  });

  test("a 12-minute session — over 8, at most 20 — steps by 2 minutes", () => {
    const ticks = sessionAxisTicks(T0, T0 + 12 * 60_000);
    assert.deepEqual(
      ticks.map((t) => sessionAxisLabel(t, T0)),
      ["0m", "2m", "4m", "6m", "8m", "10m", "12m"],
    );
  });

  test("a 30-minute session — over 20, at most 60 — steps by 5 minutes", () => {
    const ticks = sessionAxisTicks(T0, T0 + 30 * 60_000);
    assert.deepEqual(
      ticks.map((t) => sessionAxisLabel(t, T0)),
      ["0m", "5m", "10m", "15m", "20m", "25m", "30m"],
    );
  });

  test("a 90-minute session — over an hour, past what the mockup covers — steps by 10 minutes", () => {
    const ticks = sessionAxisTicks(T0, T0 + 90 * 60_000);
    assert.deepEqual(
      ticks.map((t) => sessionAxisLabel(t, T0)),
      ["0m", "10m", "20m", "30m", "40m", "50m", "60m", "70m", "80m", "90m"],
    );
  });

  test("a zero-or-negative span draws no axis rather than looping forever", () => {
    assert.deepEqual(sessionAxisTicks(T0, T0), []);
    assert.deepEqual(sessionAxisTicks(T0, T0 - 1), []);
  });

  test("a non-finite bound draws no axis", () => {
    assert.deepEqual(sessionAxisTicks(NaN, T0 + 60_000), []);
    assert.deepEqual(sessionAxisTicks(T0, Infinity), []);
  });
});

describe("sessionAxisLabel", () => {
  test("is elapsed minutes from the session's own start, never a clock time", () => {
    assert.equal(sessionAxisLabel(T0, T0), "0m");
    assert.equal(sessionAxisLabel(T0 + 150_000, T0), "3m"); // 2m30s rounds to 3m
  });
});

describe("timerHoverFigures", () => {
  const testimony: TimerLaneItem = {
    itemId: "testimony-2-x", title: "Person 2", sequence: 1, kind: "testimony", person: 2,
    startedAt: iso(T0), endedAt: iso(T0 + 108_000), preService: false, plannedSec: null, actualSec: null,
  };

  test("a closed span reports its own duration and 'Ended'", () => {
    const f = timerHoverFigures(testimony, T0 + 999_999);
    const by = (k: string) => f.find((x) => x.key === k)?.value;
    assert.equal(by("hoverPerson"), "Person 2");
    assert.equal(by("hoverPhase"), "1:48");
    assert.equal(f.find((x) => x.key === "hoverPhase")?.label, "Testimony");
    assert.equal(by("hoverStart"), formatClockFixture(T0, { seconds: true }));
    assert.equal(by("hoverEnd"), formatClockFixture(T0 + 108_000, { seconds: true }));
    assert.equal(f.find((x) => x.key === "hoverEnd")?.label, "Ended");
  });

  test("a running span reads its duration to the window's end, not its own (null) end", () => {
    const running: TimerLaneItem = { ...testimony, kind: "baptism", endedAt: null };
    const f = timerHoverFigures(running, T0 + 40_000);
    const by = (k: string) => f.find((x) => x.key === k)?.value;
    assert.equal(by("hoverPhase"), "0:40");
    assert.equal(f.find((x) => x.key === "hoverEnd")?.label, "Still running");
  });

  // Fix round 1 (from drive 2), the HOVER SECONDS finding: Started and Ended
  // used to share formatClock's default (minute) precision, so a sub-minute
  // segment — common for a baptism, see docs/features/scriptview-and-
  // baptisms.md — could show the identical string for both, e.g. both
  // "4:51", beside a duration figure that correctly read "0:03".
  test("a sub-minute segment's Started and Ended differ, because both now carry seconds", () => {
    const short: TimerLaneItem = { ...testimony, startedAt: iso(T0), endedAt: iso(T0 + 3_000) };
    const f = timerHoverFigures(short, T0 + 999_999);
    const by = (k: string) => f.find((x) => x.key === k)?.value;
    assert.equal(by("hoverPhase"), "0:03");
    assert.notEqual(by("hoverStart"), by("hoverEnd"));
    assert.equal(by("hoverStart"), formatClockFixture(T0, { seconds: true }));
    assert.equal(by("hoverEnd"), formatClockFixture(T0 + 3_000, { seconds: true }));
  });
});

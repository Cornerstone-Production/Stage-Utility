// The arithmetic behind the Trends card.
//
// No DOM: what a day is worth, what a tile leads with, what it compares that
// against, and where a milestone lands are all arithmetic, and a render jsdom
// cannot lay out would tell us nothing about any of it. What IS visual — the
// tile grid's wrap, a milestone label colliding with its neighbour, the accent
// on a hovered mark — was driven in Chrome and is named in trends-card.tsx.
//
// NOT HERE: that the TILE and the chart's LINE are drawn from one derivation.
// A test in this file cannot check it — the line's points are built in
// trends-card.tsx, and nothing in this file renders. One that compared
// `typeTrends`'s own output against `dailyValues` lived here and read as if it
// did: reverting the card's series to one node per recording left it green.
// "adds up into one point, on the tile AND on the line" in trends-card.test.tsx
// is the guard, and it goes red on exactly that.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  MIN_PRIOR_DAYS,
  TREND_WINDOW,
  appZoneOf,
  dailyValues,
  seriesChangeMilestones,
  trendMilestones,
  trendClock,
  typeTrends,
  withinRange,
  type TrendClock,
  type TrendRecording,
} from "./trends.js";

const DAY = 24 * 60 * 60_000;

/** A weekly service of one type, `peaks` oldest first — one service a week.
 *  `db` gives each recording a level too, for the sound measure. */
function weekly(
  typeId: string,
  peaks: (number | null)[],
  opts: { series?: (string | null)[]; from?: number; db?: (number | null)[] } = {},
): TrendRecording[] {
  const start = opts.from ?? Date.parse("2026-01-04T09:00:00Z");
  return peaks.map((p, i) => ({
    serviceKey: `${typeId}:${i}`,
    serviceTypeId: typeId,
    serviceTypeName: typeId === "weekend" ? "Weekend" : "Evening",
    serviceDate: new Date(start + i * 7 * DAY).toISOString().slice(0, 10),
    t: start + i * 7 * DAY,
    seriesTitle: opts.series?.[i] ?? null,
    peakOccupancy: p,
    peakDb: opts.db?.[i] ?? null,
    complete: true,
  }));
}

/** The first Sunday every `sundays` fixture starts on, and the spacing between
 *  its services — two hours, so a 9, an 11 and a 1 o'clock. */
const FIRST_SUNDAY = Date.parse("2026-01-04T09:00:00Z");
const SERVICE_GAP = 2 * 60 * 60_000;

/**
 * `weeks` Sundays, each running the services in `perDay` (peaks, in order, two
 * hours apart) — the shape a church with a 9, an 11 and a 6 records.
 *
 * THE LAST DAY CAN BE MID-MORNING. `done` is how many of its services have
 * ended; `running` says the next one is on air. Anything after that has NO
 * RECORD AT ALL, which is what a service that has not started looks like — the
 * fixture used to invent one, so a Sunday on its first service carried three
 * records and no test could tell "between services" from "mid-service".
 *
 * Every fixture in this file was finished days only before that, which is why a
 * partial Sunday could be compared against whole ones for a whole release
 * without a test noticing.
 */
function sundays(
  typeId: string,
  weeks: number,
  perDay: number[],
  opts: { done?: number; running?: boolean } = {},
): TrendRecording[] {
  const out: TrendRecording[] = [];
  for (let w = 0; w < weeks; w++) {
    const day = FIRST_SUNDAY + w * 7 * DAY;
    const last = w === weeks - 1;
    const done = last ? opts.done ?? perDay.length : perDay.length;
    const upTo = last && opts.running ? Math.min(done + 1, perDay.length) : done;
    perDay.slice(0, last ? upTo : perDay.length).forEach((peak, i) => {
      out.push({
        serviceKey: `${typeId}:${w}:${i}`,
        serviceTypeId: typeId,
        serviceTypeName: "Weekend",
        serviceDate: new Date(day).toISOString().slice(0, 10),
        t: day + i * SERVICE_GAP,
        seriesTitle: null,
        peakOccupancy: peak,
        peakDb: 90 + i,
        complete: i < done,
      });
    });
  }
  return out;
}

/**
 * A clock that says it is `weeks - 1` Sundays after the first, mid-morning, with
 * `count` services on the day's plan.
 *
 * The zone is explicit and so is `now`: nothing in these tests may depend on the
 * host's clock or the host's zone, which is the whole reason `TrendClock` is an
 * argument rather than something `typeTrends` reads.
 */
function sundayClock(weeks: number, count: number, atService: number): TrendClock {
  const day = FIRST_SUNDAY + (weeks - 1) * 7 * DAY;
  return {
    // Half an hour into service `atService`.
    now: day + atService * SERVICE_GAP + 30 * 60_000,
    today: new Date(day).toISOString().slice(0, 10),
    serviceTimesToday: Array.from({ length: count }, (_, i) => day + i * SERVICE_GAP),
  };
}

describe("what a day is worth", () => {
  test("attendance ADDS a day's services up, at the day's first service's time", () => {
    // A church running a 9, an 11 and a 6 held three services that Sunday and
    // the question a trend answers is "how many came", so the three add
    // together. The maximum answered "how full was the fullest service", which
    // the service page already answers per service.
    const days = dailyValues(sundays("weekend", 3, [1400, 700, 1100]), "attendance");
    assert.deepEqual(days.map((d) => d.v), [3200, 3200, 3200]);
    assert.notDeepEqual(days.map((d) => d.v), [1400, 1400, 1400], "the day is still the busiest single service");
    assert.deepEqual(days.map((d) => d.count), [3, 3, 3]);
    const first = Date.parse("2026-01-04T09:00:00Z");
    assert.equal(days[0].t, first, "the node sits at the day's FIRST service, inside its own cluster");
  });

  test("SOUND TAKES THE LOUDEST, and must never add", () => {
    // Decibels are logarithmic. Three services at 96, 99 and 104 did not make
    // 299 dB; adding them is not louder, it is meaningless, and it would put a
    // three-figure level on the card every Sunday.
    const recs = sundays("weekend", 2, [1400, 700, 1100]).map((r, i) => ({
      ...r,
      peakDb: [96, 99, 104][i % 3],
    }));
    const levels = dailyValues(recs, "sound").map((d) => d.v);
    assert.deepEqual(levels, [104, 104], "a day's level is its loudest recording");
    assert.deepEqual(
      levels.filter((v) => v > 120),
      [],
      `a day's level was summed: ${levels.join(", ")} dB`,
    );
    // The same recordings under the other measure DO add, so this is the
    // exception and not a derivation that never sums anything.
    assert.deepEqual(dailyValues(recs, "attendance").map((d) => d.v), [3200, 3200]);
  });

  test("a recording with no attendance record is skipped, not counted as zero", () => {
    // A service nobody counted is not a service of nobody — and a day where two
    // of three services had a counter running is the sum of those two.
    const counted = sundays("weekend", 1, [900, 300]);
    const uncounted = sundays("weekend", 1, [0]).map((r) => ({
      ...r,
      serviceKey: "x",
      t: r.t + 4 * 60 * 60_000,
      peakOccupancy: null,
    }));
    assert.deepEqual(
      dailyValues([...counted, ...uncounted], "attendance").map((d) => [d.v, d.count]),
      [[1200, 2]],
    );
  });
});

/**
 * The change a tile prints, as an ABSOLUTE difference, or null when there is no
 * comparison to make.
 *
 * One expression, here, so every case below reads the figure the same way the
 * card does. The tile rounds both figures to the precision it prints and
 * subtracts those; these fixtures are all whole numbers, so the raw difference
 * is the same thing.
 */
function delta(tile: { latestRaw: number | null; priorAverageRaw: number | null }): number | null {
  if (tile.latestRaw == null || tile.priorAverageRaw == null) return null;
  return tile.latestRaw - tile.priorAverageRaw;
}

describe("a service type's trend tile", () => {
  test("leads with the LATEST recorded day, not a mean of the window", () => {
    // The mean answered "what is a normal Sunday here", which does not change
    // week to week — a number that never moved, on the card an operator opens
    // to see the Sunday that just happened.
    const [tile] = typeTrends(weekly("weekend", [...Array(8).fill(100), 120]));
    assert.equal(tile.recent.length, TREND_WINDOW);
    assert.equal(tile.latest, 120, "the tile is averaging its window again");
    assert.equal(tile.priorAverage, 100);
    assert.equal(tile.serviceCount, 1, "one service a week, so the slice is one");
    assert.equal(delta(tile), 20, "120 against 100 is +20 people");
  });

  test("a day's several services are ONE point, at the day's total", () => {
    // The tile leads with what the chart LINE ends at, so the two halves of the
    // card quote the same number. Four Sundays of 1,000 + 500 + 800, then one of
    // 1,200 + 600 + 900.
    const older = sundays("weekend", 4, [1000, 500, 800]);
    const newer = sundays("weekend", 1, [1200, 600, 900]).map((r, i) => ({
      ...r,
      serviceKey: `later:${i}`,
      serviceDate: new Date(Date.parse(`${r.serviceDate}T00:00:00Z`) + 28 * DAY).toISOString().slice(0, 10),
      t: r.t + 28 * DAY,
    }));
    const [tile] = typeTrends([...older, ...newer]);
    assert.deepEqual(tile.recent.map((d) => d.v), [2300, 2300, 2300, 2300, 2700], "five DAYS, not fifteen recordings");
    assert.equal(tile.latest, 2700, "the latest day's total, not its busiest service");
    assert.equal(tile.priorAverage, 2300);
    assert.equal(tile.priorCount, 4);
    assert.equal(delta(tile), 400, "2,700 against 2,300");
  });

  test("the SPARKLINE's window does not clip the change, whatever the range is", () => {
    // Two different bounds, and only one of them applies to the basis. The
    // sparkline holds eight days; the comparison holds every day in the RANGE
    // — all of them here, since this call passes no range.
    // Eleven Sundays at 100 then one at 200: bounded by the sparkline's window
    // the basis would be seven days of 100 and identical, so the fixture is
    // built to tell the two apart — 11 prior days is the answer only an
    // unclipped basis gives.
    const [tile] = typeTrends(weekly("weekend", [...Array(11).fill(100), 200]));
    assert.equal(tile.recent.length, TREND_WINDOW, "the sparkline still draws a window");
    assert.equal(tile.latest, 200);
    assert.equal(tile.priorCount, 11, "the basis was clipped to the sparkline's window");
    assert.equal(tile.priorAverage, 100);
    assert.equal(delta(tile), 100, "200 against 100 is +100");
  });

  test("it compares against the prior days it HAS, once there are three", () => {
    // Below MIN_PRIOR_DAYS the "average" is one or two readings and a change off
    // them is noise wearing a direction.
    // One line per case, so two branches adding different ones merge cleanly.
    const at = (n: number) => {
      const [tile] = typeTrends(weekly("weekend", Array(n).fill(100)));
      return [n, delta(tile), tile.priorCount, tile.priorAverage];
    };
    assert.deepEqual(
      [1, 2, 3, 4, 8, 9, 20].map(at),
      [
        [1, null, 0, null],
        [2, null, 0, null],
        // Two prior days is not an average.
        [3, null, 0, null],
        // Four days is the first history that compares: the latest, and three
        // before it.
        [4, 0, 3, 100],
        // And from there it keeps every prior day, however long the history —
        // the sparkline's window bounds the drawing, not the arithmetic.
        [8, 0, 7, 100],
        [9, 0, 8, 100],
        [20, 0, 19, 100],
      ],
    );
  });

  test("a prior average of zero is no comparison, and says so in both fields", () => {
    // `change` already refused to divide by it. `priorCount` did not, so a tile
    // could read "no prior window yet" beside a count of 4 — a label for a
    // comparison that was never made. One condition, read by both.
    const [tile] = typeTrends(weekly("weekend", [...Array(4).fill(0), 150]));
    assert.equal(tile.priorAverage, 0, "the window is there and its average really is zero");
    assert.equal(delta(tile), null, "a zero prior window is not something to compare against");
    assert.equal(tile.priorCount, 0, "so nothing was compared against, and the label must not claim otherwise");
  });

  test("a thin comparison reports the count it actually used", () => {
    // The label reads "vs prior 3". It must be the REAL number, not the window
    // the tile would like to have had.
    const [tile] = typeTrends(weekly("weekend", [...Array(3).fill(100), 150]));
    assert.equal(tile.priorCount, 3);
    assert.equal(tile.priorAverage, 100);
    assert.equal(tile.latest, 150);
    assert.equal(delta(tile), 50, "150 against 100 is +50");
  });

  test("the floor and the window are where their constants say, not numbers typed twice", () => {
    // Pins both constants to the behaviour, so moving one moves both.
    const below = typeTrends(weekly("weekend", Array(MIN_PRIOR_DAYS).fill(100)))[0];
    const atFloor = typeTrends(weekly("weekend", Array(MIN_PRIOR_DAYS + 1).fill(100)))[0];
    assert.equal(delta(below), null);
    assert.equal(delta(atFloor), 0);
    assert.equal(atFloor.priorCount, MIN_PRIOR_DAYS);
    // TREND_WINDOW bounds the SPARKLINE and nothing else: the basis keeps every
    // prior day, which here is one short of three windows.
    const long = typeTrends(weekly("weekend", Array(TREND_WINDOW * 3).fill(100)))[0];
    assert.equal(long.recent.length, TREND_WINDOW);
    assert.equal(long.priorCount, TREND_WINDOW * 3 - 1);
  });

  test("a type with one recorded day shows no change at all", () => {
    // The bug this forbids is a change computed from an EMPTY prior window:
    // dividing by a mean of nothing gives Infinity or NaN, and a tile reading
    // "+Infinity" on a church's first recorded Sunday is worse than a tile that
    // says it cannot tell yet.
    const [one] = typeTrends(weekly("weekend", [250]));
    assert.equal(one.latest, 250, "one recorded day still has a figure — itself");
    assert.equal(delta(one), null, "with nothing before it, there is no change to show");
    assert.equal(one.priorCount, 0);
    assert.deepEqual(typeTrends([]), [], "no recordings at all is no tile, not an empty one");
  });

  test("a recording with no attendance record is not plotted as zero", () => {
    // A service nobody counted is not a service of nobody.
    const [tile] = typeTrends(weekly("weekend", [100, null, 120]));
    assert.deepEqual(tile.recent.map((d) => d.v), [100, 120]);
    assert.equal(tile.latest, 120);
  });

  test("one tile per service type, ordered by the figure the tile SHOWS", () => {
    const tiles = typeTrends([...weekly("evening", [90, 95]), ...weekly("weekend", [800, 820])]);
    assert.deepEqual(tiles.map((t) => t.serviceTypeId), ["weekend", "evening"]);
  });

  test("the order follows the LATEST day, not an average across the window", () => {
    // The two rules disagree on this fixture: weekend averages 1,000 against
    // evening's 375, and evening's latest day is 1,200 against weekend's 1,000.
    // The tile shows the latest day, so the order has to follow that — a tile
    // reading 380 above one reading 3,541 gives no account of itself. The
    // ordinary fixture above has both rules agreeing and cannot tell them apart.
    const tiles = typeTrends([
      ...weekly("weekend", Array(4).fill(1000)),
      ...weekly("evening", [100, 100, 100, 1200]),
    ]);
    assert.deepEqual(
      tiles.map((t) => [t.serviceTypeId, t.latest]),
      [["evening", 1200], ["weekend", 1000]],
      "the tiles are ordered by something other than the number on them",
    );
  });

});

describe("one Sunday morning, in its three states", () => {
  /**
   * Six finished Sundays of 1,000 + 500 + 800, then a seventh part way through.
   *
   * The three slices differ deliberately: first-one is 1,000, first-two is
   * 1,500, and a whole day is 2,300 — so a comparison taken at the wrong one
   * cannot come out right by accident.
   *
   * `done` is how many of the seventh's services have ENDED; `running` puts the
   * next one on air. Anything after that has no record, because a service that
   * has not started has not recorded anything.
   */
  function sunday(done: number, running: boolean): TrendRecording[] {
    const older = sundays("weekend", 6, [1000, 500, 800]);
    const newer = sundays("weekend", 7, [1100, 600, 900], { done, running })
      .filter((r) => r.serviceKey.startsWith("weekend:6:"));
    return [...older, ...newer];
  }

  /** The clock for that seventh Sunday: three services on the plan, `at` running. */
  const clock = (at: number) => sundayClock(7, 3, at);

  test("SERVICE TWO OF THREE RUNNING counts it, against prior days' first TWO", () => {
    // N is services STARTED, not services finished, so the day climbs while the
    // second service fills instead of sitting flat on the first.
    //
    // A whole-day basis here would show a deficit that CANNOT close: the third
    // service has not run at all. Every Sunday would read as the church halving
    // until the evening service ended, which is the defect this rule exists for.
    const [tile] = typeTrends(sunday(1, true), { clock: clock(1) });
    assert.equal(tile.state, "earlier-services");
    assert.equal(tile.serviceCount, 2, "the service on air is not counted");
    assert.equal(tile.latest, 1700, "1,100 finished + the 600 in the room now");
    assert.equal(tile.priorAverage, 1500, "the basis is not the prior days' first TWO");
    assert.equal(delta(tile), 200, "1,700 against 1,500");
    assert.equal(tile.priorCount, 6);
  });

  test("and the comparison CLOSES as that service fills, rather than diverging", () => {
    // The claim the first-N basis rests on: today's partly-filled service N
    // climbs toward the average of prior days' COMPLETE first N and lands near
    // it. If the basis were prior days' whole totals the gap would widen all
    // morning instead — this is the guard on which of the two is in use.
    //
    // Prior first-two is 1,500. Today's first service finished at 1,100, so the
    // second filling 0 -> 600 walks the change from -400 to +200.
    const filling = (peak: number) =>
      sunday(1, true).map((r) =>
        r.serviceKey === "weekend:6:1" ? { ...r, peakOccupancy: peak } : r,
      );
    const deltas = [0, 150, 300, 450, 600].map((peak) => delta(typeTrends(filling(peak), { clock: clock(1) })[0]));
    assert.deepEqual(deltas, [-400, -250, -100, 50, 200]);
    // Strictly closing, never widening — the shape, not just the endpoints.
    assert.deepEqual(
      deltas.filter((d, i) => i > 0 && Math.abs(d) > Math.abs(deltas[i - 1]) && deltas[i - 1] < 0),
      [],
      `the gap widened as the room filled: ${JSON.stringify(deltas)}`,
    );
  });

  test("BETWEEN services, with one still to come, is the same rule", () => {
    // Nothing is on air and the day is not over. Two finished, third to come.
    const [tile] = typeTrends(sunday(2, false), { clock: clock(1) });
    assert.equal(tile.state, "earlier-services");
    assert.equal(tile.serviceCount, 2);
    assert.equal(tile.latest, 1700, "1,100 + 600");
    assert.equal(tile.priorAverage, 1500, "1,000 + 500");
    assert.equal(delta(tile), 200);
  });

  test("nothing jumps when an EARLIER service ends either", () => {
    // The second service full at 600 and the second service ended at 600 are
    // the same day to this: the only difference is which array the value sits
    // in. A jump here would be the staircase the live count exists to remove.
    const live = typeTrends(sunday(1, true), { clock: clock(1) })[0];
    const ended = typeTrends(sunday(2, false), { clock: clock(1) })[0];
    assert.deepEqual(
      [live.latest, live.serviceCount, live.priorAverage, live.priorCount],
      [ended.latest, ended.serviceCount, ended.priorAverage, ended.priorCount],
      "the tile moved when service two ended",
    );
    // What DOES change: the day stops being drawn dashed only when the DAY ends,
    // not when a service does.
    assert.equal(live.state, ended.state, "the state changed when a service ended");
  });

  test("THE LAST SERVICE RUNNING counts it live, against whole days", () => {
    // The figure includes the service on air, climbing as the room fills, and
    // the basis switches to prior completed days' full totals: a "how are we
    // tracking" number that reads as a deficit closing through the hour.
    const [tile] = typeTrends(sunday(2, true), { clock: clock(2) });
    assert.equal(tile.state, "last-service-live");
    assert.equal(tile.serviceCount, 3, "the running service is not counted");
    assert.equal(tile.latest, 2600, "1,100 + 600 + the 900 still in the room");
    assert.equal(tile.priorAverage, 2300, "the basis is not prior days' whole totals");
    assert.equal(delta(tile), 300);
  });

  test("and the figure and its basis do not JUMP when that service ends", () => {
    // Deliberate continuity: only the dash and the provisional node go away.
    const live = typeTrends(sunday(2, true), { clock: clock(2) })[0];
    const done = typeTrends(sunday(3, false), { clock: clock(3) })[0];
    assert.equal(done.state, "finished");
    assert.deepEqual(
      [done.latest, done.priorAverage, done.priorCount],
      [live.latest, live.priorAverage, live.priorCount],
      "the tile moved when the last service ended",
    );
  });

  test("the FIRST service of three, on air, already builds the day", () => {
    // It used to read last Sunday all morning until a service ended. A day that
    // shows nothing until 10:30 is not a day building.
    const [tile] = typeTrends(sunday(0, true), { clock: clock(0) });
    assert.equal(tile.state, "earlier-services");
    assert.equal(tile.latestDate, "2026-02-15", "the tile is still dated last Sunday");
    assert.equal(tile.serviceCount, 1, "one service started");
    assert.equal(tile.latest, 1100, "the room right now");
    assert.equal(tile.priorAverage, 1000, "against prior days' FIRST service");
    assert.equal(delta(tile), 100);
  });

  test("a morning with no READING yet still falls back to the last day that had one", () => {
    // The fallback that remains, and the only one that can: a counter that has
    // not reported. A service on air with no figure is not a service of nobody,
    // so the day is not drawn at zero — the tile shows last Sunday and dates
    // itself to it.
    const blind = sunday(0, true).map((r) =>
      r.serviceKey === "weekend:6:0" ? { ...r, peakOccupancy: null } : r,
    );
    const [tile] = typeTrends(blind, { clock: clock(0) });
    assert.equal(tile.state, "finished", "it is showing a day that is still going");
    assert.equal(tile.latest, 2300, "the tile is showing the unfinished morning");
    assert.equal(tile.latestDate, "2026-02-08", "the tile is dated the day it is not showing");
    assert.equal(delta(tile), 0, "six identical prior Sundays, so no change");
  });

  test("FIVE services work, and nothing here knows the number three", () => {
    // N comes from the data. A church running five must work with no code
    // change, and one that adds a sixth gets it the first Sunday it finishes.
    const five = [400, 500, 600, 700, 800];
    const older = sundays("weekend", 5, five);
    const newer = sundays("weekend", 6, [450, 550, 650, 750, 850], { done: 3, running: true })
      .filter((r) => r.serviceKey.startsWith("weekend:5:"));
    const [tile] = typeTrends([...older, ...newer], { clock: sundayClock(6, 5, 3) });
    assert.equal(tile.state, "earlier-services", "the fifth service is still to come");
    assert.equal(tile.serviceCount, 4, "three finished and a fourth on air");
    assert.equal(tile.latest, 2400, "450 + 550 + 650 + the 750 in the room now");
    assert.equal(tile.priorAverage, 2200, "400 + 500 + 600 + 700");
    assert.equal(delta(tile), 200);
  });

  test("a prior day that never ran N services is left out of a FIRST-N basis", () => {
    // A Sunday that only ever held two has no third service to offer. Averaging
    // its two into a three-service comparison drags the basis down for a reason
    // that is nothing to do with attendance.
    const three = sundays("weekend", 4, [1000, 500, 800]);
    const oneOnly = sundays("weekend", 1, [1000]).map((r, i) => ({
      ...r,
      serviceKey: `short:${i}`,
      serviceDate: "2026-02-08",
      t: Date.parse("2026-02-08T09:00:00Z") + i * SERVICE_GAP,
    }));
    const latest = sundays("weekend", 1, [1100, 600, 900], { done: 2, running: true }).map((r, i) => ({
      ...r,
      serviceKey: `latest:${i}`,
      serviceDate: "2026-02-15",
      t: Date.parse("2026-02-15T09:00:00Z") + i * SERVICE_GAP,
    }));
    const [tile] = typeTrends([...three, ...oneOnly, ...latest], {
      clock: {
        now: Date.parse("2026-02-15T11:30:00Z"),
        today: "2026-02-15",
        // FOUR on the plan, so the third running is not the day's last and the
        // tile stays on first-N with two finished.
        serviceTimesToday: [0, 1, 2, 3].map((i) => Date.parse("2026-02-15T09:00:00Z") + i * SERVICE_GAP),
      },
    });
    assert.equal(tile.state, "earlier-services");
    assert.equal(tile.serviceCount, 3, "two finished and a third on air");
    assert.equal(tile.priorCount, 4, "the one-service Sunday was counted in a three-service comparison");
    assert.equal(tile.priorAverage, 2300, "a short day dragged the basis down");
  });

  test("a FINISHED two-service day sits in the same average as three-service days", () => {
    // The seasonal case: summer drops to two services and comes back to three in
    // the autumn. A completed two-service Sunday IS a two-service Sunday, and
    // comparing first-twos would hide exactly the change he is looking for.
    const three = sundays("weekend", 4, [1000, 500, 800]);
    const summer = sundays("weekend", 1, [1000, 500]).map((r, i) => ({
      ...r,
      serviceKey: `summer:${i}`,
      serviceDate: "2026-02-08",
      t: Date.parse("2026-02-08T09:00:00Z") + i * SERVICE_GAP,
    }));
    const latest = sundays("weekend", 1, [1000, 500]).map((r, i) => ({
      ...r,
      serviceKey: `latest:${i}`,
      serviceDate: "2026-02-15",
      t: Date.parse("2026-02-15T09:00:00Z") + i * SERVICE_GAP,
    }));
    const [tile] = typeTrends([...three, ...summer, ...latest], {
      clock: { now: Date.parse("2026-02-16T00:00:00Z"), today: "2026-02-16", serviceTimesToday: [] },
    });
    assert.equal(tile.state, "finished");
    assert.equal(tile.latest, 1500, "the day's own two services");
    // Four whole 2,300 days and one whole 1,500 day: (4*2300 + 1500)/5 = 2140.
    assert.equal(tile.priorCount, 5, "a prior day was excluded for running fewer services");
    assert.equal(tile.priorAverage, 2140);
    assert.equal(delta(tile), -640, "the summer drop is visible, which is the point");
  });

  test("SOUND keeps the structure and still never adds", () => {
    // `sundays` gives each service 90, 91, 92 dB in order, so a summed first-two
    // would be 181 and a summed whole day 273.
    const earlier = typeTrends(sunday(1, true), { measure: "sound", clock: clock(1) })[0];
    assert.equal(earlier.state, "earlier-services");
    assert.equal(earlier.latest, 91, "the loudest of the two started, not their sum of 181");
    const live = typeTrends(sunday(2, true), { measure: "sound", clock: clock(2) })[0];
    assert.equal(live.state, "last-service-live");
    assert.equal(live.latest, 92, "the loudest of the day including the one on air");
    assert.equal(live.priorAverage, 92, "the average of prior days' loudest");
    assert.deepEqual(
      [earlier, live].flatMap((t) => t.recent.map((d) => d.v)).filter((v) => v > 120),
      [],
      "a day's level was summed",
    );
  });
});

describe("the range control governs the comparison", () => {
  /** Twenty weekly Sundays, the last one 200 against a steady 100. */
  const rising = () => weekly("weekend", [...Array(19).fill(100), 200]);

  test("a narrower range compares against fewer days, and the count says so", () => {
    // One control for the chart and the tile, so a tile is measured against
    // exactly the days drawn under it.
    const at = (weeks: number | undefined) => {
      const [tile] = typeTrends(rising(), { weeks });
      return [weeks ?? "all", tile.priorCount];
    };
    // One line per range, so two branches adding different ones merge cleanly.
    assert.deepEqual(
      [8, 16, 52, undefined].map(at),
      [
        // Weekly services: eight weeks back from the newest is eight prior days.
        [8, 8],
        [16, 16],
        // Nineteen prior days is the whole history; 52 weeks cannot reach more.
        [52, 19],
        ["all", 19],
      ],
    );
  });

  test("and the basis itself moves, not just the count", () => {
    // A history that was quiet long ago and busy lately: an 8-week basis must
    // not be dragged by days the chart is not drawing.
    // Eleven quiet weeks, then nine busy ones. Eight weeks back from the newest
    // reaches only the busy ones; all time reaches every quiet one too.
    const recs = weekly("weekend", [...Array(11).fill(10), ...Array(9).fill(200)]);
    assert.equal(typeTrends(recs, { weeks: 8 })[0].priorAverage, 200, "old quiet weeks are in an 8-week basis");
    assert.equal(typeTrends(recs, {})[0].priorAverage, 90, "the quiet weeks are missing from the all-time basis");
  });
});

describe("what day it is", () => {
  // THE FAILURE THIS REPO HAS ACTUALLY BEEN BITTEN BY. Most Linux images and
  // every container run UTC, so on a UTC host the calendar date rolls at 19:00
  // in Chicago. Every "is this today?" in the app flipped mid-evening and a live
  // service stopped recording at 7pm on the dot. `trendClock` takes the zone
  // explicitly for that reason, and these run under whatever zone the host has.
  const SUNDAY_EVENING = Date.parse("2026-09-21T01:00:00Z"); // 20:00 Sun 20 in Chicago

  test("the day comes from the APP's zone, not the host's", () => {
    assert.equal(
      trendClock(SUNDAY_EVENING, "America/Chicago").today,
      "2026-09-20",
      "Sunday evening in Chicago was read as Monday",
    );
    assert.equal(trendClock(SUNDAY_EVENING, "UTC").today, "2026-09-21");
    // Not the host's, whichever that is: the two answers above differ, so a
    // reading that ignored the argument could only match one of them.
    assert.notEqual(
      trendClock(SUNDAY_EVENING, "America/Chicago").today,
      trendClock(SUNDAY_EVENING, "UTC").today,
    );
  });

  test("a date before today is finished even if it only ever ran one service", () => {
    // Nothing about a past day depends on how much of it happened.
    const one = sundays("weekend", 5, [900]);
    const [tile] = typeTrends(one, {
      clock: trendClock(Date.parse("2026-09-21T01:00:00Z"), "America/Chicago"),
    });
    assert.equal(tile.state, "finished");
    assert.equal(tile.serviceCount, 1);
  });

  test("today with a service still to come is NOT finished", () => {
    const recs = sundays("weekend", 5, [1000, 500, 800], { done: 2 });
    const day = new Date(FIRST_SUNDAY + 4 * 7 * DAY).toISOString().slice(0, 10);
    const times = [0, 1, 2].map((i) => FIRST_SUNDAY + 4 * 7 * DAY + i * SERVICE_GAP);
    const before = typeTrends(recs, {
      clock: { now: times[1] + 30 * 60_000, today: day, serviceTimesToday: times },
    })[0];
    assert.equal(before.state, "earlier-services", "the third service was treated as already run");
    const after = typeTrends(recs, {
      clock: { now: times[2] + 90 * 60_000, today: day, serviceTimesToday: times },
    })[0];
    assert.equal(after.state, "finished", "the day never finished, even past its last service time");
  });

  test("the zone comes off stage state in the SERVER's order, the browser last", () => {
    // The near miss: `state.timezone ?? <this browser's zone>`. With nothing
    // configured the server falls back to ITS host, not the viewer's, so a UTC
    // box read from a laptop in Chicago had the page ending Sunday five hours
    // before the server did. One case per line.
    assert.deepEqual(
      [
        appZoneOf({ timezone: "America/Denver", hostTimezone: "UTC" }, "America/Chicago"),
        appZoneOf({ timezone: null, hostTimezone: "UTC" }, "America/Chicago"),
        appZoneOf({ timezone: null, hostTimezone: null }, "America/Chicago"),
        appZoneOf(null, "America/Chicago"),
        appZoneOf(undefined, "America/Chicago"),
      ],
      [
        "America/Denver",
        "UTC",
        "America/Chicago",
        "America/Chicago",
        "America/Chicago",
      ],
    );
  });

  test("a rehearsal is not a service still to come", () => {
    // A `time_type: "rehearsal"` at 8am would otherwise hold the tile in its
    // partial-day mode for the whole day.
    const clock = trendClock(Date.parse("2026-09-20T18:00:00Z"), "America/Chicago", [
      { timeType: "rehearsal", startsAt: "2026-09-20T23:00:00Z" },
      { timeType: "service", startsAt: "2026-09-20T14:00:00Z" },
    ]);
    assert.deepEqual(clock.serviceTimesToday, [Date.parse("2026-09-20T14:00:00Z")]);
  });
});

describe("a recording that is still running", () => {
  test("is on the line from ANY position in the day, not only as its last service", () => {
    // The requirement: an in-progress day builds. Counting only the day's last
    // service left the node flat at the completed sum through the morning and
    // stepping when one ended — a staircase, not a day filling.
    const recs = sundays("weekend", 4, [1000, 500, 800], { done: 0, running: true });
    const clock = sundayClock(4, 3, 0);
    const days = dailyValues(recs, "attendance", clock);
    assert.equal(days.length, 4, "the day whose FIRST service is on air is missing from the line");
    assert.equal(days[days.length - 1].v, 1000, "the node is not the room right now");
    assert.equal(days[days.length - 1].provisional, true, "the node is not marked as still moving");
    // The recording has to reach the chart at all, which is `withinRange`'s job.
    assert.equal(withinRange(recs, 52).length, 10, "the running recording was dropped before the chart saw it");
    const [tile] = typeTrends(recs, { clock });
    assert.equal(tile.recent.length, 4, "an unfinished day is off the sparkline");
    assert.equal(tile.latestDate, "2026-01-25", "the tile is not dated the day being built");
  });

  test("but the day's LAST service is, and its node says it is provisional", () => {
    const recs = sundays("weekend", 4, [1000, 500, 800], { done: 2, running: true });
    const days = dailyValues(recs, "attendance", sundayClock(4, 3, 2));
    assert.equal(days.length, 4, "the day on air is missing from the line");
    const last = days[days.length - 1];
    assert.equal(last.v, 2300, "the node does not count the service on air");
    assert.equal(last.provisional, true, "the node is not marked as still moving");
    assert.deepEqual(days.slice(0, -1).map((d) => d.provisional), [false, false, false]);
  });

  test("a day with EARLIER services still to run is provisional too", () => {
    // Driven in Chrome and it is why this exists: with one of three services
    // done the line plunged from ~3,500 to 1,252 in a solid stroke, drawing
    // exactly the collapse the tile beside it spends its whole label denying.
    // Provisional is "not final", not "climbing" — the two differ in whether a
    // live value is counted, not in whether the day is over.
    const recs = sundays("weekend", 4, [1000, 500, 800], { done: 1, running: true });
    const days = dailyValues(recs, "attendance", sundayClock(4, 3, 1));
    const last = days[days.length - 1];
    assert.equal(last.v, 1500, "1,000 finished plus the 500 in the room now");
    assert.equal(last.provisional, true, "the line into a part-finished day draws solid");
    assert.deepEqual(days.slice(0, -1).map((d) => d.provisional), [false, false, false]);
  });
});


describe("milestones", () => {
  test("one mark per series change, and none for the first series", () => {
    // A, A, B, B, C — two changes. The leading A is not a change: there is
    // nothing it changed from.
    const recs = weekly("weekend", [100, 100, 100, 100, 100], {
      series: ["Rooted", "Rooted", "Everyday", "Everyday", "Advent"],
    });
    const marks = seriesChangeMilestones(recs);
    assert.deepEqual(
      marks.map((m) => m.label),
      ["Everyday", "Advent"],
    );
    assert.deepEqual(marks.map((m) => m.t), [recs[2].t, recs[4].t], "each mark sits on the first recording of the new series");
    assert.deepEqual(new Set(marks.map((m) => m.kind)), new Set(["series"]));
  });

  test("a recording with no series title is an absence, not two changes", () => {
    // Without stepping over it, the untitled plan in the middle produces a mark
    // leaving Rooted and another arriving back at it.
    const recs = weekly("weekend", [100, 100, 100], { series: ["Rooted", null, "Rooted"] });
    assert.deepEqual(seriesChangeMilestones(recs), []);
  });

  test("two service types do not mark each other's series changes", () => {
    const recs = [
      ...weekly("weekend", [100, 100], { series: ["Rooted", "Everyday"] }),
      ...weekly("evening", [50, 50], { series: ["Kickoff", "Kickoff"] }),
    ];
    const marks = seriesChangeMilestones(recs);
    assert.deepEqual(marks.map((m) => [m.serviceTypeId, m.label]), [["weekend", "Everyday"]]);
  });

  test("a stored entry with a bad date is skipped, and the rest are drawn", () => {
    const recs = weekly("weekend", [100, 100, 100]);
    // The domain deliberately runs on past the bad dates, so the only thing
    // that can reject them is the rule. An end at the last recording would have
    // clipped "2026-02-31" (which parses, and lands on the 2nd of March) for
    // the wrong reason, and the guard would have passed on the bug.
    const domain = { startMs: recs[0].t - DAY, endMs: recs[2].t + 120 * DAY };
    const marks = trendMilestones(
      [
        { id: "good", date: recs[1].serviceDate, label: "New building", serviceTypeId: null },
        // The 31st of February parses in JavaScript and lands on 2 or 3 March.
        { id: "bad", date: "2026-02-31", label: "Two services", serviceTypeId: null },
        { id: "junk", date: "whenever", label: "Kickoff", serviceTypeId: null },
      ],
      recs,
      domain,
    );
    assert.deepEqual(
      marks.map((m) => m.label),
      ["New building"],
      "an entry whose date cannot be read must not be drawn at the left edge, where it would mean a date it does not",
    );
  });

  test("a stored milestone keeps the service type it was scoped to", () => {
    // The field was stored, documented, and dropped on the way to the chart, so
    // a mark scoped to the Youth service drew across the Weekend line. It is
    // what the chart scopes and colours the mark by; losing it here loses both.
    const recs = weekly("weekend", [100, 100]);
    const marks = trendMilestones(
      [
        { id: "scoped", date: recs[0].serviceDate, label: "Youth moved", serviceTypeId: "youth" },
        { id: "all", date: recs[1].serviceDate, label: "New building", serviceTypeId: null },
      ],
      recs,
      { startMs: recs[0].t - DAY, endMs: recs[1].t + DAY },
    );
    assert.deepEqual(
      marks.map((m) => [m.label, m.serviceTypeId]),
      [["Youth moved", "youth"], ["New building", null]],
    );
  });

  test("a mark outside the drawn range is clipped, not squeezed onto an edge", () => {
    const recs = weekly("weekend", [100, 100]);
    const marks = trendMilestones(
      [{ id: "old", date: "2020-01-01", label: "Old building", serviceTypeId: null }],
      recs,
      { startMs: recs[0].t, endMs: recs[1].t },
    );
    assert.deepEqual(marks, []);
  });
});

describe("the range control", () => {
  test("the range is measured back from the newest recording, not from the clock", () => {
    // A history that stopped in June must still draw when it is opened in
    // September, rather than showing an empty chart.
    const long = weekly("weekend", Array(60).fill(100), { from: Date.parse("2024-01-07T09:00:00Z") });
    const eight = withinRange(long, 8);
    const fiftyTwo = withinRange(long, 52);
    assert.ok(eight.length > 0, "a range measured from the clock would return nothing here");
    assert.ok(eight.length <= 9, `8 weeks of weekly services is ~9 recordings, got ${eight.length}`);
    assert.ok(fiftyTwo.length > eight.length, "a longer range must include more");
    assert.equal(eight[eight.length - 1].t, long[long.length - 1].t, "the newest recording is always in range");
  });
});

describe("the sound measure", () => {
  test("the tiles read decibels, with the same window and the same change rule", () => {
    const [tile] = typeTrends(
      weekly("weekend", Array(4).fill(500), { db: [94, 94, 94, 100] }),
      { measure: "sound" },
    );
    assert.equal(tile.latest, 100);
    assert.equal(tile.priorAverage, 94);
    assert.equal(tile.priorCount, MIN_PRIOR_DAYS, "the relaxed floor applies to sound too");
    assert.equal(delta(tile), 6);
  });

  test("A TILE'S LEVEL IS ONE RECORDING'S, whatever a day's traffic", () => {
    // The other half of the day-total change, at the tile: eight Sundays of
    // three services, each at 96/99/104. Every figure the tile prints must stay
    // inside the range a meter reads, not climb with the number of services.
    const recs = sundays("weekend", 8, [1400, 700, 1100]).map((r, i) => ({
      ...r,
      peakDb: [96, 99, 104][i % 3],
    }));
    const [tile] = typeTrends(recs, { measure: "sound" });
    assert.equal(tile.latest, 104);
    assert.equal(tile.priorAverage, 104);
    assert.deepEqual(
      tile.recent.map((d) => d.v).filter((v) => v > 120),
      [],
      `the tile added a day's levels together: ${tile.recent.map((d) => d.v).join(", ")} dB`,
    );
  });

  test("a type with no SPL records keeps its tile, with nothing in it", () => {
    // Dropping it would read as the service type having disappeared the moment
    // you switched measure. The tile stays and the card says "no sound
    // recorded" against a null figure.
    const tiles = typeTrends(
      [
        ...weekly("weekend", Array(3).fill(900), { db: Array(3).fill(101) }),
        ...weekly("evening", Array(3).fill(200)),
      ],
      { measure: "sound" },
    );
    assert.deepEqual(
      tiles.map((t) => [t.serviceTypeId, t.latest]),
      [["weekend", 101], ["evening", null]],
      "a type with no level must keep its tile and sort last",
    );
    assert.deepEqual(tiles.find((t) => t.serviceTypeId === "evening")!.recent, []);
  });

  test("no recordings at all is still no tile, under either measure", () => {
    assert.deepEqual(typeTrends([], { measure: "sound" }), []);
    assert.deepEqual(typeTrends([], { measure: "attendance" }), []);
  });

  test("the range filters on the measure being plotted", () => {
    // A recording with attendance and no level is in range for one measure and
    // not the other. Filtering on attendance while plotting sound put an
    // undefined into the series.
    const recs = weekly("weekend", [100, 100, 100], { db: [null, 97, null] });
    assert.equal(withinRange(recs, 52, "attendance").length, 3);
    assert.deepEqual(
      withinRange(recs, 52, "sound").map((r) => r.peakDb),
      [97],
    );
  });
});

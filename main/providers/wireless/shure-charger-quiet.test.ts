// A healthy charger must be SILENT.
//
// Observed on the production log: `storage mode off` and `bay N fault cleared`
// for eight bays, every eight seconds, from a charger with nothing wrong with
// it. Between them they were most of what /log held.
//
// Driven from the bytes for the reason shure-charger-fields.test.ts gives: a
// device-level field is `REP {FIELD} {value}` with no channel token, and a test
// that called the handler directly would pass on a driver that never reaches the
// case.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ShureAxient } from "./shure-axient.js";
import { ShureCharger } from "./shure-charger.js";
import { ShurePsm } from "./shure-psm.js";
import { ShureUlxd } from "./shure-ulxd.js";

interface Inner {
  initChannelStates(count: number): void;
  handleData(chunk: string): void;
  cfg: { host: string; port: number; channels: number; meterRateMs: number };
}

/** Wire any Shure driver up with the console captured, and feed it raw frames. */
function driver(provider: object): { lines: string[]; feed: (...frames: string[]) => void; reinit: () => void } {
  const inner = provider as unknown as Inner;
  inner.cfg = { host: "", port: 2202, channels: 8, meterRateMs: 1000 };
  inner.initChannelStates(8);

  const lines: string[] = [];
  const realLog = console.log;
  const realWarn = console.warn;
  const push = (...args: unknown[]) => lines.push(args.map(String).join(" "));

  const feed = (...frames: string[]) => {
    console.log = push;
    console.warn = push;
    try {
      for (const f of frames) inner.handleData(f);
    } finally {
      console.log = realLog;
      console.warn = realWarn;
    }
  };
  return { lines, feed, reinit: () => inner.initChannelStates(8) };
}

/** A charger with the console captured. `reinit` re-runs initChannelStates, which
 *  is what a reconnect does. */
function charger(): { lines: string[]; feed: (...frames: string[]) => void; reinit: () => void } {
  return driver(new ShureCharger());
}

const storage = (v: string) => `< REP STORAGE_MODE ${v} >`;

/** A healthy bay's slice of a real `GET 0 ALL` dump. */
const healthy = (bay: number) => [
  `< REP ${bay} BATT_DETECTED YES >`,
  `< REP ${bay} BATT_STATE CHARGING >`,
  `< REP ${bay} BATT_CHARGE 072 >`,
  `< REP ${bay} BATT_ERROR 000 >`,
];

describe("storage mode", () => {
  it("logs the first report and then stays quiet on identical ones", () => {
    // GUARD. There was no change gate at all: every STORAGE_MODE report logged.
    const c = charger();
    c.feed(storage("OFF"));
    c.feed(storage("OFF"));
    c.feed(storage("OFF"));

    const said = c.lines.filter((l) => l.includes("storage mode"));
    assert.equal(
      said.length,
      1,
      `three identical STORAGE_MODE reports wrote ${said.length} lines:\n  ${said.join("\n  ")}`,
    );
  });

  it("but a real change is news", () => {
    const c = charger();
    c.feed(storage("OFF"));
    c.feed(storage("ON"));
    c.feed(storage("ON"));

    const said = c.lines.filter((l) => l.includes("storage mode"));
    assert.equal(said.length, 2, `expected one line per change, got:\n  ${said.join("\n  ")}`);
    assert.match(said[1]!, /storage mode ON/);
  });
});

describe("bay faults", () => {
  it("a bay that has never been faulted says nothing when it reports healthy", () => {
    // GUARD. The gate compared `loggedFaults.get(bay)` (undefined for a bay never
    // seen) against `fault ?? ""` (the empty string when healthy). Those differ,
    // so the FIRST healthy observation of every bay printed "fault cleared".
    const c = charger();
    c.feed(...healthy(1), ...healthy(2));

    const said = c.lines.filter((l) => l.includes("fault cleared"));
    assert.deepEqual(said, [], `a healthy charger announced fault clearances:\n  ${said.join("\n  ")}`);
  });

  it("and stays quiet after a reconnect re-inits the bays", () => {
    const c = charger();
    c.feed(...healthy(1));
    c.reinit();
    c.feed(...healthy(1));

    const said = c.lines.filter((l) => l.includes("fault cleared"));
    assert.deepEqual(said, [], `re-init made every healthy bay news again:\n  ${said.join("\n  ")}`);
  });

  it("a real fault, then its clearance, is two lines", () => {
    const c = charger();
    c.feed(
      "< REP 7 BATT_DETECTED YES >",
      "< REP 7 BATT_STATE ERROR >",
      "< REP 7 BATT_ERROR 007 >",
    );
    c.feed("< REP 7 BATT_STATE CHARGING >", "< REP 7 BATT_ERROR 000 >");

    const faulted = c.lines.filter((l) => l.includes("bay 7 faulted"));
    const cleared = c.lines.filter((l) => l.includes("bay 7 fault cleared"));
    assert.equal(faulted.length, 1, `expected one fault line, got:\n  ${faulted.join("\n  ")}`);
    assert.equal(cleared.length, 1, `expected one clearance line, got:\n  ${cleared.join("\n  ")}`);
  });

  it("a fault that persists across polls is logged once", () => {
    const c = charger();
    const faulted = ["< REP 7 BATT_DETECTED YES >", "< REP 7 BATT_STATE ERROR >", "< REP 7 BATT_ERROR 007 >"];
    c.feed(...faulted);
    c.feed(...faulted);
    c.feed(...faulted);

    const said = c.lines.filter((l) => l.includes("bay 7 faulted"));
    assert.equal(said.length, 1, `a dead pack left in the charger reprinted:\n  ${said.join("\n  ")}`);
  });
});

// CHAN_NAME is the same shape as STORAGE_MODE — a field in every `GET 0 ALL`
// dump that was logged unconditionally — and it is copied into all three
// receiver drivers. Covered together so the copies cannot drift apart again.
describe("channel names are logged on change, not on every dump", () => {
  const DRIVERS: ReadonlyArray<readonly [string, () => object]> = [
    ["ULX-D", () => new ShureUlxd()],
    ["Axient", () => new ShureAxient()],
    ["PSM", () => new ShurePsm()],
  ];

  for (const [label, make] of DRIVERS) {
    it(`${label} repeats a name it has already announced only when it changes`, () => {
      const d = driver(make());
      d.feed("< REP 1 CHAN_NAME {PASTOR} >");
      d.feed("< REP 1 CHAN_NAME {PASTOR} >");
      d.feed("< REP 1 CHAN_NAME {PASTOR} >");

      const said = d.lines.filter((l) => l.includes("ch1 name:"));
      assert.equal(said.length, 1, `${label} reprints the name every poll:\n  ${said.join("\n  ")}`);

      d.feed("< REP 1 CHAN_NAME {WORSHIP} >");
      assert.equal(
        d.lines.filter((l) => l.includes("ch1 name:")).length,
        2,
        `${label} went quiet on a REAL rename`,
      );
    });
  }
});

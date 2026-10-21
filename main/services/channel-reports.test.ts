// The bounds on reported channel filters, driven with a clock.
//
// POST /api/events/subscribe stored a filter for any cid, forever: 5,000
// requests with made-up cids left 49 MB resident. A report nothing claims now
// waits a minute at most, and at most 256 wait at once. The route that feeds
// this is driven through the real handler in remote-server-subscribe.test.ts.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  ChannelReports,
  MAX_CHANNEL_LENGTH,
  MAX_CHANNELS,
  MAX_CID_LENGTH,
  MAX_UNCLAIMED,
  UNCLAIMED_TTL_MS,
} from "./channel-reports.js";

let clock = 0;
let reports: ChannelReports;
let logged: string[] = [];
const realLog = console.log;

beforeEach(() => {
  clock = 1_000_000;
  reports = new ChannelReports({ now: () => clock });
  logged = [];
  console.log = (...args: unknown[]) => void logged.push(args.join(" "));
});

afterEach(() => {
  console.log = realLog;
});

describe("a report nothing claims", () => {
  test("is gone once it has waited a minute", () => {
    reports.report("early", ["pco:live"]);
    clock += UNCLAIMED_TTL_MS - 1;
    reports.expire();
    assert.deepEqual([...(reports.get("early") ?? [])], ["pco:live"], "dropped before the wait was up");
    clock += 2;
    reports.expire();
    assert.equal(reports.get("early"), undefined, "an unclaimed report outlived the wait");
    assert.equal(reports.size, 0);
  });

  test("is dropped by the next report too, so nothing needs a timer", () => {
    reports.report("early", ["pco:live"]);
    clock += UNCLAIMED_TTL_MS + 1;
    reports.report("later", ["spl:metrics"]);
    assert.equal(reports.get("early"), undefined);
    assert.ok(reports.get("later"));
  });

  test(`is one of at most ${MAX_UNCLAIMED} waiting at once, and the oldest goes first`, () => {
    for (let i = 0; i < 1000; i++) reports.report(`made-up-${i}`, ["pco:live"]);
    assert.equal(reports.unclaimedCount, MAX_UNCLAIMED);
    assert.equal(reports.size, MAX_UNCLAIMED, "the filters map grew past the unclaimed cap");
    assert.equal(reports.get("made-up-0"), undefined, "the oldest report should have gone first");
    assert.ok(reports.get("made-up-999"), "the newest report should still wait");
  });

  test("a repeat report waits from its own arrival, not the first one's", () => {
    reports.report("again", ["pco:live"]);
    clock += UNCLAIMED_TTL_MS - 10;
    reports.report("again", ["pco:live", "spl:metrics"]);
    clock += 20;
    reports.expire();
    assert.deepEqual([...(reports.get("again") ?? [])], ["pco:live", "spl:metrics"]);
  });
});

describe("a claimed report", () => {
  test("stays however long its connection does", () => {
    reports.claim("display", "stream");
    reports.report("display", ["pco:live"]);
    clock += 10 * UNCLAIMED_TTL_MS;
    for (let i = 0; i < MAX_UNCLAIMED * 2; i++) reports.report(`made-up-${i}`, []);
    assert.deepEqual([...(reports.get("display") ?? [])], ["pco:live"]);
  });

  test("that arrived before its stream is kept once the stream claims it", () => {
    // The shared worker posts its report as it opens its EventSource.
    reports.report("worker", ["pco:live"]);
    clock += 100;
    reports.claim("worker", "stream");
    clock += 10 * UNCLAIMED_TTL_MS;
    reports.expire();
    assert.ok(reports.get("worker"), "the stream's own filter was dropped as unclaimed");
  });

  test("goes when its connection does", () => {
    reports.claim("display", "stream");
    reports.report("display", ["pco:live"]);
    reports.release("display", "stream");
    assert.equal(reports.get("display"), undefined);
    // And a later report under that cid waits like any other.
    reports.report("display", ["pco:live"]);
    assert.equal(reports.unclaimedCount, 1);
  });

  test("survives a reconnect whose new stream opens before the old one's close is seen", () => {
    const oldStream = {};
    const newStream = {};
    reports.claim("display", oldStream);
    reports.report("display", ["pco:live"]);
    reports.claim("display", newStream);
    reports.release("display", oldStream);
    assert.deepEqual([...(reports.get("display") ?? [])], ["pco:live"], "the old stream's close took the new stream's report");
    // Still claimed: a re-report does not start a 60s wait, and a flood cannot evict it.
    reports.report("display", ["pco:live", "spl:metrics"]);
    assert.equal(reports.unclaimedCount, 0);
    clock += 10 * UNCLAIMED_TTL_MS;
    for (let i = 0; i < MAX_UNCLAIMED + 1; i++) reports.report(`made-up-${i}`, []);
    assert.ok(reports.get("display"));
    reports.release("display", newStream);
    assert.equal(reports.get("display"), undefined, "the report outlived its last connection");
  });

  test("a holder claiming twice is one claim", () => {
    reports.claim("panel", "poll");
    reports.claim("panel", "poll");
    reports.report("panel", ["pco:live"]);
    reports.release("panel", "poll");
    assert.equal(reports.get("panel"), undefined);
  });
});

describe("what a report may carry", () => {
  test("a missing cid or channel list changes nothing and is not an error", () => {
    assert.deepEqual(reports.report(undefined, ["pco:live"]), { stored: false });
    assert.deepEqual(reports.report(42, ["pco:live"]), { stored: false });
    assert.deepEqual(reports.report("a", "pco:live"), { stored: false });
    assert.equal(reports.size, 0);
  });

  test("a cid no client mints is refused", () => {
    for (const cid of ["", "x".repeat(MAX_CID_LENGTH + 1)]) {
      const r = reports.report(cid, ["pco:live"]);
      assert.equal(r.stored, false);
      assert.match((r as { error?: string }).error ?? "", /cid/);
    }
    assert.equal(reports.report("x".repeat(MAX_CID_LENGTH), []).stored, true, "the longest allowed cid is refused");
  });

  test(`more than ${MAX_CHANNELS} channels, or a name past ${MAX_CHANNEL_LENGTH} characters, is refused whole`, () => {
    const many = Array.from({ length: MAX_CHANNELS + 1 }, (_, i) => `c${i}`);
    assert.equal(reports.report("a", many).stored, false);
    assert.equal(reports.report("a", many.slice(0, MAX_CHANNELS)).stored, true);
    assert.equal(reports.report("b", ["x".repeat(MAX_CHANNEL_LENGTH + 1)]).stored, false);
    assert.equal(reports.get("b"), undefined);
  });

  test("entries that are not text are left out, as they always were", () => {
    reports.report("a", ["pco:live", 7, null, { channel: "x" }]);
    assert.deepEqual([...(reports.get("a") ?? [])], ["pco:live"]);
  });
});

test("the first drop is logged at once, and the rest as one count a minute", () => {
  for (let i = 0; i < MAX_UNCLAIMED + 44; i++) reports.report(`flood-${i}`, []);
  assert.equal(logged.length, 1, logged.join("\n"));
  assert.match(logged[0]!, /^\[events\] dropped 1 channel report that no stream or poll client claimed/);

  for (let i = 0; i < 100; i++) reports.report(`more-${i}`, []);
  assert.equal(logged.length, 1, "a second line inside the same minute");

  clock += 60_000;
  reports.report("after", []);
  assert.equal(logged.length, 2);
  // 43 more pushed out by the first burst and 100 by the second, then the 256
  // still waiting, which have now waited the whole minute.
  assert.match(logged[1]!, /dropped 399 channel reports/);
});

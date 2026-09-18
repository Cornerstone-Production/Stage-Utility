// rebuildTimelineRecord — a service's item timings, derived from events.csv.
//
// The fixture is the real 18 Sep 2026 evening, the night a recorder bug merged
// two services into one timing summary while the raw rows stayed perfect. Every
// `at` and every title below is a row that machine actually wrote: 28 of them,
// twelve items in the first service and sixteen rows in the second, four of
// which are the operator stepping back inside ten minutes.
//
// Nothing here touches the disk — rebuildTimelineRecord is pure, and reading the
// rows back is archive-rows.ts's job, covered in sample-archive.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rebuildTimelineRecord, type EventRow } from "./rebuild.js";
import type { ServiceTimeline, ServiceTimelineItem } from "../../types/stage.js";

/** at,detail — every `pco item` row of 18 Sep 2026, in the order written. */
const EVENING: [string, string][] = [
  ["2026-09-17T23:23:48.789Z", "Doors"],
  ["2026-09-17T23:30:04.452Z", "10 min Warning"],
  ["2026-09-17T23:30:06.682Z", "VIDEO: Pre-roll"],
  ["2026-09-17T23:32:03.584Z", "Thank God I'm Free"],
  ["2026-09-17T23:35:59.699Z", "Shepherding"],
  ["2026-09-17T23:38:36.845Z", "Tremble"],
  ["2026-09-17T23:43:55.549Z", "HOSTING"],
  ["2026-09-17T23:48:04.660Z", "MEET & GREET"],
  ["2026-09-17T23:49:23.387Z", "MESSAGE"],
  ["2026-09-18T00:29:57.208Z", "What a God"],
  ["2026-09-18T00:36:51.901Z", "Covered By The Blood (Live)"],
  ["2026-09-18T00:42:09.085Z", "HOSTING/BENNY"],
  ["2026-09-18T00:50:36.021Z", "Doors"],
  ["2026-09-18T01:06:54.146Z", "10 min Warning"],
  ["2026-09-18T01:06:59.911Z", "VIDEO: Pre-roll"],
  ["2026-09-18T01:07:09.085Z", "10 min Warning"],
  ["2026-09-18T01:07:15.971Z", "Doors"],
  ["2026-09-18T01:16:19.189Z", "10 min Warning"],
  ["2026-09-18T01:16:20.322Z", "VIDEO: Pre-roll"],
  ["2026-09-18T01:18:21.494Z", "Thank God I'm Free"],
  ["2026-09-18T01:22:19.082Z", "Shepherding"],
  ["2026-09-18T01:25:44.138Z", "Tremble"],
  ["2026-09-18T01:30:52.651Z", "HOSTING"],
  ["2026-09-18T01:35:34.641Z", "MEET & GREET"],
  ["2026-09-18T01:36:58.931Z", "MESSAGE"],
  ["2026-09-18T02:19:15.719Z", "What a God"],
  ["2026-09-18T02:26:04.869Z", "Covered By The Blood (Live)"],
  ["2026-09-18T02:31:25.180Z", "HOSTING/BENNY"],
];

/** The first two rows, written down in the WRONG order. */
const EVENTS_OUT_OF_ORDER: [string, string][] = [
  ["2026-09-17T23:30:04.452Z", "10 min Warning"],
  ["2026-09-17T23:23:48.789Z", "Doors"],
];

/** Where the second service starts — the second "Doors". */
const SPLIT = "2026-09-18T00:50:36.021Z";
const SERVICE_1_ENDED = "2026-09-18T00:43:15.189Z";
const SERVICE_2_ENDED = "2026-09-18T02:32:33.590Z";

/** Rows as that build wrote them: no itemId, plannedLengthSec or preService. */
function oldRows(range: [string, string][]): EventRow[] {
  return range.map(([at, detail]) => ({ at, source: "pco", kind: "item", detail }));
}

function record(over: Partial<ServiceTimeline> = {}): ServiceTimeline {
  return {
    serviceKey: "st1:plan-1:t-1",
    serviceTypeId: "st1",
    serviceTypeName: "Weekend",
    planId: "plan-1",
    planTitle: "Sunday Gathering",
    seriesTitle: null,
    serviceDate: "2026-09-17",
    serviceTimeId: "t-1",
    serviceTimeStartsAt: null,
    startedAt: "2026-09-17T23:23:48.789Z",
    endedAt: null,
    items: [],
    ...over,
  };
}

const shape = (items: ServiceTimelineItem[]) =>
  items.map((i) => [i.sequence, i.title, i.startedAt, i.endedAt] as const);

describe("rebuildTimelineRecord: the 18 Sep 2026 evening", () => {
  it("gives the first service twelve entries, each ending when the next row fired", () => {
    const rows = oldRows(EVENING.filter(([at]) => at < SPLIT));
    const out = rebuildTimelineRecord(record({ endedAt: SERVICE_1_ENDED }), rows);

    // Twelve rows, twelve distinct items, no step backs — so twelve entries,
    // each ending exactly where the next begins and the last at the record's end.
    const expected = rows.map((r, i) => [
      i,
      r.detail,
      r.at,
      i + 1 < rows.length ? rows[i + 1].at : SERVICE_1_ENDED,
    ]);
    assert.equal(out.items.length, 12, `expected 12 entries, got ${out.items.length}`);
    assert.deepEqual(shape(out.items), expected);
    // Every entry closed, and the durations are the gaps between the rows.
    assert.equal(out.items[0].actualDurationSec, 376); // Doors: 23:23:48.789 → 23:30:04.452
    assert.equal(out.items[11].actualDurationSec, 66); // HOSTING/BENNY → the record's end
    assert.ok(
      out.items.every((i) => i.endedAt != null),
      "a closed record must leave no entry open",
    );
  });

  it("gives the second service twelve entries, folding its four step backs into the entries they returned to", () => {
    const rows = oldRows(EVENING.filter(([at]) => at >= SPLIT));
    assert.equal(rows.length, 16, "the second service wrote sixteen rows");

    const out = rebuildTimelineRecord(record({ endedAt: SERVICE_2_ENDED }), rows);

    assert.equal(out.items.length, 12, `expected 12 entries, got ${out.items.length}`);
    // Doors, 10 min Warning and VIDEO: Pre-roll were each returned to, so each
    // has ONE entry whose end is its LAST run's end, not its first.
    assert.deepEqual(shape(out.items), [
      [0, "Doors", "2026-09-18T00:50:36.021Z", "2026-09-18T01:16:19.189Z"],
      [1, "10 min Warning", "2026-09-18T01:06:54.146Z", "2026-09-18T01:16:20.322Z"],
      [2, "VIDEO: Pre-roll", "2026-09-18T01:06:59.911Z", "2026-09-18T01:18:21.494Z"],
      [3, "Thank God I'm Free", "2026-09-18T01:18:21.494Z", "2026-09-18T01:22:19.082Z"],
      [4, "Shepherding", "2026-09-18T01:22:19.082Z", "2026-09-18T01:25:44.138Z"],
      [5, "Tremble", "2026-09-18T01:25:44.138Z", "2026-09-18T01:30:52.651Z"],
      [6, "HOSTING", "2026-09-18T01:30:52.651Z", "2026-09-18T01:35:34.641Z"],
      [7, "MEET & GREET", "2026-09-18T01:35:34.641Z", "2026-09-18T01:36:58.931Z"],
      [8, "MESSAGE", "2026-09-18T01:36:58.931Z", "2026-09-18T02:19:15.719Z"],
      [9, "What a God", "2026-09-18T02:19:15.719Z", "2026-09-18T02:26:04.869Z"],
      [10, "Covered By The Blood (Live)", "2026-09-18T02:26:04.869Z", "2026-09-18T02:31:25.180Z"],
      [11, "HOSTING/BENNY", "2026-09-18T02:31:25.180Z", SERVICE_2_ENDED],
    ]);
  });

  it("keeps two services apart when the whole evening is rebuilt unsplit", () => {
    // What one press on the corrupted record gives if its raw directory still
    // holds both services: SERVICE_GAP_MS separates the two runs of each shared
    // item (80 minutes apart at the closest), so nothing from the second service
    // reopens the first's entries — 24 entries, twelve per service.
    const out = rebuildTimelineRecord(record({ endedAt: SERVICE_2_ENDED }), oldRows(EVENING));
    assert.equal(out.items.length, 24, `expected 24 entries, got ${out.items.length}`);
    assert.equal(out.items[0].endedAt, "2026-09-17T23:30:04.452Z", "the first Doors must not swallow the second");
    assert.equal(out.items[11].endedAt, "2026-09-18T00:50:36.021Z"); // service 1's tail closes at service 2's first row
    assert.equal(out.items[12].title, "Doors");
    assert.equal(out.items[12].startedAt, "2026-09-18T00:50:36.021Z");
    assert.equal(out.items[23].endedAt, SERVICE_2_ENDED);
  });

  it("leaves the last entry open when the record is still open", () => {
    const out = rebuildTimelineRecord(record({ endedAt: null }), oldRows(EVENING.slice(0, 3)));
    assert.equal(out.items.length, 3);
    assert.equal(out.items[2].endedAt, null, "the live item must stay live");
    assert.equal(out.items[2].actualDurationSec, null);
    assert.equal(out.items[1].endedAt, "2026-09-17T23:30:06.682Z");
  });
});

describe("rebuildTimelineRecord: identity of the items", () => {
  it("takes itemId, plannedLengthSec and preService from the columns when they are there", () => {
    const rows: EventRow[] = [
      {
        at: "2026-09-17T23:23:48.789Z",
        source: "pco",
        kind: "item",
        detail: "Doors",
        itemId: "pco-1",
        plannedLengthSec: "900",
        preService: "true",
      },
      {
        at: "2026-09-17T23:30:04.452Z",
        source: "pco",
        kind: "item",
        detail: "10 min Warning",
        itemId: "pco-2",
        plannedLengthSec: "",
        preService: "false",
      },
    ];
    const out = rebuildTimelineRecord(record({ endedAt: "2026-09-17T23:40:00.000Z" }), rows);

    assert.deepEqual(
      out.items.map((i) => [i.itemId, i.plannedLengthSec, i.preService]),
      [
        ["pco-1", 900, true],
        ["pco-2", null, false],
      ],
    );
  });

  // Rows reach a rebuild out of order in practice: a history merge rewrites two
  // services' files into one, and readArchiveRows concatenates rolled files in
  // FILE order. Out of order, every entry's end is the wrong row's time.
  it("sorts the rows by time before walking them", () => {
    const ordered = oldRows(EVENTS_OUT_OF_ORDER.slice().sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    const reversed = oldRows(EVENTS_OUT_OF_ORDER);
    assert.notDeepEqual(
      reversed.map((r) => r.at),
      ordered.map((r) => r.at),
      "the fixture is already in order, so this proves nothing",
    );

    const out = rebuildTimelineRecord(record({ endedAt: "2026-09-17T23:40:00.000Z" }), reversed);

    assert.deepEqual(shape(out.items), [
      [0, "Doors", "2026-09-17T23:23:48.789Z", "2026-09-17T23:30:04.452Z"],
      [1, "10 min Warning", "2026-09-17T23:30:04.452Z", "2026-09-17T23:40:00.000Z"],
    ]);
  });

  it("ignores every row that is not a plan-item change", () => {
    const rows: EventRow[] = [
      ...oldRows(EVENING.slice(0, 2)),
      { at: "2026-09-17T23:25:00.000Z", source: "automation", kind: "fired", detail: "House lights: ok" },
      { at: "2026-09-17T23:26:00.000Z", source: "automation", kind: "failed", detail: "Rear wash: timed out" },
    ];
    const out = rebuildTimelineRecord(record({ endedAt: "2026-09-17T23:40:00.000Z" }), rows);
    assert.equal(out.items.length, 2, "an automation row was counted as an item");
    assert.equal(out.items[0].endedAt, "2026-09-17T23:30:04.452Z", "an automation row closed an item early");
  });

  it("matches an old row to the stored record by title, and slugs a title the record never saw", () => {
    const prior = record({
      endedAt: "2026-09-17T23:40:00.000Z",
      items: [
        {
          itemId: "pco-77",
          title: "Doors",
          sequence: 0,
          plannedLengthSec: 900,
          startedAt: "2026-09-17T23:23:48.789Z",
          endedAt: "2026-09-17T23:30:04.452Z",
          actualDurationSec: 376,
          preService: true,
          counted: false,
        },
      ],
    });
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    let out: ServiceTimeline;
    try {
      // Doors twice — once here and once as a genuine re-run over an hour later,
      // so the "once per title" promise is actually exercised.
      out = rebuildTimelineRecord(
        prior,
        oldRows([
          ["2026-09-17T23:23:48.789Z", "Doors"],
          ["2026-09-17T23:30:04.452Z", "MESSAGE"],
          ["2026-09-18T00:50:36.021Z", "Doors"],
        ]),
      );
    } finally {
      console.warn = realWarn;
    }

    // Title match: the stored record's id and planned length come back with it.
    assert.equal(out.items[0].itemId, "pco-77");
    assert.equal(out.items[0].plannedLengthSec, 900);
    assert.equal(out.items[0].preService, true, "preService falls back to the stored entry");
    // The counted override is the operator's, is stated per plan item, and lands
    // on BOTH runs of it.
    assert.equal(out.items[0].counted, false);
    assert.equal(out.items[2].itemId, "pco-77");
    assert.equal(out.items[2].counted, false);
    // No stored entry called MESSAGE: a stable slug of the title, not a drop.
    assert.equal(out.items[1].itemId, "message");
    assert.equal(out.items[1].plannedLengthSec, null);
    assert.equal(out.items[1].preService, false);

    assert.deepEqual(warnings, [
      '[service-timeline] rebuild: no item id for "Doors", matched by title',
      '[service-timeline] rebuild: no item id for "MESSAGE", matched by title',
    ]);
  });

  it("re-slugs to the same id on a second rebuild, so an id does not drift", () => {
    const rows = oldRows([
      ["2026-09-17T23:23:48.789Z", "MEET & GREET"],
      ["2026-09-17T23:30:04.452Z", "MESSAGE"],
    ]);
    const first = rebuildTimelineRecord(record({ endedAt: "2026-09-17T23:40:00.000Z" }), rows);
    const second = rebuildTimelineRecord(first, rows);
    assert.deepEqual(
      second.items.map((i) => i.itemId),
      first.items.map((i) => i.itemId),
    );
    assert.deepEqual(first.items.map((i) => i.itemId), ["meet-greet", "message"]);
  });

  it("keeps the record's own fields", () => {
    const prior = record({ endedAt: SERVICE_2_ENDED, pacingResetAt: "2026-09-18T01:00:00.000Z" });
    const out = rebuildTimelineRecord(prior, oldRows(EVENING.slice(0, 3)));
    assert.equal(out.serviceKey, prior.serviceKey);
    assert.equal(out.startedAt, prior.startedAt);
    assert.equal(out.endedAt, SERVICE_2_ENDED);
    assert.equal(out.serviceTimeId, prior.serviceTimeId);
    assert.equal(out.pacingResetAt, "2026-09-18T01:00:00.000Z");
  });
});

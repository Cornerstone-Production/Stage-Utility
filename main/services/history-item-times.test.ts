// applyItemTimeEdits — an operator's item-timing corrections, over the raw record.
//
// Pure: nothing here touches the store, the disk or the broadcaster, so every
// case runs the real function on a literal record.
//
// The case these exist for is real. On 17 Sep 2026 "VIDEO: Pre-roll" recorded at
// 11:22 because the operator went back and forth in Planning Center before the
// service; it actually ran two minutes. Correcting it must survive a rebuild
// from `events.csv`, because the raw rows say 11:22 and always will.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  applyItemTimeEdits,
  bindItemTimeEdits,
  rekeyItemTimeEdits,
} from "./history-item-times.js";
import { rebuildTimelineRecord, type EventRow } from "./archive/rebuild.js";
import type { ServiceTimeline, ServiceTimelineItem } from "../types/stage.js";

const START = "2026-09-17T20:15:00.000Z";
const END = "2026-09-17T21:30:00.000Z";

function item(over: Partial<ServiceTimelineItem> & Pick<ServiceTimelineItem, "itemId" | "sequence">): ServiceTimelineItem {
  const startedAt = over.startedAt ?? START;
  const endedAt = over.endedAt ?? null;
  return {
    title: over.itemId,
    plannedLengthSec: null,
    actualDurationSec:
      endedAt == null ? null : Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000),
    ...over,
    startedAt,
    endedAt,
  };
}

function record(items: ServiceTimelineItem[], edits?: ServiceTimeline["itemTimeEdits"]): ServiceTimeline {
  const rec: ServiceTimeline = {
    serviceKey: "svc:plan:occ",
    serviceTypeId: "svc",
    planId: "plan",
    planTitle: "Evening",
    seriesTitle: null,
    serviceDate: "2026-09-17",
    serviceTimeId: "occ",
    serviceTimeStartsAt: START,
    startedAt: START,
    endedAt: END,
    items,
  };
  if (edits) rec.itemTimeEdits = edits;
  return rec;
}

/** The pre-roll as recorded: 11 minutes 22 seconds. */
const PREROLL_START = "2026-09-17T20:15:00.000Z";
const PREROLL_RECORDED_END = "2026-09-17T20:26:22.000Z";
/** Two minutes, which is what it actually ran. */
const PREROLL_FIXED_END = "2026-09-17T20:17:00.000Z";

const preroll = () =>
  item({ itemId: "vid-1", title: "VIDEO: Pre-roll", sequence: 0, startedAt: PREROLL_START, endedAt: PREROLL_RECORDED_END });
const welcome = () =>
  item({ itemId: "wel-1", title: "Welcome", sequence: 1, startedAt: PREROLL_RECORDED_END, endedAt: "2026-09-17T20:31:22.000Z" });

describe("applyItemTimeEdits", () => {
  test("a record with no edits is unchanged", () => {
    const rec = record([preroll(), welcome()]);
    const { record: out, orphaned } = applyItemTimeEdits(rec);
    assert.deepEqual(out.items, rec.items);
    assert.deepEqual(orphaned, []);
  });

  test("an end override replaces the end and recomputes the duration", () => {
    const { record: out } = applyItemTimeEdits(
      record([preroll(), welcome()], [{ itemId: "vid-1", sequence: 0, endedAt: PREROLL_FIXED_END, editedAt: END }]),
    );
    assert.equal(out.items[0].endedAt, PREROLL_FIXED_END);
    assert.equal(out.items[0].actualDurationSec, 120, "2:00, not the recorded 11:22");
    assert.equal(out.items[0].startedAt, PREROLL_START, "the start is untouched");
  });

  test("a start override replaces the start and recomputes the duration", () => {
    const { record: out } = applyItemTimeEdits(
      record([preroll()], [{ itemId: "vid-1", sequence: 0, startedAt: "2026-09-17T20:24:22.000Z", editedAt: END }]),
    );
    assert.equal(out.items[0].startedAt, "2026-09-17T20:24:22.000Z");
    assert.equal(out.items[0].actualDurationSec, 120);
  });

  test("both fields at once", () => {
    const { record: out } = applyItemTimeEdits(
      record(
        [preroll()],
        [{ itemId: "vid-1", sequence: 0, startedAt: "2026-09-17T20:16:00.000Z", endedAt: "2026-09-17T20:18:00.000Z", editedAt: END }],
      ),
    );
    assert.equal(out.items[0].startedAt, "2026-09-17T20:16:00.000Z");
    assert.equal(out.items[0].endedAt, "2026-09-17T20:18:00.000Z");
    assert.equal(out.items[0].actualDurationSec, 120);
  });

  test("the recorded values are kept on the item, for the marker and Reset", () => {
    const { record: out } = applyItemTimeEdits(
      record([preroll()], [{ itemId: "vid-1", sequence: 0, endedAt: PREROLL_FIXED_END, editedAt: END }]),
    );
    assert.deepEqual(out.items[0].editedFrom, {
      startedAt: PREROLL_START,
      endedAt: PREROLL_RECORDED_END,
      actualDurationSec: 682,
    });
  });

  test("the neighbour does not move — the gap is left visible", () => {
    const { record: out } = applyItemTimeEdits(
      record([preroll(), welcome()], [{ itemId: "vid-1", sequence: 0, endedAt: PREROLL_FIXED_END, editedAt: END }]),
    );
    assert.equal(out.items[1].startedAt, PREROLL_RECORDED_END, "Welcome still starts when it started");
    assert.equal(out.items[1].actualDurationSec, 300);
    assert.equal(out.items[1].editedFrom, undefined);
  });

  test("the stored items are never mutated", () => {
    const rec = record([preroll()], [{ itemId: "vid-1", sequence: 0, endedAt: PREROLL_FIXED_END, editedAt: END }]);
    applyItemTimeEdits(rec);
    assert.equal(rec.items[0].endedAt, PREROLL_RECORDED_END, "the raw record still says what was recorded");
    assert.equal(rec.items[0].editedFrom, undefined);
  });

  test("clearing the override restores the recorded times", () => {
    const rec = record([preroll()], [{ itemId: "vid-1", sequence: 0, endedAt: PREROLL_FIXED_END, editedAt: END }]);
    const edited = applyItemTimeEdits(rec).record;
    assert.equal(edited.items[0].actualDurationSec, 120);
    // What setItemTimes stores on a clear: the entry is gone.
    delete edited.itemTimeEdits;
    const cleared = applyItemTimeEdits(edited).record;
    assert.equal(cleared.items[0].endedAt, PREROLL_RECORDED_END);
    assert.equal(cleared.items[0].actualDurationSec, 682);
    assert.equal(cleared.items[0].editedFrom, undefined, "no stale marker left behind");
  });

  test("re-editing an already-overlaid record still remembers the RECORDED times", () => {
    // The route answers with the overlaid record and the SSE push carries it, so
    // an overlaid record is what comes back in on the second edit. Applying over
    // it without undoing the first overlay would store 20:17 as "recorded" and
    // the operator's Reset would put back a time that never happened.
    const first = applyItemTimeEdits(
      record([preroll()], [{ itemId: "vid-1", sequence: 0, endedAt: PREROLL_FIXED_END, editedAt: END }]),
    ).record;
    const second = applyItemTimeEdits({
      ...first,
      itemTimeEdits: [{ itemId: "vid-1", sequence: 0, endedAt: "2026-09-17T20:18:00.000Z", editedAt: END }],
    }).record;
    assert.equal(second.items[0].endedAt, "2026-09-17T20:18:00.000Z");
    assert.equal(second.items[0].actualDurationSec, 180);
    assert.deepEqual(second.items[0].editedFrom, {
      startedAt: PREROLL_START,
      endedAt: PREROLL_RECORDED_END,
      actualDurationSec: 682,
    });
  });

  test("an override restating the recorded value does not mark the row edited", () => {
    const { record: out } = applyItemTimeEdits(
      record([preroll()], [{ itemId: "vid-1", sequence: 0, endedAt: PREROLL_RECORDED_END, editedAt: END }]),
    );
    assert.equal(out.items[0].editedFrom, undefined);
  });

  test("an edit naming a run the record no longer has is reported, not applied", () => {
    const { record: out, orphaned } = applyItemTimeEdits(
      record([preroll()], [
        { itemId: "vid-1", sequence: 0, endedAt: PREROLL_FIXED_END, editedAt: END },
        { itemId: "gone", sequence: 7, endedAt: PREROLL_FIXED_END, editedAt: END },
      ]),
    );
    assert.equal(out.items[0].actualDurationSec, 120, "the edit that DOES match still applies");
    assert.deepEqual(orphaned.map((e) => e.itemId), ["gone"]);
    assert.equal(out.itemTimeEdits?.length, 2, "the orphan is kept, in case the run comes back");
  });

  test("the same item running twice takes the edit on the run it names", () => {
    const rec = record(
      [
        item({ itemId: "song", title: "Song", sequence: 0, startedAt: START, endedAt: "2026-09-17T20:20:00.000Z" }),
        item({ itemId: "song", title: "Song (reprise)", sequence: 1, startedAt: "2026-09-17T21:00:00.000Z", endedAt: "2026-09-17T21:10:00.000Z" }),
      ],
      [{ itemId: "song", sequence: 1, endedAt: "2026-09-17T21:02:00.000Z", editedAt: END }],
    );
    const { record: out } = applyItemTimeEdits(rec);
    assert.equal(out.items[0].actualDurationSec, 300, "the first run is untouched");
    assert.equal(out.items[1].actualDurationSec, 120);
  });
});

describe("applyItemTimeEdits: a rebuild from events.csv keeps the edit", () => {
  const rows = (): EventRow[] => [
    { kind: "item", at: PREROLL_START, detail: "VIDEO: Pre-roll", itemId: "vid-1" },
    { kind: "item", at: PREROLL_RECORDED_END, detail: "Welcome", itemId: "wel-1" },
  ];

  test("rebuild re-derives the raw stamps and the overlay puts the correction back", () => {
    const prior = record(
      [preroll(), welcome()],
      [{ itemId: "vid-1", sequence: 0, endedAt: PREROLL_FIXED_END, editedAt: END }],
    );
    const rebuilt = rebuildTimelineRecord(prior, rows());
    assert.equal(rebuilt.items[0].endedAt, PREROLL_RECORDED_END, "the rebuild itself is the raw rows");
    const { record: out } = applyItemTimeEdits(rebuilt);
    assert.equal(out.items[0].endedAt, PREROLL_FIXED_END, "a rebuild must not undo an operator's correction");
    assert.equal(out.items[0].actualDurationSec, 120);
  });

  test("rebuilding an OVERLAID record still rebuilds from the rows, not the edit", () => {
    const prior = applyItemTimeEdits(
      record([preroll(), welcome()], [{ itemId: "vid-1", sequence: 0, endedAt: PREROLL_FIXED_END, editedAt: END }]),
    ).record;
    const out = applyItemTimeEdits(rebuildTimelineRecord(prior, rows())).record;
    assert.equal(out.items[0].actualDurationSec, 120);
    assert.deepEqual(out.items[0].editedFrom, {
      startedAt: PREROLL_START,
      endedAt: PREROLL_RECORDED_END,
      actualDurationSec: 682,
    });
  });
});

describe("bindItemTimeEdits / rekeyItemTimeEdits", () => {
  test("an edit follows its item through a renumber", () => {
    const target = record([item({ itemId: "b", sequence: 0, startedAt: "2026-09-17T21:00:00.000Z", endedAt: "2026-09-17T21:10:00.000Z" })], [
      { itemId: "b", sequence: 0, endedAt: "2026-09-17T21:02:00.000Z", editedAt: END },
    ]);
    const source = record([item({ itemId: "a", sequence: 0, startedAt: START, endedAt: "2026-09-17T20:30:00.000Z" })]);
    const bound = bindItemTimeEdits(target, source);

    // What mergeServiceRecords does: combine, sort by start, renumber.
    const merged = [...target.items, ...source.items].sort(
      (x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt),
    );
    merged.forEach((it, i) => { it.sequence = i; });

    const rekeyed = rekeyItemTimeEdits(bound, merged);
    assert.deepEqual(rekeyed, [{ itemId: "b", sequence: 1, endedAt: "2026-09-17T21:02:00.000Z", editedAt: END }]);
    assert.equal(
      applyItemTimeEdits({ ...target, items: merged, itemTimeEdits: rekeyed }).record.items[1].actualDurationSec,
      120,
    );
  });

  test("an edit whose item did not survive the merge goes with it", () => {
    const rec = record([item({ itemId: "a", sequence: 0 })], [{ itemId: "a", sequence: 0, endedAt: END, editedAt: END }]);
    assert.deepEqual(rekeyItemTimeEdits(bindItemTimeEdits(rec), []), []);
  });
});

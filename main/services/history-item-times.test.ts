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
  carryItemTimeEdits,
  overlaidTimeline,
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

  test("an item the recorder has REOPENED takes no end override", () => {
    // A step back sets endedAt to null and puts the item back on air. An end
    // override left from before the reopen would close it again behind the
    // recorder's back: a finished duration on a row that is still running, and a
    // pacing readout that thinks the live item is done.
    const live = item({ itemId: "vid-1", title: "VIDEO: Pre-roll", sequence: 0, startedAt: PREROLL_START, endedAt: null });
    const rec = record([live], [{ itemId: "vid-1", sequence: 0, endedAt: PREROLL_FIXED_END, editedAt: END }]);
    const { record: out } = applyItemTimeEdits(rec);
    assert.equal(out.items[0].endedAt, null, "the reopened item must stay open");
    assert.equal(out.items[0].actualDurationSec, null);
    assert.equal(out.items[0].editedFrom, undefined, "and must not read as edited");
    assert.equal(out.itemTimeEdits?.length, 1, "the override is kept — closing the item restores it");
  });

  test("a reopened item still takes a START override", () => {
    const live = item({ itemId: "vid-1", sequence: 0, startedAt: PREROLL_START, endedAt: null });
    const { record: out } = applyItemTimeEdits(
      record([live], [{ itemId: "vid-1", sequence: 0, startedAt: "2026-09-17T20:16:00.000Z", editedAt: END }]),
    );
    assert.equal(out.items[0].startedAt, "2026-09-17T20:16:00.000Z");
    assert.equal(out.items[0].endedAt, null, "correcting the start does not close it");
  });

  test("two corrections for one run: the LAST wins, against the RAW item", () => {
    // setItemTimes replaces rather than appends, but a merge, an import or a
    // hand-edited file can produce two. Applied in sequence, the second read the
    // already-corrected item as "what was recorded", so editedFrom held the
    // FIRST correction's values — Reset put back a time that never happened and
    // the tooltip named it as the recording.
    const { record: out } = applyItemTimeEdits(
      record([preroll()], [
        { itemId: "vid-1", sequence: 0, endedAt: PREROLL_FIXED_END, editedAt: END },
        { itemId: "vid-1", sequence: 0, endedAt: "2026-09-17T20:18:00.000Z", editedAt: END },
      ]),
    );
    assert.equal(out.items[0].endedAt, "2026-09-17T20:18:00.000Z", "the LAST correction is the one applied");
    assert.equal(out.items[0].actualDurationSec, 180);
    assert.deepEqual(
      out.items[0].editedFrom,
      { startedAt: PREROLL_START, endedAt: PREROLL_RECORDED_END, actualDurationSec: 682 },
      "and what it replaced is the RECORDING, never the other correction",
    );
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

describe("carryItemTimeEdits: a rebuilt run list that differs from the stored one", () => {
  const row = (at: string, title: string, itemId: string): EventRow => ({ kind: "item", at, detail: title, itemId });

  /**
   * The stored record: Song, Message, Song (reprise), with the REPRISE corrected
   * to two minutes. The Message between the two Songs is what makes the second a
   * genuine re-run rather than a step back — the live recorder's rule, which the
   * rebuild shares, reopens an entry only within ten minutes of it closing.
   *
   * The correction is keyed `song#2`.
   */
  function reprised() {
    return record(
      [
        item({ itemId: "song", title: "Song", sequence: 0, startedAt: "2026-09-17T20:30:00.000Z", endedAt: "2026-09-17T20:40:00.000Z" }),
        item({ itemId: "msg", title: "Message", sequence: 1, startedAt: "2026-09-17T20:40:00.000Z", endedAt: "2026-09-17T21:00:00.000Z" }),
        item({ itemId: "song", title: "Song", sequence: 2, startedAt: "2026-09-17T21:00:00.000Z", endedAt: "2026-09-17T21:10:00.000Z" }),
      ],
      [{ itemId: "song", sequence: 2, endedAt: "2026-09-17T21:02:00.000Z", editedAt: END }],
    );
  }

  test("the correction stays on the REPRISE, not on the first run of the same item", () => {
    // The raw rows hold two items the stored record never did — a capture the
    // recorder opened late, which is the case a rebuild exists for — so the
    // first Song lands on sequence 2, exactly the number the reprise's
    // correction is keyed to. Carried across unchanged, the correction moved
    // onto the FIRST run: that row read `edited`, the reprise the operator
    // actually fixed read its recorded ten minutes again, and nothing was
    // reported, because the key still matched something.
    const rows = [
      row("2026-09-17T20:00:00.000Z", "Countdown", "countdown"),
      row("2026-09-17T20:15:00.000Z", "Doors", "doors"),
      row("2026-09-17T20:30:00.000Z", "Song", "song"),
      row("2026-09-17T20:40:00.000Z", "Message", "msg"),
      row("2026-09-17T21:00:00.000Z", "Song", "song"),
    ];
    const rebuilt = rebuildTimelineRecord(reprised(), rows);
    const at2 = rebuilt.items[2];
    assert.equal(at2.itemId, "song", "precondition: the FIRST run now holds sequence 2");
    assert.equal(at2.startedAt, "2026-09-17T20:30:00.000Z", "precondition: and it is the first run, not the reprise");

    const out = applyItemTimeEdits(rebuilt).record;
    const runs = out.items.filter((i) => i.itemId === "song");
    assert.equal(runs.length, 2, "precondition: the rebuild produced both runs");
    assert.equal(runs[0].editedFrom, undefined, "the FIRST run was never corrected");
    assert.equal(runs[0].actualDurationSec, 600, "and still runs its recorded ten minutes");
    assert.equal(runs[1].actualDurationSec, 120, "the reprise keeps the operator's two minutes");
  });

  test("an item added ahead of the corrected run shifts it, and the correction follows", () => {
    // The rebuilt list gains an item the stored record never had, so every run
    // after it is renumbered. Carried unchanged, the correction would land on
    // whichever run inherited sequence 2 — silently, with no orphan reported.
    const prior = record(
      [
        item({ itemId: "doors", title: "Doors", sequence: 0, startedAt: "2026-09-17T20:15:00.000Z", endedAt: "2026-09-17T20:30:00.000Z" }),
        item({ itemId: "welcome", title: "Welcome", sequence: 1, startedAt: "2026-09-17T20:30:00.000Z", endedAt: "2026-09-17T20:40:00.000Z" }),
        item({ itemId: "song", title: "Song", sequence: 2, startedAt: "2026-09-17T20:40:00.000Z", endedAt: "2026-09-17T20:50:00.000Z" }),
      ],
      [{ itemId: "song", sequence: 2, endedAt: "2026-09-17T20:42:00.000Z", editedAt: END }],
    );
    const rows = [
      row("2026-09-17T20:15:00.000Z", "Doors", "doors"),
      row("2026-09-17T20:20:00.000Z", "Countdown", "countdown"), // never in the stored record
      row("2026-09-17T20:30:00.000Z", "Welcome", "welcome"),
      row("2026-09-17T20:40:00.000Z", "Song", "song"),
    ];
    const rebuilt = rebuildTimelineRecord(prior, rows);
    assert.deepEqual(
      rebuilt.items.map((i) => i.itemId),
      ["doors", "countdown", "welcome", "song"],
      "precondition: the run list shifted",
    );
    assert.deepEqual(
      rebuilt.itemTimeEdits,
      [{ itemId: "song", sequence: 3, endedAt: "2026-09-17T20:42:00.000Z", editedAt: END }],
      "the correction must be re-keyed onto Song's NEW sequence",
    );
    const out = applyItemTimeEdits(rebuilt).record;
    assert.equal(out.items[3].actualDurationSec, 120, "Song keeps its correction");
    assert.equal(out.items[2].editedFrom, undefined, "and Welcome, which took sequence 2, did not acquire one");
  });

  test("a correction whose run the rebuild no longer produces is dropped and reported", () => {
    const prior = record(
      [
        item({ itemId: "doors", title: "Doors", sequence: 0, startedAt: "2026-09-17T20:15:00.000Z", endedAt: "2026-09-17T20:30:00.000Z" }),
        item({ itemId: "song", title: "Song", sequence: 1, startedAt: "2026-09-17T20:30:00.000Z", endedAt: "2026-09-17T20:40:00.000Z" }),
      ],
      [{ itemId: "song", sequence: 1, endedAt: "2026-09-17T20:32:00.000Z", editedAt: END }],
    );
    const rebuilt = rebuildTimelineRecord(prior, [row("2026-09-17T20:15:00.000Z", "Doors", "doors")]);
    assert.equal(rebuilt.itemTimeEdits, undefined, "nothing to apply it to, so it is not carried");
    assert.deepEqual(applyItemTimeEdits(rebuilt).orphaned, [], "and it is gone, not left as a silent orphan");
  });

  test("a READ never logs — orphaning is reported where it happens", () => {
    // overlaidTimeline runs on every SSE push, every poll and every hello burst.
    // Warning there printed the same line hundreds of times in one service while
    // saying nothing about which operation caused it.
    const rec = record(
      [preroll()],
      [{ itemId: "gone", sequence: 7, endedAt: PREROLL_FIXED_END, editedAt: END }],
    );
    const lines: unknown[][] = [];
    const warn = console.warn;
    const log = console.log;
    console.warn = (...a: unknown[]) => void lines.push(a);
    console.log = (...a: unknown[]) => void lines.push(a);
    try {
      for (let i = 0; i < 5; i++) overlaidTimeline(rec);
    } finally {
      console.warn = warn;
      console.log = log;
    }
    assert.deepEqual(lines, [], `a read logged: ${JSON.stringify(lines)}`);
  });

  test("carryItemTimeEdits names the orphans rather than swallowing them", () => {
    const prior = record(
      [item({ itemId: "song", sequence: 0 })],
      [{ itemId: "song", sequence: 0, endedAt: END, editedAt: END }],
    );
    const { edits, orphaned } = carryItemTimeEdits(prior, []);
    assert.deepEqual(edits, []);
    assert.deepEqual(orphaned.map((e) => e.itemId), ["song"]);
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

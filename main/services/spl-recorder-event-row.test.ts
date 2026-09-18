// The `kind=item` row in events.csv is the ONLY record of a plan-item
// transition in the raw layer, and rebuildTimelineRecord is only as good as it
// is. A row carrying just a title cannot name which plan item ran (two items can
// share a title) or how long it was meant to run, so the rebuild would have to
// guess both — which is the hand repair this feature exists to remove.
//
// Driven through the real onLiveTick rather than calling sampleArchive directly:
// what is under test is the RECORDER passing the fields, not the appender's
// ability to write columns it is handed (sample-archive.test.ts covers that).
// The record is preset so ensureRecord short-circuits — the lifecycle is
// recorder-forget.test.ts's job.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-spl-event-row-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { splRecorder } = await import("./spl-recorder.js");
const { sampleArchive } = await import("./archive/sample-archive.js");
const { serviceDirPath } = await import("./archive/archive-paths.js");
const { readArchiveRows } = await import("./archive/archive-rows.js");

const SERVICE_KEY = "st1:plan-1:t-9am";
const SERVICE_DATE = "2026-09-20";

type Held = { current: unknown; currentKey: string | null; lastItemId: string | null };
const held = splRecorder as unknown as Held;

after(async () => {
  splRecorder.forget(SERVICE_KEY); // cancels the 60 s persist timer
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe("spl-recorder: the plan-item event row", () => {
  it("carries the item id, planned length and pre-service flag", async () => {
    held.current = {
      serviceKey: SERVICE_KEY,
      serviceTypeId: "st1",
      planId: "plan-1",
      serviceDate: SERVICE_DATE,
      serviceTimeId: "t-9am",
      serviceTimeStartsAt: null,
      startedAt: "2026-09-20T14:00:00.000Z",
      endedAt: null,
      meterId: null,
      metricKey: null,
      items: [],
    };
    held.currentKey = SERVICE_KEY;
    held.lastItemId = null;

    await splRecorder.onLiveTick({
      mode: "item",
      currentItemId: "item-42",
      label: "Thank God I'm Free",
      lengthSec: 315,
      beforeServiceStart: false,
      liveStartAt: "2026-09-20T14:05:00.000Z",
      serviceEnded: false,
      serviceTimeId: "t-9am",
      serviceTimeStartsAt: null,
    } as never);
    await sampleArchive.flush();

    const rows = await readArchiveRows(serviceDirPath(SERVICE_KEY, SERVICE_DATE), "events");
    assert.ok(rows, "the recorder wrote no events file at all");
    const item = rows.filter((r) => r.kind === "item");
    assert.equal(item.length, 1, `expected one item row, got ${JSON.stringify(rows)}`);
    assert.equal(item[0].detail, "Thank God I'm Free");
    assert.equal(item[0].itemId, "item-42", "the row does not name the plan item");
    assert.equal(item[0].plannedLengthSec, "315", "the row does not carry the planned length");
    assert.equal(item[0].preService, "false", "the row does not carry the pre-service flag");
  });
});

// A baptism run on a Wednesday was landing on the previous Sunday's service.
//
// currentServiceKey() asks the timeline recorder for the open record, but the
// recorder holds its last record indefinitely — on purpose, since the taper and
// the resume path both need it after the service closes. Testing only for the
// record's presence therefore returned the last service's key all week, and
// link-baptisms matched the session straight onto it.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-service-key-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { serviceTimelineRecorder } = await import("./service-timeline-recorder.js");
const { currentServiceKey } = await import("./service-key.js");

type Held = { current: { serviceKey: string; endedAt: string | null } | null };
const rec = () => serviceTimelineRecorder as unknown as Held;

describe("currentServiceKey", () => {
  beforeEach(() => {
    rec().current = null;
  });

  it("is null when nothing has been recorded", () => {
    assert.equal(currentServiceKey(), null);
  });

  it("returns the key while a service is genuinely open", () => {
    rec().current = { serviceKey: "st1:plan:11am", endedAt: null };
    assert.equal(currentServiceKey(), "st1:plan:11am");
  });

  it("is null once the record has closed, however long it is held", () => {
    // The bug: this returned "st1:plan:11am" for the rest of the week, so a
    // midweek baptism was stamped with Sunday's service and linked onto it.
    rec().current = { serviceKey: "st1:plan:11am", endedAt: "2026-08-09T17:05:00.000Z" };
    assert.equal(currentServiceKey(), null);
  });

  it("returns the key again when the record is reopened", () => {
    // A lull mid-service clears endedAt; the key must come back with it.
    rec().current = { serviceKey: "st1:plan:11am", endedAt: "2026-08-09T17:05:00.000Z" };
    assert.equal(currentServiceKey(), null);
    rec().current = { serviceKey: "st1:plan:11am", endedAt: null };
    assert.equal(currentServiceKey(), "st1:plan:11am");
  });
});

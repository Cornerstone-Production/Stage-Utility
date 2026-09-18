// The milestone routes, driven through the real dispatcher.
//
// Every refusal here exists because the alternative is a row the operator can
// see in Settings and a mark that never appears on the chart, with nothing to
// read. A 400 with the reason is the whole point; a 200 that stores something
// undrawable is the bug.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-milestone-routes-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { historyRoutes } = await import("./history-routes.js");
const { callRoute } = await import("./route-harness.js");
const { historyMilestonesStore, MAX_LABEL_LENGTH } = await import("../history-milestones-store.js");
const { serviceTimelineStore } = await import("../service-timeline-store.js");

await historyMilestonesStore.init();

// One recorded service, so there is exactly one known service type id. A
// milestone scoped to anything else must be refused.
await serviceTimelineStore.upsert({
  serviceKey: "weekend:plan-1:0900",
  serviceTypeId: "weekend",
  serviceTypeName: "Weekend",
  planId: "plan-1",
  planTitle: "Sunday",
  seriesTitle: "Rooted",
  serviceDate: "2026-09-06",
  serviceTimeId: "0900",
  serviceTimeStartsAt: "2026-09-06T14:00:00.000Z",
  startedAt: "2026-09-06T14:00:00.000Z",
  endedAt: "2026-09-06T15:20:00.000Z",
  items: [],
} as unknown as ServiceTimeline);

after(() => {
  fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

const post = (body: unknown) =>
  callRoute(historyRoutes, "/api/history/milestones", { method: "POST", body });

describe("POST /api/history/milestones", () => {
  it("stores one and answers the whole list", async () => {
    const out = await post({ date: "2026-09-06", label: "Moved to two services", serviceTypeId: null });
    assert.equal(out.status, 200);
    const list = out.json as { date: string; label: string }[];
    assert.deepEqual(list.map((m) => [m.date, m.label]), [["2026-09-06", "Moved to two services"]]);
  });

  it("refuses a date that is not a real day, with the reason", async () => {
    // "2026-02-31" parses in JavaScript and lands on 2 March, which would draw
    // a mark under a date nothing happened on.
    const out = await post({ date: "2026-02-31", label: "Never happened", serviceTypeId: null });
    assert.equal(out.status, 400);
    assert.match(String((out.json as { error: string }).error), /not a date \(YYYY-MM-DD\)/);
  });

  it("refuses a blank label", async () => {
    const out = await post({ date: "2026-09-13", label: "   ", serviceTypeId: null });
    assert.equal(out.status, 400);
    assert.match(String((out.json as { error: string }).error), /needs a label/);
  });

  it("refuses a label longer than the field, and says by how much", async () => {
    const out = await post({ date: "2026-09-13", label: "x".repeat(MAX_LABEL_LENGTH + 1), serviceTypeId: null });
    assert.equal(out.status, 400);
    assert.match(String((out.json as { error: string }).error), new RegExp(`at most ${MAX_LABEL_LENGTH} characters`));
  });

  it("stores a label trimmed", async () => {
    const out = await post({ date: "2026-09-20", label: "  Camp  ", serviceTypeId: null });
    assert.equal(out.status, 200);
    assert.ok((out.json as { label: string }[]).some((m) => m.label === "Camp"));
  });

  it("refuses a service type nothing has ever recorded", async () => {
    // It would draw on no line at all — invisible, with no way to tell why.
    const out = await post({ date: "2026-09-27", label: "Youth moved", serviceTypeId: "no-such-type" });
    assert.equal(out.status, 400);
    assert.match(String((out.json as { error: string }).error), /no service type "no-such-type" has ever recorded/);
  });

  it("accepts a service type that HAS recorded", async () => {
    const out = await post({ date: "2026-09-27", label: "Weekend moved", serviceTypeId: "weekend" });
    assert.equal(out.status, 200);
    assert.ok((out.json as { serviceTypeId: string | null }[]).some((m) => m.serviceTypeId === "weekend"));
  });
});

describe("DELETE /api/history/milestones/:id", () => {
  it("removes one and answers what is left", async () => {
    const added = await post({ date: "2026-10-04", label: "Gone soon", serviceTypeId: null });
    const id = (added.json as { id: string; label: string }[]).find((m) => m.label === "Gone soon")!.id;
    const out = await callRoute(historyRoutes, `/api/history/milestones/${id}`, { method: "DELETE" });
    assert.equal(out.status, 200);
    assert.equal((out.json as { id: string }[]).some((m) => m.id === id), false);
  });

  it("answers 404 for an id that is not there", async () => {
    // A 200 said the deletion happened, so a client working from a stale list —
    // two tabs open, or a restored backup — was told it had removed something
    // that was never there.
    const out = await callRoute(historyRoutes, "/api/history/milestones/no-such-id", { method: "DELETE" });
    assert.equal(out.status, 404);
    assert.match(String((out.json as { error: string }).error), /no milestone with that id/);
  });
});

describe("GET /api/history/milestones", () => {
  it("answers the list, newest first", async () => {
    const out = await callRoute(historyRoutes, "/api/history/milestones", { method: "GET" });
    assert.equal(out.status, 200);
    const dates = (out.json as { date: string }[]).map((m) => m.date);
    assert.deepEqual(dates, [...dates].sort().reverse(), `not newest first: ${dates.join(", ")}`);
  });
});

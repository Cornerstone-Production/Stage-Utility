// baptism-rebuild-route.test.ts — POST /api/baptism/rebuild, driven end to end
// against the real route, the real stores and a real archive file.
//
// The merge rule itself (matched vs. added vs. kept, the 2-second skew
// tolerance, and that it never deletes) is proven in
// rebuild-baptism-merge.test.ts; this proves the HTTP surface around it: body
// validation, the live refusal, the no-raw-rows refusal, and that a
// successful call actually lands on disk through the real dispatcher.

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-rebuild-route-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { historyRoutes } = await import("./history-routes.js");
const { callRoute } = await import("./route-harness.js");
const { handlerErrorStatus } = await import("../remote-server.js");
const { serviceTimelineStore } = await import("../service-timeline-store.js");
const { serviceTimelineRecorder } = await import("../service-timeline-recorder.js");
const { baptismStore } = await import("../baptism-store.js");
const { serviceDirPath } = await import("../archive/archive-paths.js");
const { baptismSessionId } = await import("../../types/stage.js");

const KEY = "st1:plan-1:bap-route";
const DATE = "2026-09-20";

function timeline() {
  return {
    serviceKey: KEY,
    serviceTypeId: "st1",
    serviceTypeName: "Weekend",
    planId: "plan-1",
    planTitle: "Sunday Gathering",
    seriesTitle: null,
    serviceDate: DATE,
    serviceTimeId: "t-1",
    serviceTimeStartsAt: null,
    startedAt: `${DATE}T09:00:00.000Z`,
    endedAt: `${DATE}T10:30:00.000Z`,
    items: [],
  };
}

const BAPTISM_CSV = [
  "at,event,mode,phase,personNumber,baptismIndex,segmentMs,itemId,item,detail",
  "2026-09-20T09:40:00.000Z,start,per-person,testimony,1,0,0,,,",
  "2026-09-20T09:42:00.000Z,testimony-end,per-person,testimony,1,0,120000,,,",
  "2026-09-20T09:42:00.000Z,finish,per-person,testimony,1,0,0,,,",
  "",
].join("\n");

after(async () => {
  serviceTimelineRecorder.forget(KEY);
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe("POST /api/baptism/rebuild", () => {
  beforeEach(async () => {
    serviceTimelineRecorder.forget(KEY);
    await serviceTimelineStore.upsert(timeline() as never);
    for (const s of (await baptismStore.listSessions()).filter((s) => s.serviceKey === KEY)) {
      await baptismStore.deleteSession(s.id);
    }
    await fs.rm(serviceDirPath(KEY, DATE), { recursive: true, force: true });
  });

  it("rejects a body with no serviceKey", async () => {
    const out = await callRoute(historyRoutes, "/api/baptism/rebuild", { method: "POST", body: {} });
    assert.equal(out.status, 400, `expected 400, got ${out.status}: ${out.body}`);
  });

  it("refuses with 409 when the service has no baptism.csv at all", async () => {
    let thrown: unknown;
    try {
      await callRoute(historyRoutes, "/api/baptism/rebuild", { method: "POST", body: { serviceKey: KEY } });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, "a service with no baptism archive answered as though it rebuilt something");
    assert.equal(handlerErrorStatus(thrown), 409);
    assert.match((thrown as Error).message, /No raw rows exist for this recording/);
    // Two DIFFERENT 409s (this one, and "the service is recording" below) are
    // otherwise indistinguishable by status alone — a client cannot decide
    // what to do next without a machine-readable reason. This is the ONE way
    // a session recorded before the raw layer existed (a timeline record, no
    // baptism.csv) answers, and it must not read as "still recording".
    assert.equal((thrown as { code?: string }).code, "no-raw-rows");
  });

  it("refuses with a sentence while that service is recording", async () => {
    const dir = serviceDirPath(KEY, DATE);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "baptism.csv"), BAPTISM_CSV, "utf8");

    const held = serviceTimelineRecorder as unknown as {
      current: unknown;
      currentKey: string | null;
      lastLiveAt: number;
    };
    held.current = { serviceKey: KEY, endedAt: null, items: [] };
    held.currentKey = KEY;
    held.lastLiveAt = Date.now();

    let thrown: unknown;
    try {
      await callRoute(historyRoutes, "/api/baptism/rebuild", { method: "POST", body: { serviceKey: KEY } });
    } catch (err) {
      thrown = err;
    } finally {
      serviceTimelineRecorder.forget(KEY);
    }

    assert.ok(thrown, "the route did not refuse a live service");
    assert.equal(handlerErrorStatus(thrown), 409);
    assert.equal(
      (thrown as Error).message,
      "That service is recording right now — it cannot be rebuilt until it ends.",
    );
    assert.equal((thrown as { code?: string }).code, "live", "must be tellable apart from the no-raw-rows 409 above");
    assert.equal((await baptismStore.listSessions()).filter((s) => s.serviceKey === KEY).length, 0, "a refused rebuild wrote anyway");
  });

  it("rebuilds a session from the raw rows, on disk, through the real route", async () => {
    const dir = serviceDirPath(KEY, DATE);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "baptism.csv"), BAPTISM_CSV, "utf8");

    const out = await callRoute(historyRoutes, "/api/baptism/rebuild", {
      method: "POST",
      body: { serviceKey: KEY },
    });

    assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);
    assert.deepEqual(out.json, {
      rows: 3, sessions: 1, updated: 0, added: 1, unchanged: 0, newer: 0, disagreeing: 0, invalid: 0, kept: 0, full: 0,
      restoredIds: [baptismSessionId("2026-09-20T09:40:00.000Z")],
    });

    const sessions = (await baptismStore.listSessions()).filter((s) => s.serviceKey === KEY);
    assert.equal(sessions.length, 1, "the rebuilt session did not land in the store");
    assert.equal(sessions[0]!.title, "Sunday Gathering", "identity comes from the timeline record");
    assert.equal(sessions[0]!.people.length, 1);
    assert.equal(sessions[0]!.people[0]!.testimonyMs, 120_000);
  });

  it("a second rebuild of the same rows changes nothing new (idempotent)", async () => {
    const dir = serviceDirPath(KEY, DATE);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "baptism.csv"), BAPTISM_CSV, "utf8");

    await callRoute(historyRoutes, "/api/baptism/rebuild", { method: "POST", body: { serviceKey: KEY } });
    const second = await callRoute(historyRoutes, "/api/baptism/rebuild", {
      method: "POST",
      body: { serviceKey: KEY },
    });

    assert.equal(second.status, 200, `expected 200, got ${second.status}: ${second.body}`);
    // The second rebuild reproduces the SAME session exactly — that is
    // "unchanged", not "updated": nothing about it actually differs, so
    // nothing is written the second time either.
    assert.deepEqual(second.json, {
      rows: 3, sessions: 1, updated: 0, added: 0, unchanged: 1, newer: 0, disagreeing: 0, invalid: 0, kept: 0, full: 0,
      restoredIds: [],
    });
    assert.equal((await baptismStore.listSessions()).filter((s) => s.serviceKey === KEY).length, 1, "a re-run duplicated the session");
  });

  // The standalone rebuild must wrap its write exactly like
  // rebuildServiceRecords does — no absolute path, no raw fs error message,
  // reaching the response or (by extension) the header's toast.
  it("wraps a write failure: no path in the response, and a [baptism] line names the reason", async () => {
    const dir = serviceDirPath(KEY, DATE);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "baptism.csv"), BAPTISM_CSV, "utf8");

    const original = baptismStore.mergeRebuilt.bind(baptismStore);
    baptismStore.mergeRebuilt = async () => {
      throw new Error("EACCES: permission denied, open '/var/data/.baptism.json.21844.2.tmp'");
    };
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    let thrown: unknown;
    try {
      await callRoute(historyRoutes, "/api/baptism/rebuild", { method: "POST", body: { serviceKey: KEY } });
    } catch (err) {
      thrown = err;
    } finally {
      baptismStore.mergeRebuilt = original;
      console.warn = realWarn;
    }

    assert.ok(thrown, "a write failure answered as though it had succeeded");
    assert.equal(handlerErrorStatus(thrown), 500);
    assert.equal(
      (thrown as Error).message,
      "That recording could not be rebuilt, and nothing was changed. The log says why.",
      "the raw filesystem error must not reach the response",
    );
    assert.doesNotMatch(
      (thrown as Error).message,
      /var\/data|EACCES/,
      `the absolute path or errno leaked into the response: ${(thrown as Error).message}`,
    );
    // The response is deliberately generic; the reason has to actually reach
    // the log, or an operator debugging this at 9am on a Sunday has nothing
    // to read. A test that only checks the response's own wording cannot
    // fail if this line were removed entirely.
    const line = warnings.find((w) => w.includes("[baptism]") && w.includes(KEY));
    assert.ok(line, `expected a [baptism] line naming ${KEY}'s failure; got: ${JSON.stringify(warnings)}`);
    assert.match(line!, /failed/);
    assert.match(line!, /EACCES/, "the LOG line (never the response) is where the real reason belongs");
  });

  // The log line's own leading count must mean the same thing as the
  // response's `sessions` field. A rebuild that only found the store's own
  // correction newer than its rows writes nothing, but it DID find a session
  // that corresponds to one now in the store — the response says `sessions:
  // 1`, and the log line must not say "0 sessions" right beside it.
  it("a newer-only rebuild logs the same session count the response reports", async () => {
    const dir = serviceDirPath(KEY, DATE);
    await fs.mkdir(dir, { recursive: true });
    const rowStart = "2026-09-20T09:40:00.000Z";
    const rowFinish = "2026-09-20T09:41:00.000Z";
    await fs.writeFile(
      path.join(dir, "baptism.csv"),
      [
        "at,event,mode,phase,personNumber,baptismIndex,segmentMs,itemId,item,detail",
        `${rowStart},start,per-person,testimony,1,0,0,,,`,
        `${rowFinish},testimony-end,per-person,testimony,1,0,60000,,,`,
        `${rowFinish},finish,per-person,testimony,1,0,60000,,,`,
        "",
      ].join("\n"),
      "utf8",
    );
    // The store's own finish is 200ms LATER than the row's — a correction
    // the rows cannot show, well past the 100ms tie band.
    const storedFinish = "2026-09-20T09:41:00.200Z";
    await baptismStore.addSession({
      id: baptismSessionId(rowStart),
      startedAt: rowStart,
      finishedAt: storedFinish,
      people: [{ testimonyMs: 60_200, baptizeMs: 0 }],
      title: "Sunday Gathering",
      serviceTypeId: "st1",
      planId: "plan-1",
      serviceKey: KEY,
    } as never);

    const logs: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    let out: Awaited<ReturnType<typeof callRoute>>;
    try {
      out = await callRoute(historyRoutes, "/api/baptism/rebuild", { method: "POST", body: { serviceKey: KEY } });
    } finally {
      console.log = realLog;
    }

    assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);
    const json = out.json as { sessions: number; newer: number };
    assert.equal(json.newer, 1, "precondition: the store's own correction must read as newer, not updated");
    assert.equal(json.sessions, 1, "precondition: the response counts a newer session as one that corresponds to the store");

    const line = logs.find((l) => l.includes("[baptism] rebuild:") && l.includes(KEY));
    assert.ok(line, `expected a [baptism] rebuild summary line; got: ${JSON.stringify(logs)}`);
    assert.match(
      line!,
      /rebuild: 1 sessions from/,
      `the log line's own count must agree with the response's sessions:${json.sessions}, not read "0 sessions": ${line}`,
    );
  });
});

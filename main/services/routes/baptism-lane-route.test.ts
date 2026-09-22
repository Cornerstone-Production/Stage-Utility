// GET /api/baptism/lane?serviceKey= — a service's baptism session lane.
//
// Driven through the real route, with the real timer writing real rows into a
// real data directory, because what is under test is the join the route makes:
// which record supplies the service DATE (and so the directory), that the
// queued appends are flushed before the read, and that an unreadable archive is
// a failure rather than an empty lane. The lane derivation itself is
// baptism-lane.test.ts and baptism-lane-roundtrip.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { BaptismSpan } from "../archive/baptism-lane.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-lane-route-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { historyRoutes } = await import("./history-routes.js");
const { callRoute } = await import("./route-harness.js");
const { handlerErrorStatus } = await import("../remote-server.js");
const { serviceTimelineStore } = await import("../service-timeline-store.js");
const { serviceTimelineRecorder } = await import("../service-timeline-recorder.js");
const { baptismTimerService: timer } = await import("../baptism-timer-service.js");
const { addBroadcastListener } = await import("../broadcaster.js");
const { serviceDirPath } = await import("../archive/archive-paths.js");

/** Keys name the occurrence by its service-time id: no date anywhere in them. */
const DATE = "2026-09-20";

type Held = { current: { serviceKey: string; serviceDate: string; endedAt: string | null } | null };
const recorder = serviceTimelineRecorder as unknown as Held;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function timeline(serviceKey: string) {
  return {
    serviceKey,
    serviceTypeId: "st1",
    serviceTypeName: null,
    planId: "plan1",
    planTitle: "Sunday",
    seriesTitle: null,
    serviceDate: DATE,
    serviceTimeId: serviceKey.split(":")[2],
    serviceTimeStartsAt: null,
    startedAt: `${DATE}T15:00:00.000Z`,
    endedAt: null,
    items: [],
  };
}

/** The timer idle and grouped, BEFORE the service opens, so the reset row lands
 *  nowhere and the next press is the first row this service's archive gets. */
function idleTimer(): void {
  recorder.current = null;
  timer.reset();
  timer.setMode("grouped");
}

async function lane(serviceKey: string) {
  return callRoute(historyRoutes, `/api/baptism/lane?serviceKey=${encodeURIComponent(serviceKey)}`);
}

const shape = (spans: BaptismSpan[]) => spans.map((s) => `${s.kind} ${s.person}${s.endedAt === null ? " (running)" : ""}`);

describe("GET /api/baptism/lane", () => {
  it("reads the date off the service's stored timeline record, not its key", async () => {
    const key = "st1:plan1:2251";
    await serviceTimelineStore.upsert(timeline(key) as never);
    idleTimer();
    recorder.current = { serviceKey: key, serviceDate: DATE, endedAt: null };
    timer.start();
    await sleep(20);
    timer.next();
    await sleep(20);
    timer.finish();
    // The recorder has moved on; only the store names this service's date now.
    recorder.current = null;

    const out = await lane(key);
    assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);
    assert.deepEqual(shape((out.json as { spans: BaptismSpan[] }).spans), ["testimony 1", "testimony 2"]);
  });

  it("reads a service opened seconds ago off the live record, before the store has it", async () => {
    // The recorder persists on a debounce, so a new record is in the store only
    // seconds later. A lane fetched in that window must not come back empty.
    const key = "st1:plan1:2252";
    idleTimer();
    recorder.current = { serviceKey: key, serviceDate: DATE, endedAt: null };
    timer.start();

    const out = await lane(key);
    assert.equal(await serviceTimelineStore.get(key), null, "sanity: the store has not seen this service");
    assert.deepEqual(shape((out.json as { spans: BaptismSpan[] }).spans), ["testimony 1 (running)"]);
    timer.reset();
  });

  it("includes the press whose baptism:state push the fetch is answering", async () => {
    // emitRaw queues the append without awaiting it and commit() broadcasts in
    // the same call, so a fetch made ON the push races the row to disk. The
    // Baptisms tab refetches on exactly that push.
    const key = "st1:plan1:2253";
    idleTimer();
    recorder.current = { serviceKey: key, serviceDate: DATE, endedAt: null };

    let fetchOnPush = false;
    let fetched: ReturnType<typeof lane> | null = null;
    addBroadcastListener((channel) => {
      if (fetchOnPush && channel === "baptism:state") {
        fetchOnPush = false;
        fetched = lane(key);
      }
    });

    fetchOnPush = true;
    timer.start(); // the first row this service's archive gets
    const first = await fetched!;
    assert.deepEqual(shape((first.json as { spans: BaptismSpan[] }).spans), ["testimony 1 (running)"]);

    await sleep(20);
    fetchOnPush = true;
    timer.next();
    const second = await fetched!;
    assert.deepEqual(shape((second.json as { spans: BaptismSpan[] }).spans), ["testimony 1", "testimony 2 (running)"]);
    timer.reset();
  });

  it("answers no spans for a service that recorded no baptism archive", async () => {
    const key = "st1:plan1:2254";
    await serviceTimelineStore.upsert(timeline(key) as never);
    const out = await lane(key);
    assert.equal(out.status, 200);
    assert.deepEqual(out.json, { spans: [] });
  });

  it("answers no spans for a key no record names", async () => {
    const out = await lane("st1:plan1:never-recorded");
    assert.equal(out.status, 200);
    assert.deepEqual(out.json, { spans: [] });
  });

  it("fails, rather than answering an empty lane, when the archive exists and cannot be read", async () => {
    // readArchiveRows answers null for a file it cannot read, the same as for
    // one that is not there. A directory where baptism.csv should be is the
    // unreadable case, without depending on file permissions.
    const key = "st1:plan1:2255";
    await serviceTimelineStore.upsert(timeline(key) as never);
    await fs.mkdir(path.join(serviceDirPath(key, DATE), "baptism.csv"), { recursive: true });

    let thrown: unknown;
    try {
      await lane(key);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, "an unreadable archive answered as though the service had no baptisms");
    assert.equal(handlerErrorStatus(thrown), 500);
    assert.match((thrown as Error).message, /present for this service, and none could be read/);
    assert.doesNotMatch((thrown as Error).message, /\//, "a path leaked into a LAN-visible response");
  });

  it("answers 400 without a serviceKey", async () => {
    const out = await callRoute(historyRoutes, "/api/baptism/lane");
    assert.equal(out.status, 400);
  });
});

describe("invoke('baptism:lane') reaches this route", () => {
  it("builds the path the route serves, end to end through the real handler", async () => {
    // route-coverage.test.ts accepts any path under /api/baptism, so a client
    // asking for /api/baptism/lanes would pass it. This runs the renderer's own
    // invoke() against the real route instead of a stubbed answer.
    const key = "st1:plan1:2251"; // recorded by the first test in this file
    const { invoke } = await import("../../../renderer/lib/api.js");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const out = await callRoute(historyRoutes, String(input));
      if (!out.responded) return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
      return new Response(out.body, { status: out.status ?? 200 });
    }) as typeof fetch;
    try {
      const got = await invoke<{ spans: BaptismSpan[] }>("baptism:lane", { serviceKey: key });
      assert.deepEqual(shape(got.spans), ["testimony 1", "testimony 2"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

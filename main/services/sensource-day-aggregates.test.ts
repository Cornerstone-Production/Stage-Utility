// A rejected day-aggregate request must not blank the tiles beside it, and a
// rejected token must not start a fight with the instance next door.
//
// Both halves are the same production morning. The Vea day-aggregate call
// (entityType=space, occupancy max/min/avg) 401d on roughly alternating polls
// while the traffic call succeeded, so the broadcast alternated between
//
//   occupancy:1510 peak:1511 capacity:2120
//   occupancy:1509 peak:null min:null  avg:null capacity:null
//
// every 15 seconds, and every people-counter tile bound to peak, avg or capacity
// flashed a dash on every other poll. Nothing was actually unknown: the peak of
// a day does not become unknown because one request was rejected.
//
// The 401s themselves were two instances (production and a spare Mac mini)
// sharing ONE Vea API client. Vea keeps one live token per client, so each
// instance's re-mint invalidated the other's token, whose next request 401d and
// minted again — until the exchange endpoint itself answered 429. The old code's
// reflex on a 401 was exactly "drop the token and mint another, inline", which
// is that loop.
//
// These cases drive the REAL poll (connect()) against a stubbed global fetch,
// counting the requests it issues and reading the DTOs it emits, rather than
// calling the reducers directly — every part under test here is about which
// request goes out and what survives when one does not.

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-sensource-day-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { setAppTimeZone, zonedDateKey } = await import("./app-timezone.js");
// Fixed for the whole file: the production box runs UTC and the app time zone is
// what every date decision here must go through. I8's case is meaningless
// without it, and every other case's fixtures are built from the same helper.
setAppTimeZone("America/Chicago");
const { sensourceService } = await import("./sensource-service.js");
import { errorMessage } from "./errors.js";
import type { PeopleCountDTO } from "../types/live.js";
import type { SenSourceConfig } from "./sensource-service.js";

/** The private surface these cases drive. Reaching in is deliberate: the point
 *  is to run the real connect(), not a re-implementation of it. */
type Poller = {
  cfg: SenSourceConfig | null;
  running: boolean;
  connect: () => Promise<void>;
  emit: (dto: PeopleCountDTO) => void;
  last: PeopleCountDTO;
  token: string | null;
  tokenExpiresAt: number;
  tokenIssuedAt: number;
  tokenGen: number;
  authInFlight: Promise<string> | null;
  lastExchangeAt: number;
  exchangeBlockedUntil: number;
  lastSharedClientLogAt: number;
  carriedDay: {
    peak: number;
    min: number;
    avg: number;
    capacity: number | null;
    attendance: number;
    zoneAttendance: number;
    at: number;
    dateKey: string;
  } | null;
  degraded: Map<string, boolean>;
  loggedAuthBodies: Set<string>;
  zonesCache: unknown;
  spacesCache: unknown;
  configure: (cfg: SenSourceConfig) => void;
  scheduleIn: (ms: number) => void;
  scheduleReconnect: () => void;
};
const svc = sensourceService as unknown as Poller;

const CFG: SenSourceConfig = {
  clientId: "test-client",
  clientSecret: "test-secret",
  apiToken: null,
  pollSeconds: 15,
  locationId: null,
  zoneIds: [],
};

/** Every request the stub saw, in order. */
/** The token endpoint, matched on the exact host — not a substring, which CodeQL
 *  rightly flags: "auth.sensourceinc.com" can appear inside any URL. */
const isAuthHost = (url: string): boolean => new URL(url).hostname === "auth.sensourceinc.com";

let requests: string[] = [];
/** DTOs the service actually published this run. */
let emitted: PeopleCountDTO[] = [];
/** Console lines the service wrote, joined per call. */
let logs: string[] = [];
/** The Authorization header each /data/traffic request carried, in order. */
let trafficAuth: string[] = [];

const realFetch = globalThis.fetch;
const realNow = Date.now;
const realWarn = console.warn;
const realLog = console.log;
const realError = console.error;
/** Wall clock the service reads; every case advances it explicitly. */
let clock = Date.UTC(2026, 8, 6, 15, 0, 0);

function captureConsole(): void {
  const take =
    (level: string) =>
    (...args: unknown[]): void => {
      logs.push(`${level} ${args.map((a) => (a instanceof Error ? errorMessage(a) : String(a))).join(" ")}`);
    };
  console.warn = take("warn");
  console.log = take("log");
  console.error = take("error");
}

/** Rows the two data endpoints answer with when they are healthy.
 *
 * TWO zones, deliberately. The space endpoint counts the auditorium's doors
 * (1600 in); the zone endpoint also sees a cafe nobody is counting attendance
 * from (420 more). The two sources therefore disagree by 420, which is what
 * makes a silent switch between them visible instead of invisible. */
const TRAFFIC = {
  results: [
    { zoneId: "z1", name: "Lobby", sumins: 1600, sumouts: 90 },
    { zoneId: "z2", name: "Cafe", sumins: 420, sumouts: 20 },
  ],
};
/** Σ ins over both zones — what buildDto derives before any override. */
const ZONE_ATTENDANCE = 2020;
/** Σ sumins over the spaces — what the authoritative total publishes. */
const SPACE_ATTENDANCE = 1600;
const DAY = {
  results: [
    { spaceId: "s1", sumins: 1600, sumouts: 90, maxoccupancy: 1511, minoccupancy: 0, avgoccupancy: "812.5" },
  ],
};
const MINUTE = { results: [{ spaceId: "s1", recordDate_minute_1: "2026-09-06T15:00:00", maxoccupancy: 1510 }] };
const SPACES = { results: [{ spaceId: "s1", name: "Auditorium", locationId: "l1", maxCapacity: 2120 }] };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

interface StubOptions {
  /** Decide the response for a /data/occupancy day-aggregate request. */
  dayStatus?: () => number;
  /** Decide the response for a /data/traffic request. */
  trafficStatus?: () => number;
  /** Decide the response for every /data/… request (401 → auth failure). */
  dataStatus?: () => number;
  /** Response for the token exchange. */
  exchange?: () => Response;
  /** Hold the traffic response back this long — the poll's requests are issued
   *  together, so this is how "which answer arrived first" is controlled. */
  trafficDelayMs?: number;
  /** Answer the /space listing with nothing, i.e. a site with no spaces. */
  noSpaces?: boolean;
  /** Answer the /space listing with this status instead of a listing. */
  spaceStatus?: () => number;
  /** Answer the /sensor listing with this status (the zone→location join). */
  sensorStatus?: () => number;
  /** The body of a rejected response — vary it to prove the log is not keyed on
   *  the text, which is how a timestamped body defeated the old cap. */
  rejectBody?: () => string;
}

/** Stand in for the whole Vea API. Records each request path, and the token each
 *  one carried, so a test can assert that a retry reused the same one. */
function stubFetch(opts: StubOptions = {}): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    const auth = new Headers(init?.headers ?? {}).get("authorization") ?? "";
    if (url.includes("/data/traffic")) trafficAuth.push(auth);
    if (isAuthHost(url)) {
      return opts.exchange?.() ?? json({ access_token: `t${requests.length}`, expires_in: 3600 });
    }
    const dataStatus = opts.dataStatus?.() ?? 200;
    if (dataStatus !== 200) {
      if (opts.trafficDelayMs && url.includes("/data/traffic")) {
        await new Promise((r) => setTimeout(r, opts.trafficDelayMs));
      }
      return new Response(opts.rejectBody?.() ?? "token is invalid or expired", { status: dataStatus });
    }
    if (url.includes("/space")) {
      const st = opts.spaceStatus?.() ?? 200;
      if (st !== 200) return new Response("space listing rejected", { status: st });
      return json(opts.noSpaces ? { results: [] } : SPACES);
    }
    if (url.includes("/sensor")) {
      const st = opts.sensorStatus?.() ?? 200;
      return st === 200 ? json({ results: [] }) : new Response("sensor listing rejected", { status: st });
    }
    if (url.includes("/zone") || url.includes("/site")) return json({ results: [] });
    if (url.includes("/data/traffic")) {
      if (opts.trafficDelayMs) await new Promise((r) => setTimeout(r, opts.trafficDelayMs));
      const status = opts.trafficStatus?.() ?? 200;
      return status === 200 ? json(TRAFFIC) : new Response("traffic rejected", { status });
    }
    if (url.includes("/data/occupancy")) {
      if (url.includes("dateGroupings=minute")) return json(MINUTE);
      const status = opts.dayStatus?.() ?? 200;
      return status === 200
        ? json(DAY)
        : new Response(opts.rejectBody?.() ?? "day aggregates rejected", { status });
    }
    return json({ results: [] });
  }) as typeof fetch;
}

const dayRequests = (): string[] =>
  requests.filter((u) => u.includes("/data/occupancy") && !u.includes("dateGroupings=minute"));
const trafficRequests = (): string[] => requests.filter((u) => u.includes("/data/traffic"));
const exchangeRequests = (): string[] => requests.filter(isAuthHost);

/** Reset every scrap of poller state a previous case could have left behind. */
function resetService(): void {
  svc.cfg = { ...CFG };
  svc.running = true;
  svc.token = null;
  svc.tokenExpiresAt = 0;
  svc.tokenIssuedAt = 0;
  svc.tokenGen = 0;
  svc.authInFlight = null;
  svc.lastExchangeAt = 0;
  svc.exchangeBlockedUntil = 0;
  svc.lastSharedClientLogAt = 0;
  svc.carriedDay = null;
  svc.degraded = new Map();
  svc.loggedAuthBodies = new Set();
  svc.zonesCache = null;
  svc.spacesCache = null;
  // goOffline() emits only when the last snapshot was connected, so a previous
  // case leaving it connected would put an OFFLINE frame in `emitted` here.
  svc.last = { connected: false, updatedAt: null, total: { attendance: null, occupancy: null }, zones: [] };
  requests = [];
  trafficAuth = [];
  emitted = [];
  logs = [];
}

/** One poll, with the scheduler stubbed out so nothing is left pending. */
async function poll(): Promise<void> {
  await svc.connect();
}

describe("SenSource day aggregates", () => {
  beforeEach(() => {
    resetService();
    clock = Date.UTC(2026, 8, 6, 15, 0, 0);
    Date.now = () => clock;
    // The poll re-arms itself through these; a test must not leave a timer live.
    svc.scheduleIn = () => {};
    svc.scheduleReconnect = () => {};
    svc.emit = (dto: PeopleCountDTO) => {
      emitted.push(dto);
      svc.last = dto;
    };
    captureConsole();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    Date.now = realNow;
    console.warn = realWarn;
    console.log = realLog;
    console.error = realError;
    svc.running = false;
    svc.cfg = null;
  });

  it("carries the day aggregates through a 401 on alternating polls", async () => {
    // THE bug, exactly as production wrote it: the day call fails on every other
    // poll, traffic succeeds throughout, and the tiles blank on the failures.
    //
    // Per POLL, not per request: the 401 retry inside apiGet would otherwise make
    // the second attempt of a failing poll succeed and there would be no failure
    // left to carry through.
    let dayOk = true;
    stubFetch({ dayStatus: () => (dayOk ? 200 : 401) });

    for (let i = 0; i < 4; i++) {
      clock += 15_000;
      dayOk = i % 2 === 0;
      await poll();
    }

    assert.equal(emitted.length, 4, "a poll did not publish");
    for (const [i, dto] of emitted.entries()) {
      assert.notEqual(dto.total.peak, null, `poll ${i + 1} published a null peak`);
      assert.notEqual(dto.total.min, null, `poll ${i + 1} published a null min`);
      assert.notEqual(dto.total.avg, null, `poll ${i + 1} published a null avg`);
      assert.notEqual(dto.total.capacity, null, `poll ${i + 1} published a null capacity`);
    }
    assert.equal(emitted[1].total.peak, 1511, "the carried peak was not the last good one");
    assert.equal(emitted[1].total.dayAggregatesStale, true, "a carried total did not say so");
    assert.equal(emitted[0].total.dayAggregatesStale, undefined, "a live total was marked stale");

    // Transitions, not polls. Two separate outages here (polls 2 and 4, with a
    // good poll between them), so two lines going down and one coming back up —
    // and never the four the old per-poll warn would have written.
    const carried = logs.filter((l) => l.includes("day aggregates unavailable"));
    const back = logs.filter((l) => l.includes("day aggregates are available again"));
    assert.equal(carried.length, 2, `the carry-forward logged ${carried.length} times:\n${carried.join("\n")}`);
    assert.equal(back.length, 1, `the recovery logged ${back.length} times`);
    assert.match(carried[0], /HTTP 401/, "the log line did not say what Vea answered");
    assert.match(carried[0], /carrying the last good values from \d\d:\d\d:\d\d/);
  });

  it("logs one line for a RUN of rejected polls, not one per poll", async () => {
    // The other half of the same rule, and the one the old code broke: an outage
    // that lasts writes a line every 15s until it ends. Three consecutive
    // failures after one good poll.
    let dayOk = true;
    stubFetch({ dayStatus: () => (dayOk ? 200 : 401) });

    for (let i = 0; i < 4; i++) {
      clock += 15_000;
      dayOk = i === 0;
      await poll();
    }

    assert.equal(emitted.length, 4, "a poll did not publish");
    for (const [i, dto] of emitted.entries()) {
      assert.equal(dto.total.peak, 1511, `poll ${i + 1} lost the peak`);
      assert.equal(dto.total.capacity, 2120, `poll ${i + 1} lost the capacity`);
    }
    const carried = logs.filter((l) => l.includes("day aggregates unavailable"));
    assert.equal(
      carried.length,
      1,
      `three failing polls wrote ${carried.length} lines:\n${carried.join("\n")}`,
    );
  });

  it("keeps attendance continuous when the day request fails", async () => {
    // C2. The zone-derived total counts doors the space total does not, so
    // publishing it on the degraded polls made attendance alternate 1600 / 2020
    // every 15 seconds — in the field attendance-recorder folds into service
    // history, which is to say a corrupted record, not just a jumpy tile.
    let dayOk = true;
    stubFetch({ dayStatus: () => (dayOk ? 200 : 401) });

    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      dayOk = i % 2 === 0;
      await poll();
      clock += 15_000;
      seen.push(emitted.at(-1)!.total.attendance!);
    }

    assert.deepEqual(
      seen,
      [SPACE_ATTENDANCE, SPACE_ATTENDANCE, SPACE_ATTENDANCE, SPACE_ATTENDANCE],
      `attendance swung between the space and zone sources: ${seen.join(" → ")}`,
    );
    assert.ok(
      !seen.includes(ZONE_ATTENDANCE),
      `the raw zone total (${ZONE_ATTENDANCE}) was published as attendance`,
    );
  });

  it("advances a carried attendance by what the doors counted since", async () => {
    // The carry is not a freeze: people keep arriving while the day endpoint is
    // down, and the zone delta is the only live evidence of how many.
    stubFetch({ dayStatus: () => 401 });
    svc.carriedDay = {
      peak: 1511,
      min: 3,
      avg: 812,
      capacity: 2120,
      attendance: SPACE_ATTENDANCE,
      // 120 fewer than the fixture reports now, i.e. 120 have entered since.
      zoneAttendance: ZONE_ATTENDANCE - 120,
      at: clock - 60_000,
      dateKey: zonedDateKey(clock),
    };

    await poll();

    assert.equal(
      emitted.at(-1)!.total.attendance,
      SPACE_ATTENDANCE + 120,
      "the carried attendance ignored the arrivals the doors counted since",
    );
  });

  it("stops carrying values older than ten minutes", async () => {
    stubFetch({ dayStatus: () => 401 });
    // A good set from eleven minutes ago — older than DAY_AGGREGATE_STALE_MS.
    svc.carriedDay = {
      peak: 1511,
      min: 3,
      avg: 812,
      capacity: 2120,
      attendance: SPACE_ATTENDANCE,
      zoneAttendance: ZONE_ATTENDANCE,
      at: clock - 11 * 60_000,
      dateKey: zonedDateKey(clock),
    };

    await poll();

    const dto = emitted.at(-1)!;
    assert.equal(dto.total.peak, null, "an eleven-minute-old peak was published as if it were today's");
    assert.equal(dto.total.min, null, "an eleven-minute-old min was published");
    assert.equal(dto.total.avg, null, "an eleven-minute-old avg was published");
    assert.match(
      logs.find((l) => l.includes("day aggregates unavailable")) ?? "",
      /nothing recent enough to carry/,
      "the log claimed to be carrying values it had discarded",
    );
  });

  it("reads the rollover in the APP time zone, not the host's", async () => {
    // I8. 03:00 UTC on the 7th is 22:00 on the 6th in Chicago — still the same
    // service day, and the carry must survive. A host-clock date key says the
    // 7th and throws away a peak recorded ninety minutes earlier. The production
    // box runs UTC, so this is the normal case at every Sunday evening service.
    clock = Date.UTC(2026, 8, 7, 3, 0, 0);
    assert.equal(zonedDateKey(clock), "2026-09-06", "the fixture is not the case it claims to be");
    stubFetch({ dayStatus: () => 401 });
    svc.carriedDay = {
      peak: 1511,
      min: 3,
      avg: 812,
      capacity: 2120,
      attendance: SPACE_ATTENDANCE,
      zoneAttendance: ZONE_ATTENDANCE,
      // One minute old, so the ten-minute rule is not what is being tested here.
      at: clock - 60_000,
      dateKey: "2026-09-06",
    };

    await poll();

    assert.notEqual(svc.carriedDay, null, "an evening service's aggregates were dropped at UTC midnight");
    assert.equal(emitted.at(-1)!.total.peak, 1511, "the peak was lost to the host clock's date");
    assert.equal(
      logs.filter((l) => l.includes("the date rolled over")).length,
      0,
      "a rollover was reported in the middle of a service",
    );
  });

  it("warns once, not per poll, when the /sensor join fails", async () => {
    // The zone→location join is best-effort and its failure is not fatal, which
    // is exactly why it wrote a line every poll for as long as it lasted. Fifth
    // and last of the warn-per-poll sites in this file.
    stubFetch({ sensorStatus: () => 500 });
    svc.cfg = { ...CFG, locationId: "l1" };

    for (let i = 0; i < 3; i++) {
      svc.zonesCache = null; // the 5-minute cache has expired, so the join re-runs
      await poll();
      clock += 15_000;
    }

    const said = logs.filter((l) => l.includes("/sensor join failed"));
    assert.equal(said.length, 1, `three polls wrote ${said.length} /sensor join warnings`);
  });

  it("warns once, not per poll, when a selected location maps to no zones", async () => {
    // The THIRD copy of the same mistake in this file: a misconfiguration that
    // lasts for weeks wrote a line on every poll. Found by grepping for the
    // shape after fixing the first two, per the repeated-pattern rule.
    stubFetch();
    svc.cfg = { ...CFG, locationId: "l1" }; // the /zone listing answers with none

    for (let i = 0; i < 3; i++) {
      await poll();
      clock += 15_000;
    }

    const said = logs.filter((l) => l.includes("no zones map to it"));
    assert.equal(said.length, 1, `three polls wrote ${said.length} zone-scope warnings`);
  });

  it("never overwrites a known capacity with an unreadable one", async () => {
    // I3. The day response is fine and the space LISTING is not, so capacity —
    // which only the listing knows — reads null. Writing that null into the DTO
    // and into the carry blanks the "% of capacity" readout on a poll where
    // nothing about the capacity has changed, and loses the number for every
    // later poll too.
    let spaceOk = true;
    stubFetch({ spaceStatus: () => (spaceOk ? 200 : 500) });

    await poll(); // capacity 2120, carried
    assert.equal(emitted.at(-1)!.total.capacity, 2120, "the healthy poll did not read the capacity");

    spaceOk = false;
    svc.spacesCache = null; // the 5-minute cache has expired
    clock += 15_000;
    await poll();

    assert.equal(emitted.at(-1)!.total.capacity, 2120, "an unreadable listing blanked a known capacity");
    assert.equal(svc.carriedDay?.capacity, 2120, "the carry forgot the capacity it was holding");
  });

  it("reports a space listing that cannot be read, once", async () => {
    // I4. Three callers each turned this failure into a fallback value — "no
    // spaces", "no scope", "no capacity" — so a listing answering 500 for an
    // hour looked exactly like a site that has no spaces. Same wrong question
    // B3 was about, one layer down.
    stubFetch({ dayStatus: () => 200, spaceStatus: () => 500 });

    for (let i = 0; i < 3; i++) {
      await poll();
      clock += 15_000;
    }

    const said = logs.filter((l) => l.includes("space listing could not be read"));
    assert.equal(
      said.length,
      1,
      `three polls with an unreadable space listing wrote ${said.length} lines:\n${logs.join("\n")}`,
    );
    assert.equal(emitted.length, 3, "the poll stopped publishing the counts it did have");
  });

  it("drops carried aggregates when the app time zone rolls into a new day", async () => {
    // Ten minutes is the staleness rule, but midnight is a different one: at
    // 00:02 a peak from 23:58 is under the age limit and belongs to yesterday.
    // The date is the APP time zone's, not the host's — the box runs UTC.
    stubFetch({ dayStatus: () => 401 });
    svc.carriedDay = {
      peak: 1511,
      min: 3,
      avg: 812,
      capacity: 2120,
      attendance: SPACE_ATTENDANCE,
      zoneAttendance: ZONE_ATTENDANCE,
      at: clock - 60_000,
      dateKey: "2026-09-05",
    };
    assert.notEqual(zonedDateKey(clock), "2026-09-05", "the fixture must be a DIFFERENT day");

    await poll();

    assert.equal(svc.carriedDay, null, "yesterday's aggregates were kept into today");
    assert.equal(emitted.at(-1)!.total.peak, null, "yesterday's peak was published as today's");
    assert.equal(
      logs.filter((l) => l.includes("the date rolled over")).length,
      1,
      "the rollover was not reported",
    );
  });

  it("asks for the day aggregates on every poll, like the traffic beside them", async () => {
    // Caching them for a minute was tried and removed: the same response carries
    // today's ATTENDANCE, which moves by ~31 people a minute on an arrival ramp.
    // Freezing that to save four requests is worse than the requests it saves,
    // and request volume was never what caused the 401s.
    stubFetch();

    for (let i = 0; i < 8; i++) {
      await poll();
      clock += 15_000;
    }

    assert.equal(trafficRequests().length, 8, "traffic must be asked for on every poll");
    assert.equal(
      dayRequests().length,
      8,
      `the day aggregates were requested ${dayRequests().length} times across 8 polls; they are not cached`,
    );
    for (const [i, dto] of emitted.entries()) {
      assert.equal(dto.total.peak, 1511, `poll ${i + 1} lost the peak`);
    }
  });
});

describe("SenSource token rejection", () => {
  beforeEach(() => {
    resetService();
    clock = Date.UTC(2026, 8, 6, 15, 0, 0);
    Date.now = () => clock;
    svc.scheduleIn = () => {};
    svc.scheduleReconnect = () => {};
    svc.emit = (dto: PeopleCountDTO) => {
      emitted.push(dto);
      svc.last = dto;
    };
    captureConsole();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    Date.now = realNow;
    console.warn = realWarn;
    console.log = realLog;
    console.error = realError;
    svc.running = false;
    svc.cfg = null;
  });

  it("does not mint a second token when one issued 5s ago is rejected", async () => {
    // The mutual-destruction loop: this instance holds a token minted five
    // seconds ago and every request 401s, because the other instance on the same
    // API client has just authenticated. Minting again invalidates THEIR token,
    // and the two of them walk the exchange endpoint into a 429.
    stubFetch({ dataStatus: () => 401 });
    svc.token = "issued-just-now";
    // A hand-injected token needs a generation: the poll's verdict asks "is the
    // token that was rejected still the one in hand", and generation 0 means
    // "none was ever minted", which is not what this case is about.
    svc.tokenGen = 1;
    svc.tokenIssuedAt = clock - 5_000;
    svc.tokenExpiresAt = clock + 59 * 60_000;

    await poll();

    assert.equal(
      exchangeRequests().length,
      0,
      `a 401 on a 5s-old token sent ${exchangeRequests().length} client-credentials exchange(s) inside the same poll`,
    );
    const shared = logs.filter((l) => l.includes("another instance may be using the same API client"));
    assert.equal(shared.length, 1, `expected one shared-client line, got ${shared.length}:\n${logs.join("\n")}`);
    assert.match(shared[0], /token rejected 5s after issue/);

    assert.equal(svc.token, null, "the rejected token was not marked due for the next poll");

    // The NEXT poll is where a new one is minted — deferred, not inline.
    clock += 15_000;
    await poll();
    assert.equal(exchangeRequests().length, 1, "the deferred re-mint never happened");

    // And the poll after that is held by the 30s floor, so two instances trading
    // rejections cannot walk the exchange endpoint into a 429 between them.
    clock += 15_000;
    await poll();
    assert.equal(
      exchangeRequests().length,
      1,
      "a second exchange went out 15s after the last; MIN_EXCHANGE_GAP_MS is 30s",
    );
    assert.equal(
      logs.filter((l) => l.includes("another instance may be using")).length,
      1,
      "the shared-client warning repeated inside its hour",
    );
  });

  it("does not tear down a token that another request just used successfully", async () => {
    // Production's shape: /data/occupancy 401s while /data/traffic returns 200
    // on the SAME token. Treating that as an auth fault expired the token, made
    // the next poll mint, and stalled the poll after that on the 30s exchange
    // gate — so one failing endpoint cost whole polls, traffic and all.
    let dayOk = true;
    stubFetch({ dayStatus: () => (dayOk ? 200 : 401) });

    await poll(); // proves the token
    const proven = svc.token;
    assert.notEqual(proven, null, "the first poll did not obtain a token");

    dayOk = false;
    clock += 15_000;
    await poll();

    assert.equal(svc.token, proven, "an endpoint's 401 threw away a token that was working");
    assert.equal(exchangeRequests().length, 1, "a proven token was re-minted over one endpoint's 401");
    assert.equal(
      logs.filter((l) => l.includes("another instance may be using")).length,
      0,
      "one endpoint's 401 was blamed on a second instance",
    );
    assert.equal(emitted.at(-1)!.total.peak, 1511, "the poll lost the carried peak as well");
  });

  it("does not re-derive the token inside a 401 retry", async () => {
    // I7. The retry used to ask for a header again. A token expiring inside the
    // 500ms pause was therefore re-minted BY the retry, the rejection was tagged
    // with the new generation, and the poll's verdict read "a token minted
    // moments ago was rejected" — a shared-client accusation the retry
    // manufactured out of its own mint.
    let expired = false;
    stubFetch({
      dataStatus: () => 401,
      // Expire the token the moment the first rejection goes out, i.e. inside
      // the pause before the retry.
      rejectBody: () => {
        if (!expired) {
          expired = true;
          svc.tokenExpiresAt = clock - 1;
        }
        return "token is invalid or expired";
      },
    });
    svc.token = "the-one-that-was-sent";
    svc.tokenGen = 1;
    svc.tokenIssuedAt = clock - 30 * 60_000;
    svc.tokenExpiresAt = clock + 200;

    await poll();

    // The first ATTEMPT and its retry. (What follows is the rollover re-run on a
    // replacement token, which is the verdict's job and is asserted elsewhere.)
    assert.deepEqual(
      trafficAuth.slice(0, 2),
      ["Bearer the-one-that-was-sent", "Bearer the-one-that-was-sent"],
      `the retry was sent with a different token: ${trafficAuth.join(" | ")}`,
    );
    assert.equal(
      logs.filter((l) => l.includes("another instance may be using")).length,
      0,
      "the retry minted a token and then blamed its rejection on a second instance",
    );
  });

  it("caps a Retry-After that would take the count off the air", async () => {
    // M9. A day-long Retry-After, or an HTTP date from a box whose clock is
    // wrong, would otherwise stop the people count for the rest of the service
    // with nothing an operator could do about it.
    let exchanges = 0;
    stubFetch({
      exchange: () => {
        exchanges++;
        return new Response("rate limited", { status: 429, headers: { "retry-after": "86400" } });
      },
    });

    await poll();
    assert.equal(exchanges, 1);
    assert.match(
      logs.find((l) => l.includes("the token exchange is rate-limited")) ?? "",
      /waiting 900s/,
      "a 24-hour Retry-After was honoured in full",
    );

    // Still held at 14 minutes...
    clock += 14 * 60_000;
    await poll();
    assert.equal(exchanges, 1, "the cap released the exchange early");
    // ...and released just past 15.
    clock += 70_000;
    await poll();
    assert.equal(exchanges, 2, "the exchange never resumed after the cap");
  });

  it("publishes nothing from a poll whose configuration was replaced", async () => {
    // M12. A poll is several round-trips long. An operator clearing the
    // credentials mid-poll must not then see counts arrive from the scope they
    // just removed, nor have that scope's aggregates carried for ten minutes.
    stubFetch({
      dayStatus: () => {
        // Reconfigured to something unconfigured, so no new poll starts and what
        // is asserted below is only about the one already in flight.
        svc.configure({ ...CFG, clientId: null, clientSecret: null, apiToken: null });
        return 200;
      },
    });
    svc.token = "old";
    svc.tokenGen = 1;
    svc.tokenIssuedAt = clock - 30 * 60_000;
    svc.tokenExpiresAt = clock + 40 * 60_000;

    await poll();

    assert.equal(emitted.length, 0, "a poll published counts for a configuration that had been replaced");
    assert.equal(svc.carriedDay, null, "the replaced configuration's aggregates were carried forward");
    assert.equal(
      logs.filter((l) => l.includes("reconfigured mid-poll")).length,
      1,
      "the dropped poll was not reported",
    );
  });

  it("keeps the generation of the token that was actually rejected", async () => {
    // C1. The verdict compares the token a request CARRIED with the one in hand.
    // Without that comparison, a token minted while an older request was still
    // in flight is judged by that older request's rejection — it looks seconds
    // old and perfectly good, and gets thrown away with a shared-client
    // accusation attached.
    stubFetch({ dataStatus: () => 401, trafficDelayMs: 400 });
    svc.token = "gen-one";
    svc.tokenGen = 1;
    svc.tokenIssuedAt = clock - 30 * 60_000;
    svc.tokenExpiresAt = clock + 40 * 60_000;

    const inFlight = poll();
    // Mid-flight, a token from somewhere else in the process: the settings page
    // testing the connection, or an expiry racing this poll.
    await new Promise((r) => setTimeout(r, 200));
    svc.token = "gen-two";
    svc.tokenGen = 2;
    svc.tokenIssuedAt = clock;
    svc.tokenExpiresAt = clock + 59 * 60_000;
    await inFlight;

    assert.equal(svc.token, "gen-two", "a token minted mid-poll was thrown away by an older request's 401");
    assert.equal(
      logs.filter((l) => l.includes("another instance may be using")).length,
      0,
      "an older request's rejection was blamed on the token that replaced it",
    );
  });

  it("waits out a 429's Retry-After before exchanging again", async () => {
    let exchanges = 0;
    stubFetch({
      exchange: () => {
        exchanges++;
        return new Response("rate limited", { status: 429, headers: { "retry-after": "120" } });
      },
    });

    await poll(); // no token at all → exchanges, gets 429
    assert.equal(exchanges, 1, "the first poll did not try to authenticate");
    assert.equal(emitted.length, 0, "a poll that could not authenticate published a count");

    // 90s later — inside the 120s Retry-After.
    clock += 90_000;
    await poll();
    assert.equal(exchanges, 1, `a second exchange went out ${90}s into a 120s Retry-After`);

    // Past it, the exchange is allowed again.
    clock += 40_000;
    await poll();
    assert.equal(exchanges, 2, "the exchange never resumed after the Retry-After elapsed");

    // The service's own warn line, not the poll error that quotes it back.
    const limited = logs.filter((l) => l.includes("the token exchange is rate-limited"));
    assert.equal(limited.length, 1, `the 429 logged ${limited.length} times`);
    assert.match(limited[0], /waiting 120s/, "the log did not say how long it would wait");
  });

  it("retries a 401 exactly once, on the same token, and no more", async () => {
    // An exact count on ONE path. The first version of this guard asserted
    // "at least 2 data requests", which a poll makes anyway — it passed with the
    // retry deleted. Traffic 401s, the day request does not, so nothing here is
    // a token verdict: the retry is the only thing that can move this number.
    stubFetch({ trafficStatus: () => 401 });
    svc.token = "old-but-unexpired";
    svc.tokenGen = 1;
    svc.tokenIssuedAt = clock - 30 * 60_000;
    svc.tokenExpiresAt = clock + 20 * 60_000;

    await poll();

    assert.equal(
      trafficRequests().length,
      2,
      `traffic was requested ${trafficRequests().length} times; expected the attempt and one retry`,
    );
    assert.deepEqual(
      [...new Set(trafficAuth)],
      ["Bearer old-but-unexpired"],
      `the retry did not reuse the token it was rejected on: ${trafficAuth.join(" | ")}`,
    );
    assert.equal(exchangeRequests().length, 0, "one endpoint's 401 minted a new token");
    assert.equal(svc.token, "old-but-unexpired", "one endpoint's 401 threw the token away");
  });

  it("replaces a token that EVERY request rejects, rather than holding it to expiry", async () => {
    // B1. The verdict has to be able to condemn a token, or a genuinely
    // invalidated one is kept until tokenExpiresAt — up to 59 minutes of
    // connected:false and blank tiles, with one exchange ever issued.
    let allOk = true;
    stubFetch({ dataStatus: () => (allOk ? 200 : 401) });

    await poll(); // mints and uses a token
    const dead = svc.token;
    assert.notEqual(dead, null, "the first poll did not obtain a token");
    assert.equal(exchangeRequests().length, 1);

    // Five minutes later, past FRESH_TOKEN_MS: everything it carries is refused.
    allOk = false;
    clock += 5 * 60_000;
    await poll();

    assert.equal(
      exchangeRequests().length,
      2,
      `the dead token was never replaced (${exchangeRequests().length} exchange(s) issued); it would be held until tokenExpiresAt`,
    );
    assert.notEqual(svc.token, dead, "the poll went on holding a token every request rejects");
  });

  it("does not blame a fast 401 beside a slow 200 on a second instance", async () => {
    // B2. The poll's requests are issued together and answer in any order. A
    // per-request verdict read the day request's immediate 401 before traffic's
    // delayed 200 on the SAME freshly minted token, condemned it, and had a
    // single instance re-minting every other poll and accusing itself of being
    // two. The verdict is per poll now, so arrival order cannot reach it.
    stubFetch({ dayStatus: () => 401, trafficDelayMs: 30 });

    for (let i = 0; i < 4; i++) {
      await poll();
      clock += 15_000;
    }

    assert.equal(
      exchangeRequests().length,
      1,
      `${exchangeRequests().length} tokens were minted across 4 polls; one good token needs one`,
    );
    assert.equal(
      logs.filter((l) => l.includes("another instance may be using")).length,
      0,
      "a single instance accused itself of sharing its API client",
    );
    assert.equal(emitted.length, 4, "a poll published nothing while its traffic request was fine");
  });

  it("reports a failing day request on a site with no spaces at all", async () => {
    // B3. Cold start: nothing carried, the space listing empty, the day request
    // failing. The old shape decided the site had no spaces, took the zone-net
    // path, discarded the error object unread and logged NOTHING — a broken
    // endpoint with no evidence anywhere that anything was wrong.
    stubFetch({ dayStatus: () => 500, noSpaces: true });

    for (let i = 0; i < 3; i++) {
      await poll();
      clock += 15_000;
    }

    const said = logs.filter((l) => l.includes("day aggregates unavailable"));
    assert.equal(
      said.length,
      1,
      `three failing polls wrote ${said.length} lines about it:\n${logs.join("\n")}`,
    );
    assert.match(said[0], /HTTP 500/, "the line did not say what the endpoint answered");
    assert.equal(emitted.length, 3, "the poll stopped publishing the counts it did have");
  });

  it("logs what Vea said once per outage, however much the body varies", async () => {
    // The cap this replaces counted DISTINCT bodies, so a response carrying a
    // timestamp was distinct every time and the cap never bit: two lines a poll
    // for the length of the outage. The line belongs to the transition into
    // failure, not to the text that came back.
    let n = 0;
    stubFetch({ dayStatus: () => 401, rejectBody: () => `rejected at 10:0${n++} — request ${n}` });
    svc.token = "old";
    svc.tokenGen = 1;
    svc.tokenIssuedAt = clock - 30 * 60_000;
    svc.tokenExpiresAt = clock + 40 * 60_000;

    for (let i = 0; i < 12; i++) {
      await poll();
      clock += 15_000;
    }

    const bodies = logs.filter((l) => l.includes("HTTP 401 from"));
    assert.equal(
      bodies.length,
      1,
      `twelve failing polls wrote ${bodies.length} body lines:\n${bodies.join("\n")}`,
    );
    assert.match(bodies[0], /rejected at 10:0/, "the line did not carry what Vea answered");
  });
});

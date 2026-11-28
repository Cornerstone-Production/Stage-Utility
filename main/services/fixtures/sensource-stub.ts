// sensource-stub.ts — the Vea / SafeSpace stand-in and the reset the three
// SenSource poll suites (attendance cadence, day aggregates, SafeSpace) share.
//
// Each suite drives the REAL poll against a stubbed global fetch and reads what
// it requested and emitted. The fixture owns the parts that must not drift
// between them: the canned bodies, the fetch stub, the clock, and a reset that
// goes through the service's own configure().

import type { SuiteContext, TestContext } from "node:test";
import type { PeopleCountDTO } from "../../types/live.js";
import type { SenSourceConfig } from "../sensource-service.js";

/** What the wall clock reads at the start of every case: a Sunday morning. */
export const START_MS = Date.UTC(2026, 8, 6, 15, 0, 0);

/** The wall clock the service reads. `ms` is the time; `install` makes
 *  Date.now return it for the length of the test. */
export interface SenSourceClock {
  ms: number;
  install(t: TestContext | SuiteContext): void;
}
export function createClock(): SenSourceClock {
  const clock: SenSourceClock = {
    ms: START_MS,
    install(t) {
      clock.ms = START_MS;
      (t as TestContext).mock.method(Date, "now", () => clock.ms);
    },
  };
  return clock;
}

/** Vea's answers when it is healthy. */
export const SPACES = { results: [{ spaceId: "s1", name: "Auditorium", locationId: "l1", maxCapacity: 2120 }] };
export const DAY = {
  results: [{ spaceId: "s1", sumins: 1600, sumouts: 90, maxoccupancy: 1511, minoccupancy: 0, avgoccupancy: "812.5" }],
};
export const MINUTE = { results: [{ spaceId: "s1", recordDate_minute_1: "2026-09-06T15:00:00", maxoccupancy: 1510 }] };
/** One zone: the space and the zone agree on the attendance. */
export const TRAFFIC_ONE_ZONE = { results: [{ zoneId: "z1", name: "Lobby", sumins: 1600, sumouts: 90 }] };
/** Two zones, deliberately: the zone endpoint also sees a cafe nobody counts
 *  attendance from (420 more), so the two sources disagree by 420 and a silent
 *  switch between them shows. */
export const TRAFFIC_TWO_ZONES = {
  results: [
    { zoneId: "z1", name: "Lobby", sumins: 1600, sumouts: 90 },
    { zoneId: "z2", name: "Cafe", sumins: 420, sumouts: 20 },
  ],
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/** The token endpoint, matched on the exact host — not a substring, which CodeQL
 *  rightly flags: "auth.sensourceinc.com" can appear inside any URL. */
export const isAuthHost = (url: string): boolean => new URL(url).hostname === "auth.sensourceinc.com";
export const isSafeSpaceHost = (url: string): boolean => new URL(url).hostname === "app.safespace.io";

export interface StubOptions {
  /** The /data/traffic body. Default: two zones. */
  traffic?: () => unknown;
  /** Decide the response for a /data/occupancy day-aggregate request. */
  dayStatus?: () => number;
  /** Decide the response for a /data/traffic request. */
  trafficStatus?: () => number;
  /** Decide the response for every /data/… request (401 → auth failure). */
  dataStatus?: () => number;
  /** Response for the token exchange. */
  exchange?: () => Response;
  /** The token the exchange mints, given how many requests came before it.
   *  Default: a different one each time (`t<n>`). */
  token?: (requestCount: number) => string;
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
  /** The SafeSpace body, per request. Return null for a network failure. */
  safeSpace?: () => string | null;
  /** The SafeSpace status. */
  safeSpaceStatus?: () => number;
  /** Rate headers on each SafeSpace response, so a case can drive the quota. */
  safeSpaceHeaders?: () => Record<string, string>;
}

/** What the stub records. The arrays are the suite's own, cleared with
 *  `length = 0` so a reference held across cases stays live. */
export interface StubRecord {
  /** Every request URL, in order. */
  requests: string[];
  /** The Authorization header each /data/traffic request carried, in order. */
  trafficAuth?: string[];
}

/** Stand in for the whole Vea API (and SafeSpace). Assigns globalThis.fetch; the
 *  suite puts the real one back in its afterEach, because a case re-stubs. */
export function stubFetch(record: StubRecord, opts: StubOptions = {}): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    record.requests.push(url);
    if (record.trafficAuth && url.includes("/data/traffic")) {
      record.trafficAuth.push(new Headers(init?.headers ?? {}).get("authorization") ?? "");
    }
    if (isSafeSpaceHost(url)) {
      // `??` would fold the null case into the default, and null IS the case here.
      const chosen = opts.safeSpace?.();
      const body = chosen === undefined ? "1234" : chosen;
      // A transport failure quotes the URL, which carries the space id — the
      // exact way the credential escapes into an error message.
      if (body === null) throw new TypeError(`fetch failed: ${url}`);
      return new Response(body, { status: opts.safeSpaceStatus?.() ?? 200, headers: opts.safeSpaceHeaders?.() ?? {} });
    }
    if (isAuthHost(url)) {
      const token = opts.token?.(record.requests.length) ?? `t${record.requests.length}`;
      return opts.exchange?.() ?? json({ access_token: token, expires_in: 3600 });
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
      return status === 200 ? json(opts.traffic?.() ?? TRAFFIC_TWO_ZONES) : new Response("traffic rejected", { status });
    }
    if (url.includes("/data/occupancy")) {
      if (url.includes("dateGroupings=minute")) return json(MINUTE);
      const status = opts.dayStatus?.() ?? 200;
      return status === 200 ? json(DAY) : new Response(opts.rejectBody?.() ?? "day aggregates rejected", { status });
    }
    return json({ results: [] });
  }) as typeof fetch;
}

/** The private surface the fixture touches on the service. Reaching in is
 *  deliberate: the point is to run the real poll, not a copy of it. */
interface SenSourcePrivates {
  configure(cfg: SenSourceConfig): void;
  running: boolean;
  last: PeopleCountDTO;
  emit: (dto: PeopleCountDTO) => void;
  tokenGen: number;
  attendanceInFlight: boolean;
  mainPollInFlight: boolean;
  attendancePolledIdle: boolean;
  restart: () => void;
  pollTicker: { arm: (ms: number) => void };
  safeSpaceTicker: { arm: (ms: number) => void };
  attendanceTicker: { arm: (ms: number) => void };
}

const OFFLINE: PeopleCountDTO = { connected: false, updatedAt: null, total: { attendance: null, occupancy: null }, zones: [] };

/** Stop the three tickers and the restart from arming a real timer. Call it
 *  before the first resetService: configure() restarts the poller. */
export function stubSchedulers(service: object): void {
  const svc = service as SenSourcePrivates;
  svc.pollTicker.arm = () => {};
  svc.safeSpaceTicker.arm = () => {};
  svc.attendanceTicker.arm = () => {};
  svc.restart = () => {};
}

/** Publish into `emitted` instead of the transport, and remember it as the last
 *  snapshot, as the real emit does. */
export function recordEmits(service: object, emitted: PeopleCountDTO[]): void {
  const svc = service as SenSourcePrivates;
  svc.emit = (dto: PeopleCountDTO) => {
    emitted.push(dto);
    svc.last = dto;
  };
}

/** Put the service back to a fresh state by driving its REAL configure(), not by
 *  listing fields. A hand-written reset is a copy of configure() that drifts:
 *  day-aggregates' list missed the SafeSpace state, the attendance anchor and the
 *  poll epoch, and safespace's went red reporting ZERO lines when a later commit
 *  gave SafeSpace its own OutageLog and the list did not gain it. Whatever
 *  configure() learns to clear, this clears.
 *
 *  Only what configure() does not own is reset here: runtime flags and the last
 *  published snapshot. Call stubSchedulers first, so configure()'s restart starts
 *  no poll. */
export function resetService(service: object, cfg: SenSourceConfig): void {
  const svc = service as SenSourcePrivates;
  svc.configure({ ...cfg });
  svc.running = true;
  svc.tokenGen = 0;
  svc.last = { ...OFFLINE, total: { ...OFFLINE.total }, zones: [] };
  svc.attendanceInFlight = false;
  svc.mainPollInFlight = false;
  svc.attendancePolledIdle = false;
}

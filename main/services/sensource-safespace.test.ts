// SafeSpace layered onto the Vea payload, driven through the real poll.
//
// The unit of test here is the assembled service, not the parser: every case
// runs connect() and readSafeSpace() against a stubbed global fetch and reads the
// DTOs the service actually published. safespace-client.test.ts covers the
// parsing and the quota on their own; what these cases are for is which NUMBER
// reaches a display, which SOURCE it says it came from, and what an operator
// finds on /log when the fresher of the two stops answering.
//
// Three of them are guards for named bugs:
//
//   - an empty response read as zero, which reports an empty building
//   - the space id reaching a log line, which publishes a bearer credential to a
//     LAN-visible page
//   - a SafeSpace outage logging per poll, which at a 10s interval is 360 lines
//     an hour on top of the Vea flood this branch just removed
//
// NOT unit-tested here, deliberately: the settings card. The two new fields are
// declared on the descriptor and rendered by the generic ConfigField form, and
// integration-descriptor-fixture.test.ts pins the declaration against the copy
// the renderer tests use. Whether the form actually draws them, and whether a
// saved value survives a reload, was checked in a browser against a real server
// — jsdom renders no stylesheet and a fixture cannot tell you a field is there.

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-safespace-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { setAppTimeZone } = await import("./app-timezone.js");
setAppTimeZone("America/Chicago");
const { sensourceService } = await import("./sensource-service.js");
import type { OutageLog } from "./repeat-log.js";
import { errorMessage } from "./errors.js";
import type { PeopleCountDTO } from "../types/live.js";
import type { SenSourceConfig } from "./sensource-service.js";

/** The private surface these cases drive — the point is to run the real thing. */
type Poller = {
  cfg: SenSourceConfig | null;
  running: boolean;
  connect: () => Promise<void>;
  readSafeSpace: () => Promise<void>;
  start: () => void;
  emit: (dto: PeopleCountDTO) => void;
  last: PeopleCountDTO;
  token: string | null;
  tokenExpiresAt: number;
  tokenIssuedAt: number;
  tokenGen: number;
  authInFlight: Promise<string> | null;
  lastExchangeAt: number;
  exchangeBlockedUntil: number;
  carriedDay: unknown;
  outages: OutageLog;
  safeSpace: { forget: () => void };
  safeSpaceAt: { occupancy: number; at: number } | null;
  zonesCache: unknown;
  spacesCache: unknown;
  scheduleIn: (ms: number) => void;
  scheduleReconnect: () => void;
  scheduleSafeSpaceIn: (ms: number) => void;
  restart: () => void;
};
const svc = sensourceService as unknown as Poller;

/** A space id that is unmistakable inside a log line — the point of the
 *  redaction guard is that a substring search finds it if it leaked. */
const SPACE_ID = "ss-9f3c1d7e-secret-space";

const CFG: SenSourceConfig = {
  clientId: "test-client",
  clientSecret: "test-secret",
  apiToken: null,
  pollSeconds: 15,
  locationId: null,
  zoneIds: [],
  safeSpaceId: SPACE_ID,
  safeSpacePollSeconds: 10,
};

/** Vea's answers when it is healthy. Occupancy from the day net is 1510. */
const TRAFFIC = { results: [{ zoneId: "z1", name: "Lobby", sumins: 1600, sumouts: 90 }] };
const DAY = {
  results: [
    { spaceId: "s1", sumins: 1600, sumouts: 90, maxoccupancy: 1511, minoccupancy: 0, avgoccupancy: "812.5" },
  ],
};
const MINUTE = { results: [{ spaceId: "s1", recordDate_minute_1: "2026-09-06T15:00:00", maxoccupancy: 1510 }] };
const SPACES = { results: [{ spaceId: "s1", name: "Auditorium", locationId: "l1", maxCapacity: 2120 }] };
/** What Vea publishes as the occupancy when SafeSpace is not in play. */
const VEA_OCCUPANCY = 1510;

let requests: string[] = [];
let emitted: PeopleCountDTO[] = [];
let logs: string[] = [];

const realFetch = globalThis.fetch;
const realNow = Date.now;
const realWarn = console.warn;
const realLog = console.log;
const realError = console.error;
let clock = Date.UTC(2026, 8, 6, 15, 0, 0);

const isAuthHost = (url: string): boolean => new URL(url).hostname === "auth.sensourceinc.com";
const isSafeSpace = (url: string): boolean => new URL(url).hostname === "app.safespace.io";
const safeSpaceRequests = (): string[] => requests.filter(isSafeSpace);
/** Every SafeSpace line the service wrote. */
const fellBack = (): string[] => logs.filter((l) => l.includes("SafeSpace live occupancy unavailable"));
const cameBack = (): string[] => logs.filter((l) => l.includes("SafeSpace live occupancy is answering again"));

interface StubOptions {
  /** The SafeSpace body, per request. Return null for a network failure. */
  safeSpace?: () => string | null;
  /** The SafeSpace status. */
  safeSpaceStatus?: () => number;
  /** Fail the Vea day-aggregate request. */
  dayStatus?: () => number;
}

function stubFetch(opts: StubOptions = {}): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (isSafeSpace(url)) {
      // `?? ` would fold the null case into the default — null IS the case here.
      const chosen = opts.safeSpace?.();
      const body = chosen === undefined ? "1234" : chosen;
      // A transport failure quotes the URL, which carries the space id — the
      // exact way the credential escapes into an error message.
      if (body === null) throw new TypeError(`fetch failed: ${url}`);
      return new Response(body, { status: opts.safeSpaceStatus?.() ?? 200 });
    }
    if (isAuthHost(url)) {
      return new Response(JSON.stringify({ access_token: "t1", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("/space")) return json(SPACES);
    if (url.includes("/sensor") || url.includes("/zone") || url.includes("/site")) return json({ results: [] });
    if (url.includes("/data/traffic")) return json(TRAFFIC);
    if (url.includes("/data/occupancy")) {
      if (url.includes("dateGroupings=minute")) return json(MINUTE);
      const st = opts.dayStatus?.() ?? 200;
      return st === 200 ? json(DAY) : new Response("day rejected", { status: st });
    }
    return json({ results: [] });
  }) as typeof fetch;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function resetService(cfg: SenSourceConfig = CFG): void {
  svc.cfg = { ...cfg };
  svc.running = true;
  svc.token = null;
  svc.tokenExpiresAt = 0;
  svc.tokenIssuedAt = 0;
  svc.tokenGen = 0;
  svc.authInFlight = null;
  svc.lastExchangeAt = 0;
  svc.exchangeBlockedUntil = 0;
  svc.carriedDay = null;
  svc.zonesCache = null;
  svc.spacesCache = null;
  // A METHOD on the real OutageLog, not a replacement field: an assignment to a
  // renamed private compiles through `as unknown as Poller` and silently resets
  // nothing, which is how one open run once leaked across a whole test file.
  svc.outages.forget();
  svc.safeSpace.forget();
  svc.safeSpaceAt = null;
  svc.last = { connected: false, updatedAt: null, total: { attendance: null, occupancy: null }, zones: [] };
  requests = [];
  emitted = [];
  logs = [];
}

const poll = (): Promise<void> => svc.connect();
const readSafeSpace = (): Promise<void> => svc.readSafeSpace();
const published = (): PeopleCountDTO => emitted.at(-1)!;

describe("SafeSpace live occupancy on the SenSource payload", () => {
  beforeEach(() => {
    resetService();
    clock = Date.UTC(2026, 8, 6, 15, 0, 0);
    Date.now = () => clock;
    svc.scheduleIn = () => {};
    svc.scheduleReconnect = () => {};
    svc.scheduleSafeSpaceIn = () => {};
    svc.restart = () => {};
    svc.emit = (dto: PeopleCountDTO) => {
      emitted.push(dto);
      svc.last = dto;
    };
    console.warn = take("warn");
    console.log = take("log");
    console.error = take("error");
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

  it("publishes SafeSpace's occupancy and Vea's everything else", async () => {
    stubFetch({ safeSpace: () => "417" });

    await readSafeSpace();
    await poll();

    const dto = published();
    assert.equal(dto.total.occupancy, 417, "the occupancy did not come from SafeSpace");
    assert.equal(dto.total.occupancySource, "safespace", "the DTO did not say where the number came from");
    // Everything Vea knows and SafeSpace does not is untouched.
    assert.equal(dto.total.attendance, 1600, "attendance stopped coming from Vea");
    assert.equal(dto.total.peak, 1511, "the day peak stopped coming from Vea");
    assert.equal(dto.total.capacity, 2120, "the capacity stopped coming from Vea");
    assert.equal(dto.zones.length, 1, "the zone breakdown stopped coming from Vea");
  });

  it("does nothing at all until a space id is filled in, and that is not an error", async () => {
    resetService({ ...CFG, safeSpaceId: null });
    stubFetch();

    await readSafeSpace();
    await poll();

    assert.equal(
      safeSpaceRequests().length,
      0,
      `an unconfigured SafeSpace section made ${safeSpaceRequests().length} request(s)`,
    );
    assert.equal(published().total.occupancy, VEA_OCCUPANCY, "the occupancy was not Vea's");
    assert.equal(published().total.occupancySource, "vea");
    assert.deepEqual(
      logs.filter((l) => l.includes("SafeSpace")),
      [],
      "a blank space id was reported as a problem",
    );
  });

  it("reads an EMPTY response as unknown, never as an empty building", async () => {
    // GUARD. One SafeSpace sample in six comes back with no body. `Number("")`
    // is 0, and a confident 0 fires every occupancy threshold in the app.
    let body: string = "417";
    stubFetch({ safeSpace: () => body });

    await readSafeSpace(); // a good reading to hold
    body = "";
    clock += 10_000;
    await readSafeSpace();
    await poll();

    assert.equal(
      published().total.occupancy,
      417,
      `an empty response published ${published().total.occupancy} as the occupancy`,
    );
    assert.equal(published().total.occupancySource, "safespace", "the held reading stopped being SafeSpace's");
  });

  it("holds a good reading across an empty one without saying anything", async () => {
    // The empty is NORMAL — one in six — so it must not be a log line of its own.
    // Logging it would be 6 lines an hour at the default interval for nothing.
    let n = 0;
    stubFetch({ safeSpace: () => (n++ % 2 === 0 ? "417" : "") });

    for (let i = 0; i < 8; i++) {
      await readSafeSpace();
      clock += 10_000;
    }

    assert.deepEqual(fellBack(), [], `an expected empty response was logged:\n${fellBack().join("\n")}`);
  });

  it("falls back to Vea rather than going blank when SafeSpace fails", async () => {
    stubFetch({ safeSpaceStatus: () => 503, safeSpace: () => "" });

    await readSafeSpace();
    await poll();

    assert.equal(published().total.occupancy, VEA_OCCUPANCY, "a SafeSpace failure blanked the occupancy");
    assert.equal(published().total.occupancySource, "vea", "the DTO still claimed the number was SafeSpace's");
    assert.equal(fellBack().length, 1, "the fallback was not reported at all");
    assert.match(fellBack()[0], /HTTP 503/, "the line did not say what SafeSpace answered");
    assert.match(fellBack()[0], /falls back to Vea/, "the line did not say what happens next");
  });

  it("logs a SafeSpace outage ONCE, not once per read", async () => {
    // GUARD. At the 10s default a per-read line is 360 an hour, on top of the Vea
    // flood this branch exists to remove. Twelve reads over two minutes.
    stubFetch({ safeSpaceStatus: () => 503, safeSpace: () => "" });

    for (let i = 0; i < 12; i++) {
      await readSafeSpace();
      clock += 10_000;
    }

    assert.equal(
      fellBack().length,
      1,
      `twelve failing reads wrote ${fellBack().length} lines:\n${fellBack().join("\n")}`,
    );
  });

  it("treats an alternating SafeSpace failure as one outage", async () => {
    // The same shape Vea fails in, and the reason a transition flag is not
    // enough: every intervening success would clear it and every failure would
    // be a fresh first failure.
    let ok = false;
    stubFetch({ safeSpaceStatus: () => (ok ? 200 : 503), safeSpace: () => (ok ? "417" : "") });

    for (let i = 0; i < 12; i++) {
      ok = i % 2 === 1;
      await readSafeSpace();
      clock += 10_000;
    }

    assert.equal(
      fellBack().length,
      1,
      `an alternating SafeSpace outage wrote ${fellBack().length} lines:\n${fellBack().join("\n")}`,
    );
  });

  it("says so once when SafeSpace comes back for good", async () => {
    let ok = false;
    stubFetch({ safeSpaceStatus: () => (ok ? 200 : 503), safeSpace: () => (ok ? "417" : "") });

    await readSafeSpace();
    assert.equal(fellBack().length, 1, "the outage was not reported");

    ok = true;
    for (let i = 0; i < 20; i++) {
      clock += 10_000;
      await readSafeSpace();
    }

    assert.equal(cameBack().length, 1, `the recovery logged ${cameBack().length} times`);
    assert.match(cameBack()[0], /after 1 failed attempt/, "the recovery did not account for the outage");
  });

  it("never lets the space id reach a log line", async () => {
    // GUARD. The id is the entire credential — no key, no token, no account
    // check — and /log is LAN-visible. The failure path below quotes the URL
    // inside the error message, which is exactly how it escapes.
    stubFetch({ safeSpace: () => null });

    await readSafeSpace();
    clock += 10_000;
    await poll();

    assert.ok(fellBack().length >= 1, "the transport failure was not reported at all, so nothing was checked");
    const leaked = logs.filter((l) => l.includes(SPACE_ID));
    assert.deepEqual(leaked, [], `the space id reached ${leaked.length} log line(s):\n${leaked.join("\n")}`);
    assert.match(fellBack()[0], /<space id>/, "the id was dropped rather than shown as redacted");
  });

  it("keeps the fresher number when Vea's day aggregates are failing", async () => {
    // The two halves fail independently: a rejected day request must not cost the
    // SafeSpace reading, which knows nothing about it.
    stubFetch({ safeSpace: () => "417", dayStatus: () => 401 });

    await readSafeSpace();
    await poll();

    assert.equal(published().total.occupancy, 417, "a Vea failure took the SafeSpace number with it");
    assert.equal(published().total.occupancySource, "safespace");
  });

  it("republishes on its own clock rather than waiting for the Vea poll", async () => {
    // The whole value of the reading is that it is fresher. Holding it until the
    // next Vea poll — up to an hour at a configured interval — throws that away.
    let body = "417";
    stubFetch({ safeSpace: () => body });

    await poll(); // a Vea poll first, so there is a snapshot to layer onto
    const afterPoll = emitted.length;

    body = "512";
    clock += 10_000;
    await readSafeSpace();

    assert.ok(emitted.length > afterPoll, "a new SafeSpace reading published nothing");
    assert.equal(published().total.occupancy, 512, "the republished snapshot carried the old number");
    assert.equal(published().total.attendance, 1600, "the republish lost Vea's attendance");
  });

  it("arms the reading from start(), and only when a space ID is set", async () => {
    // The wiring, driven rather than assumed: everything above calls
    // readSafeSpace() directly, which would pass just as well if nothing in the
    // poller's lifecycle ever called it. start() is the only thing that does —
    // configure() reaches it through restart().
    stubFetch({ safeSpace: () => "417" });
    svc.running = false;
    svc.start();
    await new Promise((r) => setTimeout(r, 60));

    assert.ok(
      safeSpaceRequests().length >= 1,
      "start() never read SafeSpace, so nothing in the lifecycle would",
    );
    assert.ok(
      logs.some((l) => l.includes("reading SafeSpace live occupancy every 10s")),
      `start() did not say it was reading SafeSpace:\n${logs.join("\n")}`,
    );

    // ...and with no ID it is silent and sends nothing.
    resetService({ ...CFG, safeSpaceId: null });
    stubFetch();
    svc.running = false;
    svc.start();
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(
      safeSpaceRequests().length,
      0,
      `start() read SafeSpace ${safeSpaceRequests().length} time(s) with no space ID`,
    );
    assert.deepEqual(logs.filter((l) => l.includes("SafeSpace")), [], "a blank ID was announced");
  });

  it("publishes nothing from a reading whose configuration was replaced", async () => {
    stubFetch({ safeSpace: () => "417" });
    await poll();
    const before = emitted.length;

    // configure() bumps the epoch; the reading in flight belongs to the old space.
    const reading = readSafeSpace();
    svc.cfg = { ...CFG, safeSpaceId: "a-different-space" };
    sensourceService.configure({ ...CFG, safeSpaceId: "a-different-space" });
    await reading;

    assert.equal(emitted.length, before, "a reading scoped to a replaced space was published");
  });
});

function take(level: string) {
  return (...args: unknown[]): void => {
    logs.push(`${level} ${args.map((a) => errorMessage(a)).join(" ")}`);
  };
}

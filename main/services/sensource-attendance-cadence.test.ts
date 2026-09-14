// Attendance split onto its own faster interval, driven through the real poll.
//
// The problem this answers: a recent change made occupancy come from SafeSpace,
// polled every few seconds, while attendance stayed on the Vea poll beside it —
// on one lobby display, two numbers that visibly disagree for no reason a viewer
// can see. `attendancePollSeconds` lets attendance re-read /data/traffic on its
// own faster clock too.
//
// Three things make this more than "poll a second endpoint":
//
//   - UNSET MUST CHANGE NOTHING. Attendance is not opt-in the way SafeSpace is —
//     every existing Vea integration already publishes one — so a fixed default
//     faster than an operator's own poll interval would have raised request
//     volume for everyone who never opened this card, the instant it shipped.
//   - NOT A SECOND SOURCE OF TRUTH. The fast read only ever has /data/traffic;
//     re-fetching /data/occupancy too would be the second and third request per
//     tick this feature exists to avoid. So it ADVANCES the main cycle's own
//     published figure by how far the zone sum has moved, rather than
//     publishing the raw zone sum — which on a site with spaces is a DIFFERENT
//     number from the authoritative one (see sensource-day-aggregates.test.ts's
//     ZONE_ATTENDANCE vs SPACE_ATTENDANCE) and would fight it every few seconds.
//   - NOT A DOUBLED REQUEST. Two independently-scheduled timers whose periods
//     divide evenly coincide at their LCM forever, not just once — and Node
//     fires both callbacks in the same timer-phase sweep before either one's
//     first await, which is too late for a "cancel the other one" to help.
//
// THE FORM FIELD is not unit-tested here, and not browser-checked either —
// unlike safeSpacePollSeconds, whose own test file records that it was. (What
// the SERVICE resolves a blank field to, and the floor it applies, is pinned:
// see "the interval the service itself resolves" below. This caveat is about
// the input, not about the fallback.) The field is
// declared on the descriptor and rendered by the generic ConfigField form,
// pinned by integration-descriptor-fixture.test.ts and
// sensource-poll-cadence.test.ts, and its shape (no default, no numeric
// placeholder) matches ross-tsl's already-shipped `port` field exactly. But
// whether the form actually draws it, what the NumberInput shows for a blank
// field with no default, and whether a saved value survives a reload were
// judged from that precedent and from reading number-input.tsx, not observed
// in a running server — jsdom renders no stylesheet and cannot show what a
// stepper control paints. If this ships, drive it once before relying on it.

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-attendance-cadence-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { setAppTimeZone } = await import("./app-timezone.js");
const { setSubscriberCheck } = await import("./broadcaster.js");
setAppTimeZone("America/Chicago");
const { integrationManager } = await import("./integration-manager.js");
const { sensourceService } = await import("./sensource-service.js");
import { errorMessage } from "./errors.js";
import { OutageLog } from "./repeat-log.js";
import type { PeopleCountDTO } from "../types/live.js";
import type { SenSourceConfig } from "./sensource-service.js";

/** The private surface these cases drive — the point is to run the real thing,
 *  the same choice sensource-safespace.test.ts and sensource-day-aggregates
 *  .test.ts make. */
type TickerSeam = {
  arm: (ms: number) => void;
  cancel: () => void;
  run: () => Promise<void>;
  readonly armed: boolean;
};
type Poller = {
  cfg: SenSourceConfig | null;
  running: boolean;
  pollEpoch: number;
  connect: () => Promise<void>;
  pollOnce: () => Promise<string>;
  readAttendance: () => Promise<string>;
  start: () => void;
  stop: () => void;
  teardown: () => void;
  emit: (dto: PeopleCountDTO) => void;
  last: PeopleCountDTO;
  attendanceAnchor: { published: number; zoneAttendance: number } | null;
  attendanceInFlight: boolean;
  mainPollInFlight: boolean;
  attendancePolledIdle: boolean;
  attendanceOutages: OutageLog;
  configure: (cfg: SenSourceConfig) => void;
  pollNowIfIdle: () => void;
  /** The three clocks. Each owns its own timer and re-arms itself — see
   *  ticker.ts — so `arm` is the seam these cases spy on and stub, where they
   *  used to spy on the service's own scheduleXIn methods. */
  pollTicker: TickerSeam;
  safeSpaceTicker: TickerSeam;
  attendanceTicker: TickerSeam;
  restart: () => void;
};
const svc = sensourceService as unknown as Poller;
/** The attendance ticker's REAL arm, captured before the stubbing below
 *  shadows it — for the one case that needs the ticker's own `wanted()` gate
 *  under test rather than intercepted. Spying on `arm` (as every other case
 *  here does, to see what it was CALLED with) would replace the very check that
 *  case exists to prove, the same reason connect() gets a real reference of its
 *  own below. Bound, because it is read off the prototype. */
const realAttendanceArm = (
  Object.getPrototypeOf(svc.attendanceTicker) as TickerSeam
).arm.bind(svc.attendanceTicker);

// Stubbed HERE and not only in beforeEach: resetService below calls the real
// configure(), which restarts the poller, and the first resetService runs
// before any beforeEach body would have replaced these.
svc.pollTicker.arm = () => {};
svc.safeSpaceTicker.arm = () => {};
svc.attendanceTicker.arm = () => {};
svc.restart = () => {};

/** TWO zones, deliberately — the same fixture sensource-day-aggregates.test.ts
 *  uses. The authoritative space total counts the auditorium's doors (1600 in);
 *  the zone endpoint also sees a cafe nobody is counting attendance from (420
 *  more). The two disagree by 420, which is what makes publishing the wrong one
 *  visible instead of invisible. */
let trafficRows = [
  { zoneId: "z1", name: "Lobby", sumins: 1600, sumouts: 90 },
  { zoneId: "z2", name: "Cafe", sumins: 420, sumouts: 20 },
];
const ZONE_ATTENDANCE = 2020;
const SPACE_ATTENDANCE = 1600;
const DAY = {
  results: [
    { spaceId: "s1", sumins: 1600, sumouts: 90, maxoccupancy: 1511, minoccupancy: 0, avgoccupancy: "812.5" },
  ],
};
const MINUTE = { results: [{ spaceId: "s1", recordDate_minute_1: "2026-09-06T15:00:00", maxoccupancy: 1510 }] };
const SPACES = { results: [{ spaceId: "s1", name: "Auditorium", locationId: "l1", maxCapacity: 2120 }] };

const CFG: SenSourceConfig = {
  clientId: "test-client",
  clientSecret: "test-secret",
  apiToken: null,
  // Slow, deliberately: most cases in this file are about the fast read being
  // FASTER than this, and a slow default here means a case that forgets to set
  // attendancePollSeconds fails loudly (a same-tick collision or nothing at
  // all) rather than silently passing because the two happened to be equal.
  pollSeconds: 3600,
  attendancePollSeconds: 10,
  locationId: null,
  zoneIds: [],
  safeSpaceId: null,
  safeSpaceEnabled: false,
  safeSpacePollSeconds: 10,
};

let requests: string[] = [];
let emitted: PeopleCountDTO[] = [];
let logs: string[] = [];

const realFetch = globalThis.fetch;
/** pollOnce() itself — the poll ticker's body — so the cases that stub it can
 *  put the real one back: it lives on the prototype, and assigning over it on
 *  the instance would otherwise shadow it for every later test in this file,
 *  not just its own. */
const realPollOnce = svc.pollOnce;
const realNow = Date.now;
const realWarn = console.warn;
const realLog = console.log;
const realError = console.error;
let clock = Date.UTC(2026, 8, 6, 15, 0, 0);

const isAuthHost = (url: string): boolean => new URL(url).hostname === "auth.sensourceinc.com";
const trafficRequests = (): string[] => requests.filter((u) => u.includes("/data/traffic"));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

interface StubOptions {
  trafficStatus?: () => number;
}

function stubFetch(opts: StubOptions = {}): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (isAuthHost(url)) return json({ access_token: `t${requests.length}`, expires_in: 3600 });
    if (url.includes("/space")) return json(SPACES);
    if (url.includes("/sensor") || url.includes("/zone") || url.includes("/site")) return json({ results: [] });
    if (url.includes("/data/traffic")) {
      const status = opts.trafficStatus?.() ?? 200;
      return status === 200 ? json({ results: trafficRows }) : new Response("traffic rejected", { status });
    }
    if (url.includes("/data/occupancy")) return url.includes("dateGroupings=minute") ? json(MINUTE) : json(DAY);
    return json({ results: [] });
  }) as typeof fetch;
}

/** Reset by driving the REAL configure(), not by listing fields — see the
 *  identical note in sensource-safespace.test.ts on why a hand-written reset
 *  drifts. `restart` is stubbed at module scope above, so this starts no poll. */
function resetService(cfg: SenSourceConfig = CFG): void {
  requests = [];
  emitted = [];
  logs = [];
  trafficRows = [
    { zoneId: "z1", name: "Lobby", sumins: 1600, sumouts: 90 },
    { zoneId: "z2", name: "Cafe", sumins: 420, sumouts: 20 },
  ];
  sensourceService.configure({ ...cfg });
  svc.running = true;
  svc.last = { connected: false, updatedAt: null, total: { attendance: null, occupancy: null }, zones: [] };
  // Not configure()'s to reset — they are runtime flags, not configuration —
  // so a case that sets one to prove a guard must not leak it into the next.
  svc.attendanceInFlight = false;
  svc.mainPollInFlight = false;
  svc.attendancePolledIdle = false;
}

const poll = (): Promise<void> => svc.connect();
const readAttendance = async (): Promise<void> => void (await svc.readAttendance());
const published = (): PeopleCountDTO => emitted.at(-1)!;

function take(level: string) {
  return (...args: unknown[]): void => {
    logs.push(`${level} ${args.map((a) => errorMessage(a)).join(" ")}`);
  };
}

describe("the attendance interval, split onto its own cadence", () => {
  beforeEach(() => {
    clock = Date.UTC(2026, 8, 6, 15, 0, 0);
    Date.now = () => clock;
    svc.pollTicker.arm = () => {};
    svc.safeSpaceTicker.arm = () => {};
    svc.attendanceTicker.arm = () => {};
    svc.restart = () => {};
    resetService();
    // The healthy default. A case that needs a failure calls stubFetch(...)
    // again with its own options — every fetch in this file is stubbed from
    // the first line of a test onward, on purpose: an unstubbed poll here does
    // not fail loudly, it silently reaches for the real Vea host.
    stubFetch();
    svc.emit = (dto: PeopleCountDTO) => {
      emitted.push(dto);
      svc.last = dto;
    };
    console.warn = take("warn");
    console.log = take("log");
    console.error = take("error");
  });

  afterEach(() => {
    setSubscriberCheck(() => true);
    globalThis.fetch = realFetch;
    svc.pollOnce = realPollOnce;
    Date.now = realNow;
    console.warn = realWarn;
    console.log = realLog;
    console.error = realError;
    svc.running = false;
    svc.cfg = null;
    // A REAL timer armed by a case that restores the real ticker arm must not
    // survive its own test — 30s of real wall-clock time later it would fire
    // readAttendance() with globals long since restored.
    svc.attendanceTicker.cancel();
  });

  describe("the default", () => {
    it("falls back to the poll interval the operator actually set, not a constant of its own", async () => {
      // GUARD. The exact production shape: an operator raised the Vea interval
      // to 45s (measured — see the file header on sensource-service.ts) and has
      // never seen this field. A fixed fallback faster than 45s would have
      // started polling harder for them the instant this shipped.
      (integrationManager as unknown as { states: Map<string, unknown> }).states.set("sensource", {
        id: "sensource",
        enabled: false,
        connection: "disconnected",
        message: null,
        config: { clientId: "cid", pollSeconds: 45 },
      });
      const cfg = await (
        integrationManager as unknown as { getSensourceConfig: () => Promise<SenSourceConfig> }
      ).getSensourceConfig();
      assert.equal(cfg.pollSeconds, 45, "the fixture did not even resolve the poll interval correctly");
      assert.equal(
        cfg.attendancePollSeconds,
        45,
        `an untouched field resolved to ${cfg.attendancePollSeconds}s, not the operator's own 45s poll interval`,
      );
    });

    it("resolves to the code default when neither interval has ever been touched", async () => {
      (integrationManager as unknown as { states: Map<string, unknown> }).states.set("sensource", {
        id: "sensource",
        enabled: false,
        connection: "disconnected",
        message: null,
        config: { clientId: "cid" },
      });
      const cfg = await (
        integrationManager as unknown as { getSensourceConfig: () => Promise<SenSourceConfig> }
      ).getSensourceConfig();
      assert.equal(cfg.attendancePollSeconds, cfg.pollSeconds, "the two intervals disagreed with nothing set");
    });
  });

  describe("the interval the service itself resolves", () => {
    // getSensourceConfig above resolves a blank field to the operator's own poll
    // interval before the service ever sees it. attendanceSeconds() carries the
    // SAME fallback, and it is not redundant: it is what decides the answer for a
    // config built anywhere else, and SenSourceConfig's own doc comment states
    // "0 or unset means the same as pollSeconds, not a constant of its own".
    // Nothing pinned it — `|| this.veaSeconds()` could be `|| 30` with the whole
    // suite green — and sensource-poll-cadence.test.ts pointed at this file for
    // a guard that was not here.
    it("treats a blank attendance interval as the poll interval, not a constant", () => {
      // GUARD. The exact production shape: an operator set 120s to stay inside
      // Vea's quota and has never opened this field. With any fixed fallback
      // below 120 a SECOND timer starts for them, and at a 30s constant that is
      // four times the Vea request volume they chose — on every install that
      // never touched the field.
      resetService({ ...CFG, pollSeconds: 120, attendancePollSeconds: 0 });
      const armed: number[] = [];
      svc.attendanceTicker.arm = (ms) => armed.push(ms);
      svc.pollOnce = async () => "skip";
      svc.running = false;
      svc.start();

      assert.deepEqual(armed, [], "a blank attendance interval started a second timer of its own");
      assert.deepEqual(
        logs.filter((l) => l.includes("reading attendance every")),
        [],
        "a blank attendance interval announced a fast read",
      );
    });

    it("floors the attendance interval at the same minimum the poll enforces", () => {
      // GUARD. Same Vea endpoint, so the same floor — and the form's own min is
      // asserted against MIN_POLL_SECONDS in sensource-poll-cadence.test.ts,
      // which is only a promise if the poller enforces it too. A config that
      // reaches the service below the floor (an older settings.json, a restored
      // snapshot, the API) must not be honoured.
      resetService({ ...CFG, pollSeconds: 3600, attendancePollSeconds: 2 });
      const armed: number[] = [];
      svc.attendanceTicker.arm = (ms) => armed.push(ms);
      svc.pollOnce = async () => "skip";
      svc.running = false;
      svc.start();

      assert.deepEqual(armed, [10_000], "the attendance interval was armed below the floor");
      assert.ok(
        logs.some((l) => l.includes("reading attendance every 10s")),
        `the announced interval was not the floored one:\n${logs.join("\n")}`,
      );
    });
  });

  describe("the one question both pollers ask of /data/traffic", () => {
    // trafficPath() exists "so they can never drift into asking two different
    // questions of the same endpoint", and nothing pinned what that one question
    // is: `excludeClosedHours` could be flipped to "false" with the whole suite
    // green, and the string appeared in zero test files. On any site with
    // after-hours sensor noise that silently inflates attendance — no error, and
    // nothing on screen.
    const EXPECTED =
      "https://vea.sensourceinc.com/api/data/traffic" +
      "?relativeDate=today&dateGroupings=day&entityType=zone&metrics=ins%2Couts&excludeClosedHours=true";

    it("the main poll asks exactly this", async () => {
      await poll();
      assert.deepEqual(trafficRequests(), [EXPECTED]);
    });

    it("the fast read asks exactly the same thing", async () => {
      // GUARD on the drift the shared helper exists to prevent. Compared to the
      // main poll's OWN string rather than to the constant alone, so a change
      // that moved both together still has to be a deliberate one.
      await poll();
      const fromPoll = trafficRequests();
      await readAttendance();
      const fromFastRead = trafficRequests().slice(fromPoll.length);

      assert.deepEqual(fromFastRead, [EXPECTED]);
      assert.deepEqual(fromFastRead, fromPoll, "the two pollers asked /data/traffic different questions");
    });
  });

  describe("whether the fast timer runs at all", () => {
    // pollOnce() is stubbed to a no-op in both cases below — the poll ticker's
    // body, so stubbing it is what stops start()'s first tick from running:
    // these two are about the SYNCHRONOUS scheduling decision start() makes
    // right after super.start() returns, not about a poll's own result, and a
    // REAL fire-and-forget poll left running past the end of one test raced the
    // next test's own resetService() over the same singleton's fields — exactly
    // the kind of cross-test leak this file's stubbing exists to avoid.
    it("start() never announces a fast read no faster than the poll", () => {
      // Equal, exactly what "unset" resolves to above.
      resetService({ ...CFG, pollSeconds: 30, attendancePollSeconds: 30 });
      const armed: number[] = [];
      svc.attendanceTicker.arm = (ms) => armed.push(ms);
      svc.pollOnce = async () => "skip";
      svc.running = false; // start()'s own guard is a no-op while already running
      svc.start();
      assert.deepEqual(armed, [], "start() armed a second timer for an interval no faster than the poll");
      assert.deepEqual(
        logs.filter((l) => l.includes("reading attendance every")),
        [],
        "start() announced a fast read it never actually arms",
      );
    });

    it("the attendance ticker refuses on its own, for a caller with no gate of its own", async () => {
      // GUARD, and the reason it is not enough to test this through start()
      // above: start() carries its OWN attendanceIsFaster() check before ever
      // arming, so a ticker with no `wanted()` gate at all would still pass that
      // test. noteAttendanceSample() — the poll's own success path — has no such
      // gate; the ticker's own check is the only thing standing between it and a
      // redundant real timer. Spying on arm (as every other case in this file
      // does, to see what it was CALLED with) would replace the very check under
      // test here, so this restores the real one and reads its actual side
      // effect instead.
      resetService({ ...CFG, pollSeconds: 30, attendancePollSeconds: 30 });
      svc.attendanceTicker.arm = realAttendanceArm;

      await poll();

      assert.equal(
        svc.attendanceTicker.armed,
        false,
        "the attendance ticker armed a real timer for an interval no faster than the poll",
      );
    });

    it("arms and announces it when the interval genuinely is faster", () => {
      resetService({ ...CFG, pollSeconds: 3600, attendancePollSeconds: 10 });
      svc.pollOnce = async () => "skip";
      const armed: number[] = [];
      svc.attendanceTicker.arm = (ms) => armed.push(ms);
      svc.running = false;
      svc.start();
      assert.deepEqual(armed, [10_000], "start() did not arm the fast read at its own interval");
      assert.ok(
        logs.some((l) => l.includes("reading attendance every 10s")),
        `start() did not say it was reading attendance:\n${logs.join("\n")}`,
      );
    });
  });

  describe("advancing the main cycle's own number, not the raw zone sum", () => {
    it("agrees with the space-derived attendance the main poll already published", async () => {
      // GUARD. Publishing the raw zone sum directly here would report 2020 —
      // the cafe traffic nobody counts as attendance — fighting the 1600 the
      // main poll already published, every ten seconds.
      await poll();
      assert.equal(published().total.attendance, SPACE_ATTENDANCE, "the main poll's own fixture is wrong");

      await readAttendance();

      assert.equal(
        published().total.attendance,
        SPACE_ATTENDANCE,
        `an unchanged zone sum moved attendance to ${published().total.attendance}`,
      );
      assert.notEqual(
        published().total.attendance,
        ZONE_ATTENDANCE,
        "the fast read published the raw zone sum instead of advancing the main cycle's own figure",
      );
    });

    it("advances by exactly what the doors counted since the last sample", async () => {
      await poll(); // anchor: published 1600, zone sum 2020

      trafficRows = [
        { zoneId: "z1", name: "Lobby", sumins: 1650, sumouts: 90 }, // +50
        { zoneId: "z2", name: "Cafe", sumins: 420, sumouts: 20 },
      ];
      await readAttendance();

      assert.equal(
        published().total.attendance,
        SPACE_ATTENDANCE + 50,
        "the fast read did not advance the authoritative figure by what the doors counted",
      );
    });

    it("leaves the per-zone breakdown and occupancy alone — attendance only", async () => {
      await poll();
      const zonesBefore = published().zones;
      const occupancyBefore = published().total.occupancy;

      trafficRows = [
        { zoneId: "z1", name: "Lobby", sumins: 1650, sumouts: 90 },
        { zoneId: "z2", name: "Cafe", sumins: 420, sumouts: 20 },
      ];
      await readAttendance();

      assert.deepEqual(published().zones, zonesBefore, "a fast attendance read touched the per-zone breakdown");
      assert.equal(published().total.occupancy, occupancyBefore, "a fast attendance read touched occupancy");
    });

    it("publishes the raw zone sum when there is no anchor yet, rather than a stale scope's delta", async () => {
      // The window a reconfigure opens: the OLD scope's anchor is gone (see
      // "cancels work issued under the old configuration" below) and the new
      // scope's first poll has not run yet. Reusing the old anchor here would
      // mix two different zone scopes' numbers into one meaningless delta.
      await poll(); // anchor under the ORIGINAL (all-zones) scope: 1600 / 2020
      const lastBeforeReconfigure = published(); // resetService() below clears `emitted`

      resetService({ ...CFG, zoneIds: ["z1"] }); // configure() drops the anchor
      assert.equal(svc.attendanceAnchor, null, "configure() did not drop the old scope's anchor");
      svc.last = lastBeforeReconfigure; // the display's last snapshot survives a reconfigure

      await readAttendance();

      // Scoped to z1 alone: sumins 1600, no cafe. Not 1600 + (1600 - 2020).
      assert.equal(
        published().total.attendance,
        1600,
        `expected the new scope's own zone sum; got ${published().total.attendance}, which mixes two scopes`,
      );
    });
  });

  describe("not issuing the same request twice in the same tick", () => {
    it("does nothing while the main poll is in flight", async () => {
      // GUARD. This is what actually closes the window a same-target-instant
      // timer coincidence opens: Node invokes both callbacks in the same
      // timer-phase sweep, before either reaches an await, so cancelling a
      // timer from inside the other poller's success path is too late.
      svc.mainPollInFlight = true;
      await readAttendance();
      assert.equal(
        trafficRequests().length,
        0,
        "a fast read fired its own request while the main poll was already fetching the same thing",
      );
    });

    it("does not stop the main poll from fetching its own traffic", async () => {
      // The asymmetry is deliberate: the main cycle needs a fresh fetch every
      // tick regardless (paired with the day-aggregate request), so only the
      // fast read defers, never the other way around.
      svc.attendanceInFlight = true;
      await poll();
      assert.equal(trafficRequests().length, 1, "the main poll deferred to an in-flight fast read");
    });

    it("a tick deferred to the main poll still leaves the next one armed", async () => {
      // GUARD, and the second instance of the failure the Ticker was built for.
      // This deferral is the common one — at any fast interval that divides
      // evenly into the poll interval the two tickers share a target instant
      // forever — so with the re-arm back inside the body's success path the
      // fast read dies on its first collision. It self-healed only while the
      // main poll kept succeeding (noteAttendanceSample re-arms from there), and
      // the main poll throwing is exactly when Vea is failing: both die
      // together, in the one state an operator is watching.
      const armed: number[] = [];
      svc.attendanceTicker.arm = (ms) => armed.push(ms);
      svc.mainPollInFlight = true;

      await svc.attendanceTicker.run();

      assert.equal(
        trafficRequests().length,
        0,
        "the deferred read fired its own request anyway",
      );
      assert.deepEqual(
        armed,
        [10_000],
        "a read deferred to the main poll never re-armed — the fast attendance read is dead",
      );
    });

    it("pushes the fast timer out from every successful main-cycle poll", async () => {
      // GUARD. Without this, a fast interval that divides evenly into the poll
      // interval reaches the same target instant as the main timer at every
      // multiple of the poll interval, not just once.
      const armed: number[] = [];
      svc.attendanceTicker.arm = (ms) => armed.push(ms);
      await poll();
      assert.deepEqual(
        armed,
        [10_000],
        "a successful main poll did not re-arm the fast timer at the attendance interval",
      );
    });
  });

  describe("cancelling work issued under the old configuration", () => {
    it("a fast read scoped to a replaced configuration publishes nothing", async () => {
      await poll();
      const before = emitted.length;

      const reading = readAttendance();
      // configure() bumps the epoch mid-read; this answer describes a scope the
      // operator has already replaced.
      sensourceService.configure({ ...CFG, zoneIds: ["z1"] });
      await reading;

      assert.equal(emitted.length, before, "a read scoped to a replaced configuration was published");
    });

    it("does not re-arm itself under an epoch that has moved on", async () => {
      const armed: number[] = [];
      svc.attendanceTicker.arm = (ms) => armed.push(ms);
      const reading = readAttendance();
      sensourceService.configure({ ...CFG, zoneIds: ["z1"] });
      armed.length = 0; // clear whatever the reconfigure's own restart() may have armed
      await reading;
      assert.deepEqual(armed, [], "a stale-epoch read re-armed its own next tick");
    });
  });

  describe("a failing fast read", () => {
    it("is reported, not swallowed", async () => {
      stubFetch({ trafficStatus: () => 503 });
      await readAttendance();
      assert.ok(
        logs.some((l) => l.includes("the fast attendance read failed")),
        `a failing read wrote nothing to the log:\n${logs.join("\n")}`,
      );
    });

    it("logs an outage ONCE, not once per tick", async () => {
      // GUARD. At a 10s default a per-tick line is 360 an hour — the exact
      // shape the rest of this file's outage logs were rewritten to stop.
      stubFetch({ trafficStatus: () => 503 });
      for (let i = 0; i < 6; i++) {
        await readAttendance();
        clock += 10_000;
      }
      const failLines = logs.filter((l) => l.includes("the fast attendance read failed"));
      assert.equal(failLines.length, 1, `six failing reads wrote ${failLines.length} lines:\n${logs.join("\n")}`);
    });

    it("does not take the main cycle down with it", async () => {
      stubFetch({ trafficStatus: () => 503 });
      await readAttendance();
      assert.equal(published(), undefined, "a failing fast read published something anyway");

      stubFetch();
      await poll();
      assert.equal(published().total.attendance, SPACE_ATTENDANCE, "the main poll never recovered");
      assert.equal(published().connected, true, "the main poll never recovered");
    });

    it("republishes on its own clock rather than waiting for the next poll", async () => {
      // The whole value of the fast read is that it is fresher — holding it
      // until the next main-cycle tick throws that away.
      await poll();
      const afterPoll = emitted.length;

      trafficRows = [
        { zoneId: "z1", name: "Lobby", sumins: 1700, sumouts: 90 },
        { zoneId: "z2", name: "Cafe", sumins: 420, sumouts: 20 },
      ];
      await readAttendance();

      assert.ok(emitted.length > afterPoll, "a fresh attendance figure published nothing");
      assert.equal(published().total.attendance, SPACE_ATTENDANCE + 100);
    });
  });

  describe("idle gating", () => {
    it("pre-empts an IDLE attendance wait, and only an idle one", async () => {
      setSubscriberCheck(() => false);
      let armed: number[] = [];
      svc.attendanceTicker.arm = (ms) => armed.push(ms);

      // No consumer: re-arms at the idle cadence and remembers it did. Driven
      // through the TICKER, not readAttendance() directly — the re-arm is the
      // ticker's, which is the whole point of it being there (see ticker.ts).
      await svc.attendanceTicker.run();
      assert.equal(armed.at(-1), 60_000, `an unwatched read re-armed at ${armed.at(-1)}ms`);
      assert.equal(svc.attendancePolledIdle, true, "the idle wait was not remembered");

      // A consumer arrives.
      setSubscriberCheck(() => true);
      armed = [];
      svc.pollNowIfIdle();
      assert.deepEqual(armed, [0], "a consumer arriving did not cut the idle wait short");

      // ...and a second arrival cannot read faster than configured.
      armed = [];
      svc.pollNowIfIdle();
      assert.deepEqual(armed, [], "a flapping consumer read faster than its configured rate");
    });
  });

  describe("lifecycle", () => {
    it("stop() cancels the fast timer", () => {
      // pollOnce() stubbed out, same reason as "whether the fast timer runs at
      // all" above: this test is synchronous and returns before a REAL poll
      // would settle, and a fire-and-forget one left running past stop() is a
      // real request leaking into whatever runs next. The ticker's REAL arm is
      // restored, because a spy would arm nothing for stop() to cancel.
      resetService({ ...CFG, pollSeconds: 3600, attendancePollSeconds: 10 });
      svc.pollOnce = async () => "skip";
      svc.attendanceTicker.arm = realAttendanceArm;
      svc.running = false;
      svc.start();
      assert.equal(svc.attendanceTicker.armed, true, "start() never armed the fast timer");

      svc.stop();
      assert.equal(svc.attendanceTicker.armed, false, "stop() left the fast timer running");
    });
  });
});

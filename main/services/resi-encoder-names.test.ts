// Two raw uuids on a wall, and a live stream with no clock.
//
// Production's event stream, read while this was happening:
//
//   "detail":"5a905d3b-… + eb43036d-…"
//
// The service filled its name map from `e.name` on the rows of
// GET /customers/{id}/encoders/status?wide=true, and THAT ENDPOINT SENDS NO
// NAME. Its rows are {uuid, status, operationalState, lastUpdate,
// preferredVersion, updateRequired} — captured at HTTP 200 off a real account.
// So every name lookup missed and every one of them fell back to the uuid.
//
// GET /customers/{id}/events, captured at HTTP 200 in the same session, carries
// {uuid, name, encoderName, encoderId, scheduleId, startTime, stopAfter, …} —
// an encoder NAME keyed by encoder id, and a real broadcast START TIME, which is
// the thing this integration had been working around with an observed-start
// apparatus because the encoder payload has none.
//
// This drives the REAL connect() against a stubbed Resi rather than testing the
// helpers, because the bug was in the join between two payloads: a pure test of
// either side passes while the wall shows uuids.
//
// The SHAPES here are the captured ones. The uuids and encoder names are
// placeholders — the real ones identify a customer's hardware and this
// repository is public. Every field that is actually read is as captured.

import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-utility-resi-names-"));
process.env.STAGE_UTILITY_DATA = path.join(TMP, "data");
process.env.HOME = path.join(TMP, "home");

const { resiService, encoderNamesFrom, currentEventFor, startedAtFrom } = await import("./resi-service.js");
const { streamStartStore } = await import("./stream-start-store.js");

import type { StreamStatusDTO } from "../types/stage.js";
import type { ResiEvent } from "./resi-service.js";

after(async () => {
  // The start store's save is fire-and-forget by design; let it drain before
  // pulling the directory out from under it.
  await new Promise((r) => setTimeout(r, 100));
  await fs.rm(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

// ── The account, as captured ────────────────────────────────────────────────

const CUSTOMER = "customer-0000";
const ENC_PRIMARY = "11111111-2222-4333-8444-555555555555";
const ENC_SECOND = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const NAME_PRIMARY = "Sanctuary Encoder - Primary";
const NAME_SECOND = "Chapel Encoder";

/** A uuid anywhere in the sub-line is the bug, whichever uuid it is. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const iso = (ms: number) => new Date(ms).toISOString();

/** `GET /encoders/status?wide=true` — note there is no `name` on these rows. */
function encoderRows(now: number, live: string[]): Record<string, unknown>[] {
  return [ENC_PRIMARY, ENC_SECOND].map((uuid) => ({
    uuid,
    status: live.includes(uuid) ? "started" : "stopped",
    operationalState: live.includes(uuid) ? "start" : "stop",
    lastUpdate: iso(now - 5_000),
    preferredVersion: "",
    updateRequired: false,
  }));
}

/** `GET /events` — newest first, as Resi returns them. */
function eventRows(now: number): ResiEvent[] {
  return [
    {
      uuid: "event-1",
      name: "Sunday | 11:30a",
      encoderName: NAME_PRIMARY,
      encoderId: ENC_PRIMARY,
      scheduleId: "schedule-1",
      startTime: iso(now - 40 * 60_000),
      stopAfter: iso(now + 60 * 60_000),
    },
    {
      uuid: "event-2",
      name: "Midweek",
      encoderName: NAME_SECOND,
      encoderId: ENC_SECOND,
      scheduleId: "schedule-2",
      startTime: iso(now - 7 * 24 * 3600_000),
      stopAfter: iso(now - 7 * 24 * 3600_000 + 2 * 3600_000),
    },
  ];
}

// ── A Resi that answers ─────────────────────────────────────────────────────

let requests: string[] = [];
let eventsStatus = 200;
let eventsPayload: unknown = [];
let encodersPayload: unknown = [];

const realFetch = globalThis.fetch;
const body = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  requests.push(url);
  if (url.endsWith("/auth/token")) return body(200, { access_token: "token", expires_in: 3600 });
  if (url.endsWith("/users/me")) return body(200, { customerId: CUSTOMER });
  if (url.includes("/encoders/status")) return body(200, encodersPayload);
  if (url.endsWith("/events")) return body(eventsStatus, eventsStatus === 200 ? eventsPayload : { error: "gone" });
  throw new Error(`the service asked for something this stub does not serve: ${url}`);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

/** The private state one poll needs, and the private poll itself. */
type Inner = {
  username: string | null;
  password: string | null;
  encoderIds: string[];
  running: boolean;
  token: string | null;
  tokenExpiresAt: number;
  customerId: string | null;
  events: ResiEvent[];
  eventsFetchedAt: number;
  eventsError: string | null;
  names: Map<string, string>;
  sawOffAir: boolean;
  last: StreamStatusDTO;
  connect(): Promise<void>;
};
const inner = resiService as unknown as Inner;

/** One real poll, snapshotted before stop() drops the snapshot to OFFLINE. */
async function poll(): Promise<StreamStatusDTO> {
  inner.running = true;
  await inner.connect();
  const snapshot = { ...inner.last };
  // connect() ends by scheduling the next one. Without this the timer fires
  // mid-suite and re-enters the stub.
  resiService.stop();
  return snapshot;
}

beforeEach(() => {
  streamStartStore._reset();
  requests = [];
  eventsStatus = 200;
  inner.username = "operator@example.invalid";
  inner.password = "secret";
  inner.encoderIds = [];
  inner.token = null;
  inner.tokenExpiresAt = 0;
  inner.customerId = null;
  inner.events = [];
  inner.eventsFetchedAt = 0;
  inner.eventsError = null;
  inner.names.clear();
  inner.sawOffAir = false;
});

// ── The bug, as it reached the wall ─────────────────────────────────────────

describe("the sub-line an operator actually reads", () => {
  test("names the encoders instead of printing their uuids", async () => {
    // THE BUG. Before the /events join this read
    // "11111111-…-555555555555 + 66666666-…-aaaaaaaaaaaa".
    const now = Date.now();
    encodersPayload = encoderRows(now, []);
    eventsPayload = eventRows(now);

    const snap = await poll();

    assert.equal(snap.connected, true);
    assert.equal(snap.detail, `${NAME_PRIMARY} + ${NAME_SECOND}`);
    assert.doesNotMatch(
      snap.detail ?? "",
      UUID_RE,
      `the sub-line is still a uuid: ${snap.detail} — the name join is not reaching the readout`,
    );
  });

  test("names the live one when one of them is streaming", async () => {
    const now = Date.now();
    encodersPayload = encoderRows(now, [ENC_PRIMARY]);
    eventsPayload = eventRows(now);

    const snap = await poll();

    assert.equal(snap.live, true);
    assert.equal(snap.detail, NAME_PRIMARY);
    assert.doesNotMatch(snap.detail ?? "", UUID_RE, `live sub-line fell back to a uuid: ${snap.detail}`);
  });
});

// ── The start time the encoder payload has never carried ────────────────────

describe("the elapsed clock", () => {
  test("uses the broadcast's own start time, without ever having watched it begin", async () => {
    // The case the whole sawOffAir apparatus exists to refuse: the integration
    // comes up mid-service and its FIRST poll finds the encoder already live.
    // With a reported start that is no longer a guess, so it is no longer null.
    const now = Date.now();
    const events = eventRows(now);
    encodersPayload = encoderRows(now, [ENC_PRIMARY]);
    eventsPayload = events;

    const snap = await poll();

    assert.equal(snap.live, true);
    assert.equal(
      snap.startedAt,
      new Date(Date.parse(events[0].startTime!)).toISOString(),
      "a stream Resi itself timestamps came back with no start, or with one we invented",
    );
  });

  test("refuses a row whose broadcast window has already closed", async () => {
    // Last week's event on the same encoder must not date today's stream. Its
    // stopAfter is seven days past, so nothing matches and the observed-start
    // rules take over — which, on a first sighting, means no clock at all.
    const now = Date.now();
    encodersPayload = encoderRows(now, [ENC_SECOND]);
    eventsPayload = eventRows(now);

    const snap = await poll();

    assert.equal(snap.live, true);
    assert.equal(
      snap.startedAt,
      null,
      "a broadcast that ended a week ago supplied the clock for the one running now",
    );
  });
});

// ── The join is allowed to fail ─────────────────────────────────────────────

describe("when the broadcast list stops answering", () => {
  test("the live readout survives it, and the operator gets a line to read", async () => {
    const now = Date.now();
    encodersPayload = encoderRows(now, [ENC_PRIMARY]);
    eventsPayload = [];
    eventsStatus = 500;

    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    let snap: StreamStatusDTO;
    try {
      snap = await poll();
    } finally {
      console.warn = realWarn;
    }

    assert.equal(snap.connected, true, "a names lookup failure took the whole integration down");
    assert.equal(snap.live, true, "a names lookup failure took the live readout down");
    assert.equal(snap.detail, ENC_PRIMARY, "with no join the uuid is still the honest fallback");
    assert.ok(
      warnings.some((w) => w.startsWith("[resi] broadcast list unavailable")),
      `nothing tagged [resi] explained the degradation. Saw: ${JSON.stringify(warnings)}`,
    );
  });
});

// ── The cache ───────────────────────────────────────────────────────────────

describe("the join is cached", () => {
  test("a second poll inside the window does not ask Resi again", async () => {
    const now = Date.now();
    encodersPayload = encoderRows(now, []);
    eventsPayload = eventRows(now);

    await poll();
    const afterFirst = requests.filter((u) => u.endsWith("/events")).length;
    await poll();
    const afterSecond = requests.filter((u) => u.endsWith("/events")).length;

    assert.equal(afterFirst, 1, "the first poll did not fetch the broadcast list exactly once");
    assert.equal(afterSecond, 1, "the second poll re-fetched a list that had not gone stale");
    // The status endpoint is NOT cached — it is the live state.
    assert.equal(requests.filter((u) => u.includes("/encoders/status")).length, 2);
  });
});

// ── The two readers of the join ─────────────────────────────────────────────

describe("encoderNamesFrom", () => {
  test("keys the name by encoderId, not by the row's own uuid", () => {
    const map = encoderNamesFrom(eventRows(Date.now()));
    assert.equal(map.get(ENC_PRIMARY), NAME_PRIMARY);
    assert.equal(map.get("event-1"), undefined, "keyed by the broadcast's uuid instead of the encoder's");
  });

  test("the newest row wins, so a renamed encoder reads as its new name", () => {
    const now = Date.now();
    const rows: ResiEvent[] = [
      { encoderId: ENC_PRIMARY, encoderName: "Old name", startTime: iso(now - 7 * 86_400_000) },
      { encoderId: ENC_PRIMARY, encoderName: "New name", startTime: iso(now - 3_600_000) },
    ];
    assert.equal(encoderNamesFrom(rows).get(ENC_PRIMARY), "New name");
    assert.equal(encoderNamesFrom([...rows].reverse()).get(ENC_PRIMARY), "New name", "it trusted Resi's ordering");
  });

  test("a row with no name or no encoder id contributes nothing", () => {
    const rows: ResiEvent[] = [
      { encoderId: ENC_PRIMARY, encoderName: "   " },
      { encoderName: NAME_SECOND },
      { encoderId: ENC_SECOND },
    ];
    assert.equal(encoderNamesFrom(rows).size, 0);
  });
});

describe("currentEventFor", () => {
  const NOW = Date.parse("2026-08-26T23:40:00Z");
  const open: ResiEvent = {
    encoderId: ENC_PRIMARY,
    encoderName: NAME_PRIMARY,
    startTime: "2026-08-26T23:20:11Z",
    stopAfter: "2026-08-27T01:30:11.000+00:00",
  };

  test("matches a broadcast whose window contains now", () => {
    assert.equal(currentEventFor([open], ENC_PRIMARY, NOW)?.startTime, open.startTime);
  });

  test("does not match another encoder's broadcast", () => {
    assert.equal(currentEventFor([open], ENC_SECOND, NOW), null);
  });

  test("does not match a broadcast that has not started", () => {
    const future = { ...open, startTime: "2026-08-27T09:00:00Z", stopAfter: "2026-08-27T11:00:00Z" };
    assert.equal(currentEventFor([future], ENC_PRIMARY, NOW), null);
  });

  test("does not match one whose window closed, even a minute past the grace", () => {
    const grace = 15 * 60_000;
    const ended = { ...open, stopAfter: iso(NOW - grace - 60_000) };
    assert.equal(currentEventFor([ended], ENC_PRIMARY, NOW), null);
  });

  test("still matches a broadcast overrunning its scheduled stop", () => {
    const overrunning = { ...open, stopAfter: iso(NOW - 60_000) };
    assert.ok(currentEventFor([overrunning], ENC_PRIMARY, NOW), "a stream five minutes long lost its clock");
  });

  test("skips a row with no usable window rather than guessing at one", () => {
    for (const broken of [{ ...open, stopAfter: null }, { ...open, startTime: "not a date" }]) {
      assert.equal(currentEventFor([broken], ENC_PRIMARY, NOW), null, JSON.stringify(broken));
    }
  });

  test("the newest matching broadcast wins over an older one still in grace", () => {
    const older = { ...open, startTime: "2026-08-26T21:00:00Z", stopAfter: iso(NOW - 60_000) };
    assert.equal(currentEventFor([older, open], ENC_PRIMARY, NOW)?.startTime, open.startTime);
  });
});

describe("startedAtFrom", () => {
  const NOW = Date.parse("2026-08-26T23:40:00Z");
  const row: ResiEvent = {
    encoderId: ENC_PRIMARY,
    startTime: "2026-08-26T23:20:11Z",
    stopAfter: "2026-08-27T01:30:11.000+00:00",
  };

  test("reads the matching broadcast's start", () => {
    assert.equal(startedAtFrom({ uuid: ENC_PRIMARY }, [row], NOW), "2026-08-26T23:20:11.000Z");
  });

  test("a field on the encoder payload still wins, for the day Resi adds one", () => {
    assert.equal(
      startedAtFrom({ uuid: ENC_PRIMARY, startedAt: "2026-08-26T23:00:00Z" }, [row], NOW),
      "2026-08-26T23:00:00.000Z",
    );
  });

  test("an unparseable start is absent, not passed on as a wrong clock", () => {
    assert.equal(startedAtFrom({ uuid: ENC_PRIMARY }, [{ ...row, startTime: "soon" }], NOW), null);
  });

  test("no events at all is the pre-join behaviour, unchanged", () => {
    assert.equal(startedAtFrom({ uuid: ENC_PRIMARY }), null);
  });
});

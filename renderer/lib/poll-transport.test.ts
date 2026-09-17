// The `?transport=poll` client transport.
//
// A panel opts in on its URL and api.ts collects frames with a small request
// every two seconds instead of holding /api/events open. The cases that matter
// are the ones a reader cannot see by inspection: that NO EventSource is opened
// (a page paying for both transports would be worse than either), that the
// client's position is carried on `since` and dropped on `resync`, and that a
// dead server is backed off from rather than asked every two seconds forever.
//
// Timers are replaced before api.ts is evaluated, so the poll loop is driven
// step by step rather than waited out — thirty seconds of backoff is not
// something to sleep through.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

// api.ts reads `location.search` at module scope. installDom does not expose
// `location` (it is not something a React render reaches for), so this is where
// the opt-in comes from.
(globalThis as { location?: unknown }).location = { search: "?transport=poll" };

// Any construction at all is a failure here, so count rather than model.
let eventSourcesOpened = 0;
class FailEventSource {
  static CLOSED = 2;
  readyState = 1;
  constructor() {
    eventSourcesOpened++;
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
(globalThis as { EventSource?: unknown }).EventSource = FailEventSource;

// ── a driveable clock ───────────────────────────────────────────────────────
interface Pending {
  ms: number;
  fn: () => void;
}
const pending: Pending[] = [];
let nextTimerId = 1;
const timerIds = new Map<number, Pending>();
(globalThis as { setTimeout?: unknown }).setTimeout = (fn: () => void, ms: number) => {
  const entry = { ms, fn };
  pending.push(entry);
  const id = nextTimerId++;
  timerIds.set(id, entry);
  return id;
};
(globalThis as { clearTimeout?: unknown }).clearTimeout = (id: number) => {
  const entry = timerIds.get(id);
  if (!entry) return;
  const i = pending.indexOf(entry);
  if (i >= 0) pending.splice(i, 1);
  timerIds.delete(id);
};

/** Fire the pending 200 ms channel report, if one is armed. Returns whether
 *  there was one. */
function fireReport(): boolean {
  const i = pending.findIndex((p) => p.ms === 200);
  if (i < 0) return false;
  const [entry] = pending.splice(i, 1);
  entry.fn();
  return true;
}

/** Fire the pending poll timer (the only one this module schedules besides the
 *  200 ms subscribe report). Returns the delay it had been given. */
function firePoll(): number {
  const i = pending.findIndex((p) => p.ms !== 200);
  assert.ok(i >= 0, `no poll timer pending; had: ${pending.map((p) => p.ms).join(", ")}`);
  const [entry] = pending.splice(i, 1);
  entry.fn();
  return entry.ms;
}

// ── a scripted server ───────────────────────────────────────────────────────
const requests: string[] = [];
let answer: () => Promise<unknown> = async () => ({ seq: 0, resync: false, frames: [] });
/** Non-null when the next poll should be answered with a non-2xx rather than a body. */
let refusal: number | null = null;

(globalThis as { fetch?: unknown }).fetch = async (url: unknown) => {
  const href = String(url);
  requests.push(href);
  if (!href.startsWith("/api/events/poll")) return { ok: true, json: async () => ({ ok: true }) };
  if (refusal !== null) {
    const status = refusal;
    refusal = null;
    // A real non-2xx: `ok` is false and the body is NOT a frame list. The client
    // must reject it on the status, not discover it by parsing.
    return { ok: false, status, json: async () => ({ error: "unavailable" }) };
  }
  return { ok: true, json: await answer().then((b) => async () => b) };
};

function serves(body: unknown): void {
  answer = async () => body;
}
function fails(): void {
  answer = async () => {
    throw new Error("network down");
  };
}
function refuses(status: number): void {
  refusal = status;
}

/** Let every already-resolved promise settle. setImmediate is untouched. */
const flush = () => new Promise((r) => setImmediate(r));

// Imported AFTER the stubs: api.ts starts polling at module scope.
const { onNotification } = await import("./api.js");
await flush();

after(() => teardown());

/** Only the poll requests, in order. */
const polls = () => requests.filter((r) => r.startsWith("/api/events/poll"));

describe("?transport=poll", () => {
  test("opens no EventSource, even once something subscribes", () => {
    const off = onNotification("pco:live", () => {});
    assert.equal(
      eventSourcesOpened,
      0,
      "a page on the polling transport that also holds a stream pays for both and is a minute behind on one",
    );
    off();
  });

  test("the first poll asks for a snapshot, with this client's id", () => {
    const first = polls()[0];
    assert.ok(first?.includes("cid="), `expected a cid on the first poll, got: ${first}`);
    assert.ok(!first.includes("since="), `the first poll must ask for a snapshot, got: ${first}`);
  });

  test("delivers a frame to a subscriber and carries the position forward", async () => {
    const seen: unknown[] = [];
    const off = onNotification("pco:live", (payload) => seen.push(payload));

    serves({ seq: 7, resync: false, frames: [{ channel: "pco:live", data: { mode: "item", label: "Welcome" } }] });
    firePoll();
    await flush();

    assert.deepEqual(seen, [{ mode: "item", label: "Welcome" }]);

    serves({ seq: 9, resync: false, frames: [] });
    firePoll();
    await flush();
    const last = polls().at(-1) ?? "";
    assert.ok(last.includes("since=7"), `the client must resume from where it got to, got: ${last}`);
    off();
  });

  test("drops its position when the server says it has rotated past us", async () => {
    serves({ seq: 40, resync: true, frames: [{ channel: "server:hello", data: { version: "9.9.9" } }] });
    firePoll();
    await flush();

    serves({ seq: 41, resync: false, frames: [] });
    firePoll();
    await flush();
    const last = polls().at(-1) ?? "";
    assert.ok(
      !last.includes("since="),
      `after a resync the client must ask for a fresh snapshot, not resume from a seq whose predecessors it never saw: ${last}`,
    );
  });

  test("caches a hydrated channel from a snapshot frame, for a subscriber that mounts later", async () => {
    serves({ seq: 50, resync: false, frames: [{ channel: "obs:status", data: { recording: true } }] });
    firePoll();
    await flush();

    const seen: Array<[unknown, boolean]> = [];
    const off = onNotification("obs:status", (payload, replayed) => seen.push([payload, replayed]));
    await flush();
    assert.deepEqual(
      seen,
      [[{ recording: true }, true]],
      "a poll frame must seed the replay cache the same way a stream hydrate does",
    );
    off();
  });

  test("delivers one copy per subscriber, not one per listener", async () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    const offA = onNotification("spl:metrics", (p) => a.push(p));
    const offB = onNotification("spl:metrics", (p) => b.push(p));

    serves({ seq: 60, resync: false, frames: [{ channel: "spl:metrics", data: { db: 72 } }] });
    firePoll();
    await flush();

    assert.equal(a.length, 1, "two subscribers on one channel must not each see the frame twice");
    assert.equal(b.length, 1);
    offA();
    offB();
  });

  test("an unsubscribed handler stops receiving", async () => {
    const seen: unknown[] = [];
    const off = onNotification("reaper:status", (p) => seen.push(p));
    off();
    serves({ seq: 70, resync: false, frames: [{ channel: "reaper:status", data: { recording: false } }] });
    firePoll();
    await flush();
    assert.deepEqual(seen, [], "an unsubscribed handler that keeps firing is a leak and a double render");
  });

  test("backs off a failing server and recovers", async () => {
    // Steady state first, so the doubling below starts from a known delay.
    serves({ seq: 80, resync: false, frames: [] });
    firePoll();
    await flush();
    const baseline = pending.find((p) => p.ms !== 200)?.ms;
    assert.equal(baseline, 2000, "a healthy poll asks again in two seconds");

    fails();
    firePoll();
    await flush();
    assert.equal(
      pending.find((p) => p.ms !== 200)?.ms,
      4000,
      "a display left against a stopped server must not ask every two seconds for as long as it is down",
    );

    fails();
    firePoll();
    await flush();
    assert.equal(pending.find((p) => p.ms !== 200)?.ms, 8000);

    refuses(503);
    firePoll();
    await flush();
    assert.equal(
      pending.find((p) => p.ms !== 200)?.ms,
      16_000,
      "a non-2xx answer is a failure too — a 503 body is not a frame list",
    );

    serves({ seq: 81, resync: false, frames: [] });
    firePoll();
    await flush();
    assert.equal(
      pending.find((p) => p.ms !== 200)?.ms,
      2000,
      "a recovered server must be polled at the normal cadence again, not left on a 16 s delay",
    );
  });

  test("caps the backoff below the server's 30 s client expiry", async () => {
    for (let i = 0; i < 12; i++) {
      fails();
      firePoll();
      await flush();
    }
    assert.equal(
      pending.find((p) => p.ms !== 200)?.ms,
      20_000,
      "a ceiling at or above the server's 30 s TTL expires the client every cycle, " +
        "discarding the channel filter with nothing to re-report it",
    );
    serves({ seq: 90, resync: false, frames: [] });
    firePoll();
    await flush();
  });

  test("re-reports the channel set on a resync", async () => {
    // One cause of a resync is the server having expired this cid, which
    // discards the channel filter it was holding. Nothing else sends it again:
    // reportChannels fires only when a subscription changes, and none has.
    const off = onNotification("pco:live", () => {});
    fireReport(); // drain the report this subscribe armed
    const before = requests.filter((r) => r.startsWith("/api/events/subscribe")).length;

    serves({ seq: 300, resync: true, frames: [] });
    firePoll();
    await flush();

    assert.ok(fireReport(), "a resync must arm a fresh channel report");
    await flush();
    assert.equal(
      requests.filter((r) => r.startsWith("/api/events/subscribe")).length,
      before + 1,
      "without this the client silently receives every channel on the box, metrics firehose included",
    );
    off();
    fireReport();
  });
});

// The device-flow state machine, I/O and clock both injected.
//
// Nothing here touches the network or waits on a real timer: `youtubeConnectDeps`
// is overwritten for the length of each test and restored in `afterEach`, the way
// `stateProbeDeps` is driven in companion-state-probe.test.ts. `saveConnection`,
// `clearConnection` and `connectionInfo` stand in for integration-manager, so
// these tests say nothing about settings.json or secrets.bin — that is
// integration-secret-parity.test.ts and the routes test's job.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  __resetForTests,
  cancel,
  disconnect,
  start,
  status,
  youtubeConnectDeps,
} from "./youtube-connect.js";

const real = { ...youtubeConnectDeps };

let clock = Date.parse("2026-09-17T14:00:00.000Z");
/** Pending timers, oldest first — `[fn, dueAt]`. */
let timers: { fn: () => void; at: number }[] = [];
/** Every request made, in order, as `METHOD path`. */
let requests: { url: string; body: string }[] = [];
/** What the fake Google answers for each URL host, keyed by pathname. */
let handlers: Record<string, () => { status: number; body: unknown }> = {};
let saved: { refreshToken: string; channelTitle: string }[] = [];
let cleared = 0;
let storedConnection: { connected: boolean; channelTitle: string | null } = { connected: false, channelTitle: null };

function installFakes(): void {
  youtubeConnectDeps.now = () => clock;
  youtubeConnectDeps.schedule = (fn, ms) => {
    const entry = { fn, at: clock + ms };
    timers.push(entry);
    return () => {
      timers = timers.filter((t) => t !== entry);
    };
  };
  youtubeConnectDeps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ url: url.pathname, body });
    const handler = handlers[url.pathname];
    const { status: s, body: b } = handler ? handler() : { status: 200, body: {} };
    return new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  youtubeConnectDeps.saveConnection = async (refreshToken, channelTitle) => {
    saved.push({ refreshToken, channelTitle });
    storedConnection = { connected: true, channelTitle: channelTitle || null };
  };
  youtubeConnectDeps.clearConnection = async () => {
    cleared++;
    storedConnection = { connected: false, channelTitle: null };
  };
  youtubeConnectDeps.connectionInfo = async () => storedConnection;
}

afterEach(() => {
  __resetForTests();
  Object.assign(youtubeConnectDeps, real);
  clock = Date.parse("2026-09-17T14:00:00.000Z");
  timers = [];
  requests = [];
  handlers = {};
  saved = [];
  cleared = 0;
  storedConnection = { connected: false, channelTitle: null };
});

/** Let every pending microtask settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

/** Fire every timer due within `ms`, advancing the clock and flushing between
 *  each — a poll's next timer is scheduled from inside the promise chain the
 *  fetch stub returns, so a loop that only looked at what was already queued
 *  would advance the clock past the whole window without running a poll. */
async function advance(ms: number): Promise<void> {
  const until = clock + ms;
  for (let i = 0; i < 64; i++) {
    await flush();
    const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    clock = due.at;
    timers = timers.filter((t) => t !== due);
    due.fn();
  }
  await flush();
  clock = until;
}

const DEVICE_CODE = "/device/code";
const TOKEN = "/token";
const CHANNELS = "/youtube/v3/channels";

function deviceCodeOk(overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    body: {
      device_code: "dc-1",
      user_code: "GQVQ-SHNC",
      verification_url: "https://www.google.com/device",
      expires_in: 1800,
      interval: 5,
      ...overrides,
    },
  };
}

describe("start", () => {
  test("issues a code and schedules the first poll at the stated interval", async () => {
    installFakes();
    handlers[DEVICE_CODE] = () => deviceCodeOk();
    const result = await start("client-id", "client-secret");

    assert.equal(result.status, "pending");
    assert.equal(result.userCode, "GQVQ-SHNC");
    assert.equal(result.verificationUrl, "https://www.google.com/device");
    assert.equal(result.expiresAt, clock + 1800 * 1000);
    assert.deepEqual(requests.map((r) => r.url), [DEVICE_CODE]);
    assert.equal(timers.length, 1, "a poll must be scheduled after the code is issued");
    assert.equal(timers[0].at, clock + 5000, "the first poll must run at the stated interval");
  });

  test("a second start cancels the first", async () => {
    installFakes();
    handlers[DEVICE_CODE] = () => deviceCodeOk({ user_code: "FIRST-CODE" });
    await start("a", "a-secret");
    assert.equal(timers.length, 1);

    handlers[DEVICE_CODE] = () => deviceCodeOk({ user_code: "SECOND-CODE" });
    const second = await start("b", "b-secret");

    assert.equal(second.userCode, "SECOND-CODE");
    assert.equal(timers.length, 1, "the first attempt's timer must be gone, not left running alongside the second");

    // Prove it really is gone, not just replaced in the list: advance past
    // where the first poll would have fired and check nothing hit /token with
    // the first attempt's device code.
    handlers[TOKEN] = () => ({ status: 400, body: { error: "authorization_pending" } });
    await advance(10_000);
    const tokenBodies = requests.filter((r) => r.url === TOKEN).map((r) => r.body);
    for (const b of tokenBodies) assert.ok(!b.includes("dc-1") || b.includes("device_code=dc-1"));
  });

  test("invalid_client at the device/code step names the client-type fix", async () => {
    installFakes();
    handlers[DEVICE_CODE] = () => ({ status: 400, body: { error: "invalid_client" } });
    const result = await start("wrong-type-client", "secret");
    assert.equal(result.status, "error");
    assert.equal(
      result.message,
      "This OAuth client cannot use the device flow. Create one of type TVs and Limited Input devices.",
    );
    assert.equal(timers.length, 0, "an error at start must not schedule a poll");
  });
});

describe("polling", () => {
  async function startPending(): Promise<void> {
    handlers[DEVICE_CODE] = () => deviceCodeOk();
    await start("client-id", "client-secret");
  }

  test("authorization_pending keeps waiting at the same interval", async () => {
    installFakes();
    await startPending();
    handlers[TOKEN] = () => ({ status: 428, body: { error: "authorization_pending" } });
    await advance(5000);
    assert.deepEqual(await status(), {
      status: "pending",
      userCode: "GQVQ-SHNC",
      verificationUrl: "https://www.google.com/device",
      expiresAt: Date.parse("2026-09-17T14:00:00.000Z") + 1800 * 1000,
    });
    assert.equal(timers.length, 1, "a poll must still be scheduled");
    assert.equal(timers[0].at - clock, 5000, "the interval must not have changed");
  });

  test("slow_down widens the interval by 5 seconds and keeps polling", async () => {
    installFakes();
    await startPending();
    handlers[TOKEN] = () => ({ status: 403, body: { error: "slow_down" } });
    await advance(5000);
    assert.equal(timers[0].at - clock, 10_000, "slow_down must add 5s to the 5s interval");

    // And it compounds: a second slow_down on top of the widened interval.
    await advance(10_000);
    assert.equal(timers[0].at - clock, 15_000);
  });

  test("access_denied ends the attempt with the stated sentence", async () => {
    installFakes();
    await startPending();
    handlers[TOKEN] = () => ({ status: 400, body: { error: "access_denied" } });
    await advance(5000);
    assert.deepEqual(await status(), { status: "error", message: "You declined the request in Google" });
    assert.equal(timers.length, 0, "nothing may poll after a terminal state");
  });

  test("expired_token ends the attempt with the stated sentence", async () => {
    installFakes();
    await startPending();
    handlers[TOKEN] = () => ({ status: 400, body: { error: "expired_token" } });
    await advance(5000);
    assert.deepEqual(await status(), { status: "error", message: "The code expired; press Connect again" });
    assert.equal(timers.length, 0);
  });

  test("success writes the refresh token and channel title through the injected saver, and stops polling", async () => {
    installFakes();
    await startPending();
    handlers[TOKEN] = () => ({
      status: 200,
      body: { access_token: "access-1", refresh_token: "refresh-1" },
    });
    handlers[CHANNELS] = () => ({
      status: 200,
      body: { items: [{ snippet: { title: "Grace Church" } }] },
    });
    await advance(5000);

    assert.deepEqual(saved, [{ refreshToken: "refresh-1", channelTitle: "Grace Church" }]);
    assert.deepEqual(await status(), { status: "connected", channelTitle: "Grace Church" });
    assert.equal(timers.length, 0, "nothing may poll after a terminal state");
  });

  test("an unrecognised error ends the attempt with Google's own description", async () => {
    installFakes();
    await startPending();
    handlers[TOKEN] = () => ({
      status: 400,
      body: { error: "invalid_grant", error_description: "Token has been expired or revoked" },
    });
    await advance(5000);
    assert.deepEqual(await status(), { status: "error", message: "Token has been expired or revoked" });
  });
});

describe("cancel", () => {
  test("stops the timer and returns to idle", async () => {
    installFakes();
    handlers[DEVICE_CODE] = () => deviceCodeOk();
    await start("client-id", "client-secret");
    assert.equal(timers.length, 1);

    cancel();

    assert.equal(timers.length, 0);
    assert.deepEqual(await status(), { status: "idle" });

    // And it really is dead: advancing past where the cancelled poll would
    // have fired must not reach the token endpoint at all.
    handlers[TOKEN] = () => ({ status: 400, body: { error: "authorization_pending" } });
    await advance(10_000);
    assert.deepEqual(requests.filter((r) => r.url === TOKEN), []);
  });

  test("is a no-op when nothing is pending", async () => {
    installFakes();
    cancel();
    assert.deepEqual(await status(), { status: "idle" });
  });
});

describe("status", () => {
  test("reports connected once a token is on file, even over a stale error", async () => {
    installFakes();
    // A failed attempt, leaving lastError set. access_denied only fires from a
    // poll, so start with a real device code and decline it there, rather than
    // failing at the start step.
    handlers[DEVICE_CODE] = () => deviceCodeOk();
    await start("client-id", "client-secret");
    handlers[TOKEN] = () => ({ status: 400, body: { error: "access_denied" } });
    await advance(5000);
    assert.deepEqual(await status(), { status: "error", message: "You declined the request in Google" });

    // A token then arrives some other way — the "Paste a token instead"
    // disclosure, which writes straight through integration-manager and never
    // touches this module at all.
    storedConnection = { connected: true, channelTitle: "Grace Church" };

    assert.deepEqual(await status(), { status: "connected", channelTitle: "Grace Church" });
  });
});

describe("disconnect", () => {
  test("clears the stored connection through the injected clearer and stops any pending attempt", async () => {
    installFakes();
    handlers[DEVICE_CODE] = () => deviceCodeOk();
    await start("client-id", "client-secret");

    await disconnect();

    assert.equal(cleared, 1);
    assert.equal(timers.length, 0);
    assert.deepEqual(await status(), { status: "idle" });
  });
});

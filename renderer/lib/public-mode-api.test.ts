// api.ts on the public page: one WebSocket, and nothing written.
//
// The shared client has three transports for the church's own server — a shared
// worker holding the event stream, a direct EventSource, and `?transport=poll` — and
// on the public host none of them has anything to talk to. This is the page's own
// document carrying `data-servicecue-public` (renderer/lib/public-mode.ts), and what
// that changes in api.ts and client-log.ts is asserted here from the outside: what
// is constructed, what is fetched, what a subscriber receives.
//
// The same module in a document WITHOUT the attribute is the other half, covered by
// every existing test of api.ts: this file only has to show the flag is what makes
// the difference, by turning it off and back on.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, mock, test } from "node:test";

import { installDom } from "../test-dom.js";
import { FakeSocket } from "../test-fixtures/fake-socket.js";

const teardown = installDom('<!doctype html><html data-servicecue-public><body></body></html>');
after(teardown);

const g = globalThis as unknown as Record<string, unknown>;

// A page that arrives with `?transport=poll` in its address, as a link from a panel can.
g.location = { protocol: "https:", host: "servicecue.example.workers.dev", search: "?transport=poll" };

// Anything these three construct is a failure, so count rather than model.
let eventSources = 0;
class CountingEventSource {
  static CLOSED = 2;
  readyState = 1;
  constructor() {
    eventSources++;
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
g.EventSource = CountingEventSource;
let sharedWorkers = 0;
g.SharedWorker = class {
  port = { postMessage() {}, start() {}, onmessage: null };
  constructor() {
    sharedWorkers++;
  }
};

g.WebSocket = FakeSocket;

const requests: string[] = [];
g.fetch = async (url: unknown, init?: RequestInit) => {
  requests.push(`${init?.method ?? "GET"} ${String(url)}`);
  return { ok: true, status: 200, text: async () => JSON.stringify({ at: 1, now: 2 }), json: async () => ({}) };
};
console.warn = () => {};
console.log = () => {};

mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
const { onNotification, __resetReplayCacheForTests } = await import("./api.js");
const { logToServer } = await import("./client-log.js");
const { __resetPublicLiveForTests } = await import("./public-live.js");

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

beforeEach(() => {
  document.documentElement.setAttribute("data-servicecue-public", "");
});
afterEach(() => {
  __resetPublicLiveForTests();
  __resetReplayCacheForTests();
  FakeSocket.instances = [];
  requests.length = 0;
  document.documentElement.setAttribute("data-servicecue-public", "");
});

describe("a subscription on the public page", () => {
  test("opens the one socket, and constructs none of the church server's transports", async () => {
    const off = [onNotification("pco:live", () => {}), onNotification("stage:state-changed", () => {}), onNotification("spl:history", () => {})];
    await settle();
    assert.equal(FakeSocket.instances.length, 1, "one socket however many subscribers");
    assert.equal(FakeSocket.instances[0]!.url, "wss://servicecue.example.workers.dev/api/live");
    assert.equal(eventSources, 0, "an EventSource was opened against a host that has no event stream");
    assert.equal(sharedWorkers, 0, "the shared worker was started");
    for (const o of off) o();
  });

  test("ignores ?transport=poll: it never asks the host for an event poll", async () => {
    onNotification("pco:live", () => {});
    FakeSocket.instances[0]!.open();
    mock.timers.tick(60_000);
    await settle();
    assert.deepEqual(
      requests.filter((r) => r.includes("/api/events")),
      [],
      "the poll transport was started by a query string a link carried over",
    );
  });

  test("never reports its channels to the server, however long it runs", async () => {
    const off = onNotification("pco:live", () => {});
    onNotification("spl:history", () => {});
    off();
    FakeSocket.instances[0]!.open();
    mock.timers.tick(10 * 60_000);
    await settle();
    assert.deepEqual(
      requests.filter((r) => !r.startsWith("GET ")),
      [],
      "something other than a GET was sent",
    );
    assert.ok(!requests.some((r) => r.includes("/api/events/subscribe")), "the channel report went out");
  });

  test("delivers a frame to the subscribers of its channel and no other, not as a replay", async () => {
    const heard: string[] = [];
    onNotification("pco:live", (p, replayed) => void heard.push(`pco ${JSON.stringify(p)} ${replayed}`));
    onNotification("spl:history", (p, replayed) => void heard.push(`spl ${JSON.stringify(p)} ${replayed}`));
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.say({ channel: "pco:live", data: { mode: "item", currentItemId: "9" } });
    FakeSocket.instances[0]!.say({ channel: "stage:state-changed", data: { pcoConfigured: true } });
    await settle();
    assert.deepEqual(heard, ['pco {"mode":"item","currentItemId":"9"} false']);
  });

  test("hands a subscriber that arrives late the last frame, marked as a replay, exactly as the other transports do", async () => {
    onNotification("pco:live", () => {});
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.say({ channel: "pco:live", data: { mode: "preservice" } });
    const late: string[] = [];
    onNotification("pco:live", (p, replayed) => void late.push(`${JSON.stringify(p)} ${replayed}`));
    await settle();
    assert.deepEqual(late, ['{"mode":"preservice"} true']);
    assert.equal(FakeSocket.instances.length, 1, "a second subscriber opened a second socket");
  });

  test("a subscriber that leaves stops hearing, and the socket stays for the page", async () => {
    const heard: unknown[] = [];
    const off = onNotification("pco:live", (p) => void heard.push(p));
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.say({ channel: "pco:live", data: 1 });
    off();
    FakeSocket.instances[0]!.say({ channel: "pco:live", data: 2 });
    await settle();
    assert.deepEqual(heard, [1]);
    assert.equal(FakeSocket.instances[0]!.readyState, 1);
  });
});

describe("logging on the public page", () => {
  test("a client log line stops at the console", async () => {
    logToServer("servicecue", "could not read the rundown");
    await settle();
    assert.deepEqual(requests, [], "a log line was sent to a host that has no log");
  });

  test("and it is the attribute that makes the difference: the same call on the church's own page posts it", async () => {
    document.documentElement.removeAttribute("data-servicecue-public");
    logToServer("servicecue", "could not read the rundown");
    await settle();
    assert.deepEqual(requests, ["POST /api/log/client"]);
    document.documentElement.setAttribute("data-servicecue-public", "");
    requests.length = 0;
    logToServer("servicecue", "could not read the rundown");
    await settle();
    assert.deepEqual(requests, []);
  });
});

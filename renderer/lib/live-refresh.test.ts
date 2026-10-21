// live-refresh.ts — how a page keeps what it read current.
//
// In the building a page reads again on a timer, and that is unchanged here. On the
// public page the timer is the cost this exists to remove: every open tab reading every
// doc every minute is most of a free day for nothing. So there a page reads when the
// Worker says the doc changed, when the transport says everything may have (after a
// connect), and on a slow timer only while it has no socket to be told by.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, mock, test } from "node:test";

import { installDom } from "../test-dom.js";
import { FakeSocket } from "../test-fixtures/fake-socket.js";

const teardown = installDom('<!doctype html><html data-servicecue-public><body></body></html>');
after(teardown);

const g = globalThis as unknown as Record<string, unknown>;
g.WebSocket = FakeSocket;
g.location = { protocol: "https:", host: "servicecue.example.workers.dev", search: "" };
g.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ at: null, now: 5_000_000 }), json: async () => ({}) });
console.warn = () => {};
console.log = () => {};

const { docsChanged, refreshWhileMounted, PUBLIC_SAFETY_READ_MS } = await import("./live-refresh.js");
const { __resetPublicLiveForTests } = await import("./public-live.js");
const { __resetReplayCacheForTests } = await import("./api.js");

const setMode = (publicPage: boolean) =>
  publicPage ? document.documentElement.setAttribute("data-servicecue-public", "") : document.documentElement.removeAttribute("data-servicecue-public");

beforeEach(() => {
  setMode(true);
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
});
afterEach(() => {
  mock.timers.reset();
  __resetPublicLiveForTests();
  __resetReplayCacheForTests();
  FakeSocket.instances = [];
});

describe("docsChanged", () => {
  test("is true when the message names one of the docs, and false when it names others", () => {
    assert.equal(docsChanged({ keys: ["state", "servicecue-layouts"] }, ["servicecue-layouts", "servicecue-roles"]), true);
    assert.equal(docsChanged({ keys: ["state"] }, ["servicecue-layouts", "servicecue-roles"]), false);
    assert.equal(docsChanged({ keys: [] }, ["state"]), false);
  });

  test("is true for any docs when the message says all may have changed, as a connect does", () => {
    assert.equal(docsChanged({ keys: [], all: true }, ["rundown-1"]), true);
    assert.equal(docsChanged({ keys: ["a"], all: true }, ["rundown-1"]), true);
    assert.equal(docsChanged({ keys: [], all: false }, ["rundown-1"]), false);
  });

  test("is false for anything that is not a message about docs", () => {
    for (const data of [null, undefined, "state", 3, [], {}, { keys: "state" }, { keys: null }]) {
      assert.equal(docsChanged(data, ["state"]), false, JSON.stringify(data));
    }
  });
});

describe("in the building", () => {
  test("a page reads again on its own timer, as it always did, and stops when told to", () => {
    setMode(false);
    let reads = 0;
    const stop = refreshWhileMounted(() => void reads++, ["service-types"], 60_000);
    mock.timers.tick(59_999);
    assert.equal(reads, 0);
    mock.timers.tick(1);
    assert.equal(reads, 1);
    mock.timers.tick(120_000);
    assert.equal(reads, 3);
    stop();
    mock.timers.tick(600_000);
    assert.equal(reads, 3, "it went on reading after it was stopped");
  });

  test("a page that reads once stays as it was: no timer, and nothing to listen to", () => {
    setMode(false);
    let reads = 0;
    const stop = refreshWhileMounted(() => void reads++, ["service-types"], null);
    mock.timers.tick(3_600_000);
    assert.equal(reads, 0);
    stop();
    assert.equal(FakeSocket.instances.length, 0, "the building's page opened the public socket");
  });
});

describe("on the public page", () => {
  test("never reads on the building's minute: with the socket open it reads only when told", () => {
    let reads = 0;
    const stop = refreshWhileMounted(() => void reads++, ["servicecue-layouts"], 60_000);
    FakeSocket.last.open();
    reads = 0; // the connect says every doc changed, which is its own case
    mock.timers.tick(PUBLIC_SAFETY_READ_MS * 3);
    assert.equal(reads, 0, "a page with a socket polled");
    stop();
  });

  test("reads when the Worker names its doc, and not when it names another", () => {
    let reads = 0;
    const stop = refreshWhileMounted(() => void reads++, ["servicecue-layouts", "servicecue-roles"], 60_000);
    FakeSocket.last.open();
    reads = 0;
    FakeSocket.last.say({ channel: "publish:docs", data: { keys: ["state"] } });
    FakeSocket.last.say({ channel: "publish:docs", data: { keys: ["rundown-1-2"] } });
    assert.equal(reads, 0);
    FakeSocket.last.say({ channel: "publish:docs", data: { keys: ["servicecue-roles"] } });
    assert.equal(reads, 1);
    FakeSocket.last.say({ channel: "publish:docs", data: { keys: ["servicecue-layouts", "servicecue-roles"] } });
    assert.equal(reads, 2, "a message naming both is one read, not two");
    stop();
  });

  test("reads again after every connect, the first as well as one after a drop", () => {
    let reads = 0;
    const stop = refreshWhileMounted(() => void reads++, ["rundown-1"], 60_000);
    FakeSocket.last.open();
    assert.equal(reads, 1, "a doc that changed between the page's read and its socket opening would be missed");
    FakeSocket.last.drop();
    mock.timers.tick(2_000); // the backoff, with its jitter
    assert.equal(FakeSocket.instances.length, 2);
    FakeSocket.last.open();
    assert.equal(reads, 2);
    stop();
  });

  test("keeps a slow net while it has no socket, and none while it has one", () => {
    let reads = 0;
    const stop = refreshWhileMounted(() => void reads++, ["rundown-1"], 60_000);
    // No socket has opened: the page is on its own.
    mock.timers.tick(PUBLIC_SAFETY_READ_MS - 1);
    assert.equal(reads, 0);
    mock.timers.tick(1);
    assert.equal(reads, 1);
    mock.timers.tick(PUBLIC_SAFETY_READ_MS);
    assert.equal(reads, 2);

    FakeSocket.last.open();
    reads = 0;
    mock.timers.tick(PUBLIC_SAFETY_READ_MS * 5);
    assert.equal(reads, 0, "a page with a socket read on the net's timer");
    stop();
  });

  test("the net is minutes, not the building's minute", () => {
    assert.ok(PUBLIC_SAFETY_READ_MS >= 5 * 60_000, "a page with no socket reads often enough to spend the day's allowance");
  });

  test("stopping stops all of it", () => {
    let reads = 0;
    const stop = refreshWhileMounted(() => void reads++, ["rundown-1"], 60_000);
    FakeSocket.last.open();
    reads = 0;
    stop();
    FakeSocket.last.say({ channel: "publish:docs", data: { keys: ["rundown-1"] } });
    FakeSocket.last.drop();
    mock.timers.tick(PUBLIC_SAFETY_READ_MS * 3);
    assert.equal(reads, 0, "a page that was stopped went on reading");
  });
});

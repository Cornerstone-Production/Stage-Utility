// A tab that fell back off the shared SSE worker gives its own stream back when the
// worker recovers.
//
// abandonWorker() moves a tab onto a direct EventSource, and the retry moves it back
// onto the worker and closes that stream, so the connection is returned rather than
// left open and idle. It closed it only once sseListeners had emptied, and it
// emptied it by finding each fallback wrapper there by IDENTITY, while abandonWorker
// had pushed two different objects for each wrapper, one into each list. Nothing
// was ever found, the list never emptied, and the direct stream stayed open beside
// the worker's for the rest of the session: per tab, the connection exhaustion the
// worker exists to prevent.
//
// A fake SharedWorker that answers every ping, so the retry really recovers, and a
// fake EventSource that records closing. Both installed before api.ts loads: it
// decides at load whether this browser has SharedWorker.

import { strict as assert } from "node:assert";
import { after, mock, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

class FakeEventSource {
  static CLOSED = 2;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners: Array<[string, unknown]> = [];
  constructor(public url: string) {
    sources.push(this);
  }
  addEventListener(type: string, fn: unknown) {
    this.listeners.push([type, fn]);
  }
  removeEventListener(type: string, fn: unknown) {
    const i = this.listeners.findIndex(([t, f]) => t === type && f === fn);
    if (i >= 0) this.listeners.splice(i, 1);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}
const sources: FakeEventSource[] = [];

interface FakePort {
  onmessage: ((e: { data: unknown }) => void) | null;
  start: () => void;
  postMessage: (m: { type?: string }) => void;
}
const ports: FakePort[] = [];
class FakeSharedWorker {
  port: FakePort;
  constructor() {
    const port: FakePort = {
      onmessage: null,
      start() {},
      postMessage(m) {
        if (m?.type === "ping") port.onmessage?.({ data: { type: "pong", streamOpen: true } });
      },
    };
    this.port = port;
    ports.push(port);
  }
}

(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
(globalThis as unknown as { SharedWorker: unknown }).SharedWorker = FakeSharedWorker;
(globalThis as unknown as { fetch: unknown }).fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
mock.method(console, "warn", () => {});
mock.method(console, "log", () => {});
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

const { __sseFallback, onNotification } = await import("./api.js");

after(() => {
  mock.timers.reset();
  mock.restoreAll();
  teardown();
});

/** How long the first worker retry waits (WORKER_RETRY_MIN_MS in api.ts). */
const FIRST_RETRY_MS = 30_000;

test("recovering onto the worker closes the tab's own stream", () => {
  onNotification("stage:state", () => {});
  __sseFallback.abandon("no pong");
  const direct = sources.at(-1);
  assert.ok(direct, "abandoning the worker opened no direct stream");
  assert.ok(__sseFallback.wrapperCount() > 0, "no fallback wrappers, so this case tests nothing");
  mock.timers.tick(FIRST_RETRY_MS);
  assert.equal(direct.readyState, FakeEventSource.CLOSED, "the direct stream stayed open beside the recovered worker");
  assert.equal(__sseFallback.listenerCount(), 0, "the fallback wrappers were left on the direct path");
});

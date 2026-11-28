// A charger's bay poll stops when its link does.
//
// The charger re-polls every bay on a 30 s interval of its own, created in
// onConnected(). Nothing ever cleared it: disconnect() stopped the heartbeat and
// the reconnect timer, which the base class owned, and the charger's interval
// was not the base class's. Removing or disabling a charger connection left the
// interval holding the discarded provider for the life of the process.
//
// "No command reached the charger" cannot be the assertion: send() is a no-op
// once the socket is gone, which is exactly the comment that made the leak look
// harmless. So this watches pollAllBays itself, and moves the clock past the
// poll interval with node:test's mock timers.
//
// Real path: a loopback TCP server stands in for the charger, so connect()
// reaches onConnected() the way it does against hardware. The server never
// answers; nothing is sent to a real device.

import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

import type { ConnectionState } from "../../types/integrations.js";
import { ShureCharger } from "./shure-charger.js";

const POLL_MS = 30_000;

let server: net.Server;
let port = 0;
const peers = new Set<net.Socket>();

before(async () => {
  server = net.createServer((sock) => {
    peers.add(sock);
    sock.on("close", () => peers.delete(sock));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  for (const s of peers) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Connect a charger to the loopback server and wait until onConnected ran. */
async function connected(): Promise<{ p: ShureCharger; polls: { calls: number }; states: ConnectionState[] }> {
  const p = new ShureCharger();
  const polls = { calls: 0 };
  // Counted on the instance: the interval calls `this.pollAllBays()`.
  mock.method(p as unknown as { pollAllBays(): void }, "pollAllBays", () => {
    polls.calls++;
  });
  const states: ConnectionState[] = [];
  const up = new Promise<void>((resolve) => {
    p.onConnectionStateChange((s) => {
      states.push(s);
      if (s === "connected") resolve();
    });
  });
  await p.connect({ host: "127.0.0.1", port, channels: 2 });
  await up;
  assert.equal(polls.calls, 1, "onConnected() did not poll the bays, so this case proves nothing");
  return { p, polls, states };
}

describe("a Shure charger's bay poll", () => {
  it("still runs while the link is up", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    const { p, polls } = await connected();
    try {
      mock.timers.tick(POLL_MS);
      assert.equal(polls.calls, 2, "the interval never fired — the cases below would pass vacuously");
    } finally {
      await p.disconnect();
      mock.timers.reset();
    }
  });

  it("stops on disconnect()", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    const { p, polls } = await connected();
    try {
      await p.disconnect();
      polls.calls = 0;
      mock.timers.tick(POLL_MS * 4);
      assert.equal(
        polls.calls,
        0,
        `the 30 s bay poll fired ${polls.calls} time(s) after disconnect() — the removed ` +
          "connection's provider is held by its interval for the life of the process",
      );
    } finally {
      mock.timers.reset();
    }
  });

  it("stops when the charger hangs up", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    const { p, polls, states } = await connected();
    try {
      const down = new Promise<void>((resolve) => {
        p.onConnectionStateChange((s) => {
          states.push(s);
          if (s === "disconnected") resolve();
        });
      });
      for (const s of peers) s.destroy();
      await down;
      polls.calls = 0;
      mock.timers.tick(POLL_MS * 4);
      assert.equal(polls.calls, 0, `the bay poll fired ${polls.calls} time(s) on a socket that had closed`);
    } finally {
      // The provider is still enabled, so it queued a reconnect: stop it.
      await p.disconnect();
      mock.timers.reset();
    }
  });
});

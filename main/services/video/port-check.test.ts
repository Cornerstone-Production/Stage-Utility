import assert from "node:assert/strict";
import * as dgram from "node:dgram";
import * as net from "node:net";
import { describe, it } from "node:test";

import type { VideoPorts } from "../../types/video.js";
import { busyPorts, shortenHolder } from "./port-check.js";

interface Held<T> {
  handle: T;
  port: number;
  close(): Promise<void>;
}

function openTcp(host: string): Promise<Held<net.Server>> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    // busyPorts()'s "who holds it" lookup opens a real TCP connection
    // (describePortHolder probes GET /api/version). A server with no
    // 'connection' listener still accepts it and counts it as active, so
    // with nothing destroying the socket server.close() below waits
    // forever for a connection the probe already gave up on. Destroying it
    // on accept keeps this a bare "something is listening" fixture, never
    // an actual server, and makes describePortHolder's probe fail fast
    // instead of running out its 1.5 s timeout.
    server.on("connection", (socket) => socket.destroy());
    server.once("error", reject);
    server.listen({ port: 0, host }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("TCP listener produced no port"));
        return;
      }
      resolve({
        handle: server,
        port: address.port,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function openUdp(host: string): Promise<Held<dgram.Socket>> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, host, () => {
      const address = socket.address();
      resolve({
        handle: socket,
        port: address.port,
        close: () => new Promise((res) => socket.close(() => res())),
      });
    });
  });
}

describe("busyPorts", () => {
  it("reports a held TCP loopback port and a held UDP LAN port, and nothing once both are released", async () => {
    // Real free ports, resolved by the OS (port 0) rather than picked by
    // hand, so this cannot collide with anything already bound on the test
    // host. Six fields, six ports: two are kept open through the first
    // check (one per protocol, on the host busyPorts itself will probe —
    // 127.0.0.1 for the loopback field, 0.0.0.0 for the LAN field), the
    // other four are opened and released immediately, so they are real,
    // momentarily-free ports rather than arbitrary numbers that might
    // already be in use for something else entirely.
    const heldTcp = await openTcp("127.0.0.1");
    const heldUdp = await openUdp("0.0.0.0");
    const spareRtmp = await openTcp("0.0.0.0");
    const spareWebrtcUdp = await openUdp("0.0.0.0");
    const spareWebrtcHttp = await openTcp("127.0.0.1");
    const spareApi = await openTcp("127.0.0.1");
    await Promise.all([spareRtmp.close(), spareWebrtcUdp.close(), spareWebrtcHttp.close(), spareApi.close()]);

    const ports: VideoPorts = {
      rtmp: spareRtmp.port,
      srt: heldUdp.port,
      webrtcUdp: spareWebrtcUdp.port,
      webrtcHttp: spareWebrtcHttp.port,
      hls: heldTcp.port,
      api: spareApi.port,
    };

    // try/finally, not a bare sequence: an assertion throwing above would
    // otherwise skip the close() below and leave heldTcp/heldUdp bound —
    // live handles that keep the process's event loop open and hang the
    // whole test run rather than just failing this one test.
    try {
      const busy = await busyPorts(ports);
      assert.equal(busy.length, 2, `expected exactly the two held ports busy, got ${JSON.stringify(busy)}`);
      const byPort = new Map(busy.map((b) => [b.port, b]));
      assert.equal(byPort.get(heldTcp.port)?.proto, "tcp");
      assert.equal(byPort.get(heldUdp.port)?.proto, "udp");
      for (const entry of busy) {
        assert.equal(typeof entry.holder, "string");
        assert.ok(entry.holder.length > 0, "holder must say something, even a generic fallback");
      }
    } finally {
      await Promise.all([heldTcp.close(), heldUdp.close()]);
    }

    const afterRelease = await busyPorts(ports);
    assert.deepEqual(afterRelease, [], "both released ports must read as free");
  });
});

// item 13 (findings-t15-r2.md): the Video feeds page showed the raw lsof/ss
// listing line wholesale — "node    43580 hstreuber   12u  IPv6
// 0x8c0d35a89313ccc8      0t0  TCP *:51935 (LISTEN)" — rather than "who is
// using this port", which is all an operator needs from that page. Pure and
// deterministic, unlike busyPorts() itself above (which depends on the
// test host's own lsof/ss), so every shape is exercised without needing a
// real process holding a real port in one particular tool's format.
describe("shortenHolder", () => {
  it("reduces an lsof line to the command and pid", () => {
    assert.equal(
      shortenHolder("node    43580 hstreuber   12u  IPv6 0x8c0d35a89313ccc8      0t0  TCP *:51935 (LISTEN)"),
      "node (pid 43580)",
    );
  });

  it("reduces an ss line to the command and pid", () => {
    assert.equal(
      shortenHolder('LISTEN 0 128 *:51935 *:*  users:(("node",pid=43580,fd=12))'),
      "node (pid 43580)",
    );
  });

  // item 12 (findings-t15-r3.md): every caller of shortenHolder() embeds
  // its result in "Port X is in use by <holder>." — describePortHolder()'s
  // own FULL sentence there used to read "...is in use by another Stage
  // Utility is already serving :51935 — version...", naming the port
  // twice and running two sentences together. Reduced to a phrase.
  it("reduces describePortHolder's own 'another Stage Utility' sentence to a phrase, not left whole", () => {
    const sentence =
      "another Stage Utility is already serving :51935 — version 1.24.0, pid 200, data directory /data. " +
      "If that is not the service you expect, find what started it: " +
      "systemctl list-unit-files --state=enabled (Linux) or launchctl list (macOS).";
    assert.equal(shortenHolder(sentence), "another Stage Utility (version 1.24.0, pid 200, data directory /data)");
  });

  it("falls back to the holder text UNCHANGED when neither shape parses", () => {
    assert.equal(shortenHolder("could not determine which process holds it"), "could not determine which process holds it");
  });

  // item 5 (findings-t15-r3.md): an UNPRIVILEGED ss, asked about another
  // user's socket, prints the state and every other column with no
  // "users:(())" at all — nothing names the holder, and this exact shape
  // still matched the lsof regex (a word, then a number) and read
  // "LISTEN (pid 0)", inventing a holder ss never actually reported.
  it("never reads an ss STATE token (LISTEN, UNCONN, ...) as a command", () => {
    assert.equal(
      shortenHolder("LISTEN 0 4096 0.0.0.0:1935 0.0.0.0:*"),
      "LISTEN 0 4096 0.0.0.0:1935 0.0.0.0:*",
      "an unparseable ss line must fall back unchanged, never invent a holder",
    );
  });
});

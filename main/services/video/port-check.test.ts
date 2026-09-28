import assert from "node:assert/strict";
import * as dgram from "node:dgram";
import * as net from "node:net";
import { describe, it } from "node:test";

import type { VideoPorts } from "../../types/video.js";
import { busyPorts } from "./port-check.js";

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

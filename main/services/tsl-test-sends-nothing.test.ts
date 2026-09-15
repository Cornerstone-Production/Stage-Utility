// A "Test connection" button must not change what is on a screen.
//
// tslService.test() used to write buildTsl31Packet(0, "STAGE UTILITY"), which is
// not a probe: it is a UMD write to whatever tile the multiviewer has on display
// address 0, and nothing repaints that tile afterwards unless address 0 happens
// to be one of the configured feeds. rosstalkManager.testTarget has always
// connected and sent nothing, and says why in a comment; this is the second of
// the two and it did the opposite.
//
// The guard drives a real TCP server and asserts ZERO bytes arrived, because
// that is the property that matters — asserting "buildTsl31Packet was not
// called" would pass on any other way of writing to the socket.

import assert from "node:assert/strict";
import { test } from "node:test";
import * as net from "node:net";

import { tslService } from "./tsl-service.js";

test("Test connection reaches the switcher and sends it nothing", async () => {
  const received: Buffer[] = [];
  const server = net.createServer((sock) => {
    sock.on("data", (d) => received.push(d));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;

  try {
    const result = await tslService.test("127.0.0.1", port);
    assert.equal(result.ok, true, "a reachable switcher must test ok");
    // The socket is closed by test(); give the server a tick to see anything
    // that was written before the FIN.
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(
      received,
      [],
      `the test button wrote ${Buffer.concat(received).length} bytes to a live multiviewer`,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

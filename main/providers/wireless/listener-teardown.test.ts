// What a wireless provider's teardown does to the listeners on its socket.
//
// Each of these providers drops the handlers on a socket or request before
// destroying it, because the handler that runs on a destroy is the one that
// schedules a reconnect — tearing down on purpose must not re-dial.
//
// EVERY CASE DRIVES THE REAL PATH: connect() then disconnect(), through the
// provider's own public API, holding the emitter by reference because the
// teardown nulls the field. Nothing here dials real hardware — the host is
// 127.0.0.1 on a port nothing listens on, so the connects are refused and no
// datagram leaves the machine. Transmitting to a receiver, a transmitter or a
// charger is never a test.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as http from "node:http";

import { SennheiserSpectera } from "./sennheiser-spectera.js";

/** A port nothing listens on. The provider must still BUILD its request. */
const DEAD_PORT = 9;
const LOCAL = "127.0.0.1";

describe("aborting the Spectera stream does not take the server down", () => {
  it("leaves something listening for the error a destroyed request emits", async () => {
    // Node's HTTP client manufactures "socket hang up" when a socket closes with
    // a response still outstanding, which is precisely what destroying a
    // half-open SSE request does. abortStream() takes its own 'error' handler
    // off first, and the error arrives asynchronously, so the try/catch around
    // destroy() never sees it. With nothing listening it is an uncaughtException
    // and the process dies — reachable by disabling this integration while it is
    // mid-reconnect.
    //
    // The assertion is that an absorber is attached. The stronger proof is what
    // this FILE does without one: the run ends with "generated asynchronous
    // activity after the test ended ... Error: socket hang up", and fails.
    const p = new SennheiserSpectera();
    await p.connect({ host: LOCAL, port: DEAD_PORT, password: "" });
    const req = (p as unknown as { req: http.ClientRequest | null }).req;
    assert.ok(req, "connect() built no request, so this case proves nothing");

    await p.disconnect();

    assert.equal(
      req.listenerCount("error"),
      1,
      "abortStream() left nothing listening for 'error' on a request it destroyed — " +
        "the socket hang up that follows is an uncaughtException",
    );
    // And the connection really was still in flight, which is what makes the
    // error arrive at all.
    assert.equal(req.destroyed, true, "the request was not destroyed");
    await new Promise((r) => setTimeout(r, 60)); // let the hang-up land
  });
});

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
import type * as net from "node:net";
import type * as dgram from "node:dgram";
import type * as http from "node:http";

import { SennheiserSpectera } from "./sennheiser-spectera.js";
import { SennheiserEwDx } from "./sennheiser-ewdx.js";
import { ShureUlxd } from "./shure-ulxd.js";

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

// ── Named events, not a blanket strip ────────────────────────────────────────
//
// All three teardowns used a bare `removeAllListeners()`, which takes Node's own
// listeners off the emitter as well as the provider's. Measured on the Node this
// repo runs (v26.8), a freshly constructed emitter carries:
//
//   net.Socket          ['end']       Node's own onReadableStreamEnd, which
//                                     half-closes the writable side when the
//                                     peer sends FIN.       shure-base.ts
//   http.ClientRequest  ['response']  the callback passed to request(), ours.
//                                                    sennheiser-spectera.ts
//   dgram.Socket        []            nothing at all.     sennheiser-ssc.ts
//
// So the blanket form was an ACTIVE strip in shure-base and inert in the other
// two. The cases below pin both halves — every listener the provider attached is
// gone, and anything Node put there is not.
//
// The dgram and request cases cannot go red on the blanket-versus-named change
// alone, because on this Node there is nothing of Node's to strip. They guard the
// other failure mode the named form introduces: an event added to open() and not
// to the teardown, which is a handler surviving a deliberate disconnect and
// reconnecting to a device the operator switched off.

describe("a wireless teardown detaches its own listeners and only its own", () => {
  it("Shure keeps the 'end' listener that closes the socket on FIN", async () => {
    const p = new ShureUlxd();
    await p.connect({ host: LOCAL, port: DEAD_PORT, channels: 4 });
    const sock = (p as unknown as { socket: net.Socket | null }).socket;
    assert.ok(sock, "connect() built no socket, so this case proves nothing");

    // Sanity, so a provider that stopped attaching these could not make the
    // assertions below vacuous.
    for (const ev of ["connect", "data", "timeout", "error", "close"]) {
      assert.ok(sock.listenerCount(ev) > 0, `openSocket() never attached '${ev}'`);
    }
    assert.equal(sock.listenerCount("end"), 1, "net.Socket no longer ships its own 'end'");

    await p.disconnect();

    for (const ev of ["connect", "data", "timeout", "error", "close"]) {
      assert.equal(
        sock.listenerCount(ev),
        0,
        `destroySocket() left '${ev}' attached — 'close' calls scheduleReconnect(), ` +
          "so a deliberate disconnect re-dials the device",
      );
    }
    assert.equal(
      sock.listenerCount("end"),
      1,
      "destroySocket() stripped Node's own 'end' listener: the socket no longer " +
        "half-closes when the peer sends FIN, which leaks it",
    );
  });

  it("Sennheiser SSC drops the three handlers its UDP socket carries", async () => {
    const p = new SennheiserEwDx();
    await p.connect({ host: LOCAL, port: DEAD_PORT, channels: 2 });
    const sock = (p as unknown as { socket: dgram.Socket | null }).socket;
    assert.ok(sock, "connect() built no socket, so this case proves nothing");
    await new Promise((r) => setTimeout(r, 40)); // let 'listening' fire

    for (const ev of ["message", "error", "listening"]) {
      assert.ok(sock.listenerCount(ev) > 0, `open() never attached '${ev}'`);
    }

    await p.disconnect();

    assert.deepEqual(
      sock.eventNames().filter((e) => sock.listenerCount(e) > 0),
      [],
      "closeSocket() left a handler attached — it names the events it removes, so " +
        "an event added to open() has to be added there too",
    );
  });

  it("Spectera drops both handlers on the request", async () => {
    const p = new SennheiserSpectera();
    await p.connect({ host: LOCAL, port: DEAD_PORT, password: "" });
    const req = (p as unknown as { req: http.ClientRequest | null }).req;
    assert.ok(req, "connect() built no request, so this case proves nothing");
    assert.ok(req.listenerCount("error") > 0, "openStream() never attached 'error'");
    assert.ok(req.listenerCount("response") > 0, "https.request() never attached 'response'");

    await p.disconnect();

    assert.equal(
      req.listenerCount("response"),
      0,
      "abortStream() left 'response' attached — a response arriving on an abandoned " +
        "request installs data handlers for a stream nobody is reading",
    );
    // 'error' is not zero: abortStream replaces our handler with the absorber the
    // case above is about. Exactly one, and not ours.
    assert.equal(req.listenerCount("error"), 1, "the absorber went missing");
    await new Promise((r) => setTimeout(r, 60)); // let the hang-up land
  });
});

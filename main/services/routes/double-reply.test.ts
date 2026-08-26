// A route replying twice must not take the server down.
//
// context.ts states the rule: a route replies exactly once, before it returns.
// When one does not, res.writeHead() on a finished response throws
// ERR_HTTP_HEADERS_SENT — and thrown from inside an async handler's catch, that
// is an unhandled rejection, which exits the process and blanks every display.
//
// The view importer did exactly this. It replied, then a `finally` awaited
// reloadViews(); a rejection there reached the handler's catch, which called
// error() → json() → writeHead() on a response that had already ended.
//
// Two fixes, and this covers the general one. The importer no longer replies
// before reloading, and json() now refuses a second reply instead of throwing,
// so no OTHER route can kill the server the same way. Losing a second reply is
// the right trade: the first already reached the client.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as http from "node:http";

import { json, error } from "./context.js";

/** Just enough ServerResponse to see whether a second write is attempted. */
function fakeRes(): http.ServerResponse & { writes: number; ended: boolean } {
  const res = {
    writes: 0,
    ended: false,
    headersSent: false,
    writableEnded: false,
    writeHead(_status: number, _headers?: unknown) {
      if (this.headersSent) throw new Error("ERR_HTTP_HEADERS_SENT");
      this.headersSent = true;
      this.writes++;
      return this;
    },
    end(_body?: unknown) {
      this.ended = true;
      this.writableEnded = true;
      return this;
    },
  };
  return res as unknown as http.ServerResponse & { writes: number; ended: boolean };
}

describe("replying twice", () => {
  it("the first reply goes out", () => {
    const res = fakeRes();
    json(res, { ok: true });
    assert.equal(res.writes, 1);
    assert.equal(res.ended, true);
  });

  it("the second is dropped rather than thrown", () => {
    const res = fakeRes();
    json(res, { ok: true });
    // This is the call that used to throw ERR_HTTP_HEADERS_SENT and, from inside
    // an async catch, end the process.
    assert.doesNotThrow(() => json(res, { ok: false }, 500));
    assert.equal(res.writes, 1, "the response must not be written twice");
  });

  it("error() is covered too — it is the path that actually fired", () => {
    // The importer's crash came through error(), not json() directly.
    const res = fakeRes();
    json(res, { ok: true });
    assert.doesNotThrow(() => error(res, "something went wrong"));
    assert.equal(res.writes, 1);
  });

  it("a response that ended without headersSent is still refused", () => {
    // Belt and braces: the guard reads both flags, because a stream can be ended
    // by the dispatcher's 404 arm without this handler having written a header.
    const res = fakeRes();
    (res as unknown as { writableEnded: boolean }).writableEnded = true;
    assert.doesNotThrow(() => json(res, { ok: true }));
    assert.equal(res.writes, 0);
  });
});

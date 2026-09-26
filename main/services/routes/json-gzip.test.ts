// A large JSON reply goes out gzipped when the client accepts it.
//
// History's attendance list was about 1 MB of repetitive numbers, sent plain,
// and on a phone over the building Wi-Fi downloading it was most of the page's
// load. Driven through a real Node server and a real request, because what is
// asserted is what goes over the wire: the header, the bytes, and that a client
// that did not ask gets exactly what it always got.

import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";
import * as http from "node:http";
import * as zlib from "node:zlib";
import type { AddressInfo } from "node:net";

import { json, GZIP_MIN_BYTES } from "./context.js";

const BIG = { rows: Array.from({ length: 2000 }, (_, i) => ({ t: 1_700_000_000_000 + i * 15_000, attendance: i, occupancy: i % 400 })) };
const SMALL = { ok: true };

let server: http.Server;
let port = 0;

before(async () => {
  server = http.createServer((req, res) => json(res, req.url === "/big" ? BIG : SMALL));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
after(() => new Promise<void>((r) => server.close(() => r())));

/** A raw request, so nothing on the client side decompresses behind our back. */
function get(path: string, acceptEncoding?: string): Promise<{ headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, headers: acceptEncoding ? { "accept-encoding": acceptEncoding } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
  });
}

describe("a JSON reply", () => {
  test("is gzipped for a client that accepts it, and decodes to the same value", async () => {
    assert.ok(JSON.stringify(BIG).length > GZIP_MIN_BYTES, "sanity: the fixture is over the threshold");
    const { headers, body } = await get("/big", "gzip, deflate, br");
    assert.equal(headers["content-encoding"], "gzip");
    assert.equal(headers.vary, "Accept-Encoding");
    assert.ok(body.length < JSON.stringify(BIG).length / 4, `compressed to ${body.length} bytes, which is not much`);
    assert.deepEqual(JSON.parse(zlib.gunzipSync(body).toString("utf8")), BIG);
  });

  test("is sent plain to a client that does not ask", async () => {
    const { headers, body } = await get("/big");
    assert.equal(headers["content-encoding"], undefined);
    assert.deepEqual(JSON.parse(body.toString("utf8")), BIG);
  });

  test("is sent plain when it is too small to be worth it", async () => {
    const { headers, body } = await get("/small", "gzip");
    assert.equal(headers["content-encoding"], undefined);
    assert.deepEqual(JSON.parse(body.toString("utf8")), SMALL);
  });
});

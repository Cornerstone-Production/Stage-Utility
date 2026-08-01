// Regression test for the route-dispatch contract.
//
// The dispatcher decides "this request is finished" by checking res.headersSent
// after each domain module. That is only sound if every route finishes responding
// BEFORE it returns.
//
// The ProPresenter thumbnail proxy did not: it fired http.get and returned, letting
// the callback reply later. The dispatcher saw no headers, fell through to the 404
// arm, ended the response — and the late writeHead threw ERR_HTTP_HEADERS_SENT from
// an event callback, which is unhandled and killed the whole server. Every display
// went dark. This pins both halves of the fix.

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import * as http from "node:http";

import { json } from "./context.js";

/** The dispatcher's fall-through loop, exactly as remote-server.ts runs it. */
async function dispatch(
  modules: ((res: http.ServerResponse) => Promise<void>)[],
  res: http.ServerResponse,
): Promise<void> {
  for (const m of modules) {
    await m(res);
    if (res.headersSent) return;
  }
  json(res, { error: "Not found" }, 404); // the 404 arm
}

/** Spin up a one-request server wired to `handler`, and return the status + body. */
async function once(handler: (res: http.ServerResponse) => Promise<void>) {
  const server = http.createServer((_req, res) => void handler(res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`);
    return { status: r.status, body: await r.text() };
  } finally {
    server.close();
  }
}

describe("route dispatch", () => {
  test("a route that responds synchronously stops the chain", async () => {
    const seen: string[] = [];
    const r = await once((res) =>
      dispatch(
        [
          async () => { seen.push("a"); },
          async (res2) => { seen.push("b"); json(res2, { ok: true }); },
          async () => { seen.push("c"); },
        ],
        res,
      ),
    );
    assert.equal(r.status, 200);
    assert.deepEqual(seen, ["a", "b"], "modules after the responder must not run");
  });

  test("a request no module claims falls through to 404", async () => {
    const r = await once((res) => dispatch([async () => {}, async () => {}], res));
    assert.equal(r.status, 404);
  });

  // The bug: a route that returns before replying.
  test("a route that defers its reply gets clobbered by the 404 arm", async () => {
    let lateWriteThrew: string | null = null;

    const r = await once((res) =>
      dispatch(
        [
          async (res2) => {
            // Fire-and-forget: reply "later", exactly like the old thumbnail proxy.
            setTimeout(() => {
              try {
                res2.writeHead(200, { "Content-Type": "text/plain" });
                res2.end("late");
              } catch (e) {
                lateWriteThrew = (e as NodeJS.ErrnoException).code ?? String(e);
              }
            }, 10);
          },
        ],
        res,
      ),
    );

    // The dispatcher answers 404 because nothing was sent yet...
    assert.equal(r.status, 404);
    await new Promise((r2) => setTimeout(r2, 40));
    // ...and the late write then throws. Uncaught, this is what killed the server.
    assert.equal(lateWriteThrew, "ERR_HTTP_HEADERS_SENT",
      "a deferred reply must be impossible — routes have to await before returning");
  });

  // The fix: await, so headersSent is accurate on return.
  test("awaiting the upstream before returning keeps the response correct", async () => {
    const slowUpstream = () => new Promise<string>((r) => setTimeout(() => r("image-bytes"), 10));

    const r = await once((res) =>
      dispatch(
        [
          async (res2) => {
            const body = await slowUpstream();
            res2.writeHead(200, { "Content-Type": "text/plain" });
            res2.end(body);
          },
        ],
        res,
      ),
    );

    assert.equal(r.status, 200);
    assert.equal(r.body, "image-bytes", "the awaited route owns the response, no 404 race");
  });

  test("an awaited route that fails still replies once, not twice", async () => {
    const r = await once((res) =>
      dispatch(
        [
          async (res2) => {
            const result = await Promise.resolve({ error: "upstream down" });
            res2.writeHead(502);
            res2.end(result.error);
          },
        ],
        res,
      ),
    );
    assert.equal(r.status, 502);
    assert.equal(r.body, "upstream down");
  });
});

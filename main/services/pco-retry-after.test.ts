// How long the Planning Center client waits after a 429 or a 5xx: Retry-After in
// either form it may be sent in, else the exponential backoff. The date form was
// ignored (parseInt of a date is NaN), so a PCO that sent one was answered with a
// one-second retry into the same limit.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { pcoService } from "./pco-service.js";

type Internals = {
  pcoFetch: (url: string) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
};
const svc = pcoService as unknown as Internals;
const real = { pcoFetch: svc.pcoFetch, sleep: svc.sleep };

/** Answers 429 with `header` once, then 200; returns the first wait the client took. */
async function firstWait(header: string | null): Promise<number> {
  pcoService.clearCache();
  const waits: number[] = [];
  let calls = 0;
  svc.pcoFetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("{}", { status: 429, headers: header === null ? {} : { "Retry-After": header } })
      : new Response(JSON.stringify({ data: { type: "Person", id: "100000001", attributes: {} } }), { status: 200 });
  };
  svc.sleep = async (ms) => {
    waits.push(ms);
  };
  await pcoService.getPerson("app", "secret", "100000001");
  return waits[0]!;
}

describe("the wait after a rate-limited Planning Center answer", () => {
  beforeEach(() => {
    pcoService.clearCache();
    mock.method(console, "warn", () => {});
  });
  afterEach(() => {
    mock.restoreAll();
    Object.assign(svc, real);
  });

  it("is Retry-After in seconds", async () => {
    assert.equal(await firstWait("3"), 3000);
  });

  it("is Retry-After as an HTTP date", async () => {
    const wait = await firstWait(new Date(Date.now() + 8000).toUTCString());
    assert.ok(wait > 5000 && wait <= 8000, `a date 8 s ahead waited ${wait} ms, not about 8000`);
  });

  it("is never more than 15 seconds, whichever form says so", async () => {
    assert.equal(await firstWait("600"), 15_000);
    assert.equal(await firstWait(new Date(Date.now() + 600_000).toUTCString()), 15_000);
  });

  it("is the exponential backoff with no usable Retry-After, and for 0", async () => {
    for (const header of [null, "0", "soon", " "]) {
      const wait = await firstWait(header);
      assert.ok(wait >= 1000 && wait < 1250, `${JSON.stringify(header)} waited ${wait} ms, not 1000 to 1250`);
    }
  });
});

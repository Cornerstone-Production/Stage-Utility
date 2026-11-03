// api.ts's subscribe report (the direct EventSource and poll transports).
//
// reportChannels debounces by 200 ms, which does nothing when a POST outlasts it
// (a slow Pi): a second report goes out beside the first, the server handles them
// in whatever order they land, and the stale one landing last drops a channel
// added after it. This holds every request, releases the newest first, feeds each
// body into a real ChannelReports, and asserts the filter kept the later channel
// and that no more than one report was ever in flight.

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { ChannelReports } from "../../main/services/channel-reports.js";
import { installDom } from "../test-dom.js";
import { heldFetch } from "../test-held-fetch.js";

const teardown = installDom();
after(() => teardown());

class QuietEventSource {
  static CLOSED = 2;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
(globalThis as { EventSource?: unknown }).EventSource = QuietEventSource;

const held = heldFetch();
(globalThis as { fetch?: unknown }).fetch = held.fetch;

const { onNotification } = await import("./api.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a slow report outlasting the debounce cannot be overtaken by a stale one", async () => {
  const offA = onNotification("automation:rules", () => {});
  await sleep(260); // the debounce fires; report one is now held in flight
  const offB = onNotification("patch:updated", () => {});
  await sleep(260); // a second debounce fires while the first is still out
  assert.equal(held.sent.length, 1, "a second report went out beside the first");

  const reports = new ChannelReports();
  let cid = "";
  while (held.outstanding.length > 0) {
    const req = held.outstanding[held.outstanding.length - 1]!;
    const body = JSON.parse(req.body) as { cid: string; channels: string[] };
    cid = body.cid;
    reports.report(body.cid, body.channels);
    req.respond();
    await held.settle();
  }
  assert.ok(held.maxConcurrent <= 1, `${held.maxConcurrent} subscribe reports were in flight at once`);
  const got = [...(reports.get(cid) ?? [])];
  assert.ok(got.includes("patch:updated"), `the filter lost patch:updated: ${JSON.stringify(got)}`);
  offA();
  offB();
});

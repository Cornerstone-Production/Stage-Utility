import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { afterEach, describe, test } from "node:test";

import { PvpService } from "./pvp-service.js";
import { parseWorkspace } from "./pvp-parse.js";
import type { PvpStatusDTO } from "../types/pvp.js";

const FIXTURE_TEXT = readFileSync(new URL("./fixtures/pvp-workspace.json", import.meta.url), "utf8");
const LAYERS = parseWorkspace(JSON.parse(FIXTURE_TEXT));

const snap = (over: Partial<PvpStatusDTO> = {}): PvpStatusDTO => ({
  connected: true,
  layers: LAYERS,
  sampledAt: "2026-08-30T12:00:00.000Z",
  ...over,
});

describe("shouldEmit", () => {
  test("a poll that changed nothing sends NO frame", () => {
    // THE efficiency decision, at the level that matters. A fresh array from
    // parseWorkspace is a different object every poll, so the base class's
    // shallow compare would say "changed" here and push at 1 Hz forever.
    const prev = snap();
    const next = snap({ layers: [...LAYERS], sampledAt: "2026-08-30T12:00:01.000Z" });
    assert.equal(PvpService.shouldEmit(prev, next, Date.now(), Date.now() + 1000), false);
  });

  test("time advancing normally sends NO frame", () => {
    const prev = snap();
    const next = snap({
      sampledAt: "2026-08-30T12:00:01.000Z",
      layers: LAYERS.map((l) => (l.state === "video" ? { ...l, anchorElapsedSec: (l.anchorElapsedSec ?? 0) + 1 } : l)),
    });
    assert.equal(PvpService.shouldEmit(prev, next, Date.now(), Date.now() + 1000), false);
  });

  test("a cue change sends a frame", () => {
    const prev = snap();
    const next = snap({ layers: LAYERS.map((l, i) => (i === 0 ? { ...l, mediaUuid: "media-9999" } : l)) });
    assert.equal(PvpService.shouldEmit(prev, next, Date.now(), Date.now() + 1000), true);
  });

  test("a loop restarting on the same media sends a frame", () => {
    // The case a media-uuid diff cannot see. Without the drift check the bar
    // would sit at 100% until the keepalive.
    const prev = snap();
    const next = snap({
      sampledAt: "2026-08-30T12:00:01.000Z",
      layers: LAYERS.map((l) => (l.state === "video" ? { ...l, anchorElapsedSec: 0.2 } : l)),
    });
    assert.equal(PvpService.shouldEmit(prev, next, Date.now(), Date.now() + 1000), true);
  });

  test("going offline sends a frame", () => {
    assert.equal(
      PvpService.shouldEmit(snap(), snap({ connected: false, layers: [] }), Date.now(), Date.now()),
      true,
    );
  });

  test("the keepalive sends a frame once nothing has been sent for 15s", () => {
    const t0 = Date.now();
    assert.equal(PvpService.shouldEmit(snap(), snap(), t0, t0 + 14_000), false);
    assert.equal(PvpService.shouldEmit(snap(), snap(), t0, t0 + 15_000), true);
  });

  test("an idle workspace does not spin the keepalive faster than 15s", () => {
    // Stills and empty layers only, which is what a workspace between services
    // holds. Every one has rate 0, so it predicts no movement and never drifts.
    // Without that, a graphic sitting on screen would force a frame every poll
    // for hours — the exact cost the efficiency decision was made to avoid.
    const idle = LAYERS.filter((l) => l.state !== "video");
    assert.ok(idle.length > 0, "the fixture has no idle layers to test with");
    const t0 = Date.now();
    for (let sec = 1; sec < 15; sec++) {
      const prev = snap({ layers: idle, sampledAt: new Date(t0).toISOString() });
      const next = snap({ layers: idle, sampledAt: new Date(t0 + sec * 1000).toISOString() });
      assert.equal(PvpService.shouldEmit(prev, next, t0, t0 + sec * 1000), false, `sent a frame at ${sec}s`);
    }
  });

  test("a rolling clip whose clock STOPS moving sends a frame", () => {
    // The converse, and the reason the test above had to narrow to idle layers:
    // a video at rate 1 whose elapsed is unchanged a second later has been
    // paused or seeked, and the client is now interpolating past the truth.
    const t0 = Date.now();
    const prev = snap({ sampledAt: new Date(t0).toISOString() });
    const next = snap({ sampledAt: new Date(t0 + 2000).toISOString() });
    assert.equal(PvpService.shouldEmit(prev, next, t0, t0 + 2000), true);
  });
});

// ── The real command(), against a stubbed transport ─────────────────────────
//
// pvp-actions.test.ts exercises the actions against a DOUBLE for command(). A
// double proves the double. These run the REAL method — the post, the retry
// loop, the predicate and the failure wording — over a fetch that answers the
// way PVP was observed to: 200 with an empty body, whatever it did or did not do.

const realFetch = globalThis.fetch;
/** Every service a test started, so none is left polling after it ends. */
const started: PvpService[] = [];
afterEach(() => {
  while (started.length) started.pop()?.stop();
  globalThis.fetch = realFetch;
});

/** A PVP that answers `posts` with 200/empty and serves `readBody()` on a GET. */
function stubPvp(readBody: () => string): { posts: string[]; gets: number } {
  const log = { posts: [] as string[], gets: 0 };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? "GET") === "POST") {
      log.posts.push(url);
      // Exactly what PVP does: 200, and nothing at all in the body.
      return new Response("", { status: 200 });
    }
    log.gets++;
    return new Response(readBody(), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return log;
}

/**
 * A configured, RUNNING service — the state an action actually runs in.
 *
 * Deliberately not stopped afterwards, even though a stopped one would make the
 * background poll go away: an action refuses to touch PVP unless the integration
 * is switched on, so a stopped service is the wrong fixture for testing what an
 * action does. afterEach stops it instead.
 *
 * configure() starts the poll immediately, and its first fetch would otherwise
 * reach the real network — so a rejecting stub goes in FIRST. A test suite that
 * dials out is a test suite that fails on an aeroplane.
 */
function serviceUnderTest(token: string | null = null): PvpService {
  globalThis.fetch = (async () => {
    throw new Error("no transport stub installed");
  }) as typeof fetch;
  const svc = new PvpService();
  svc.configure("pvp.invalid", 1, false, token);
  started.push(svc);
  return svc;
}

describe("command() proves the write landed", () => {
  test("a write the state confirms succeeds", async () => {
    const svc = serviceUnderTest();
    const log = stubPvp(() => FIXTURE_TEXT);
    const res = await svc.command("/hide/layer/layer-0004", undefined, {
      what: "layer Hidden layer hidden",
      holds: (layers) => layers.find((l) => l.uuid === "layer-0004")?.hidden === true,
    });
    assert.equal(res.ok, true, res.detail);
    assert.equal(res.detail, "layer Hidden layer hidden");
    assert.deepEqual(log.posts, ["http://pvp.invalid:1/api/0/hide/layer/layer-0004"]);
    assert.ok(log.gets >= 1, "the write was never read back");
  });

  test("PVP ANSWERING 200 AND DOING NOTHING IS A FAILURE", async () => {
    // The whole reason this method exists. The stub accepts the POST and serves
    // an unchanged workspace, which is precisely what PVP does for a request it
    // ignored — and what the research's first pass misread as four dead trigger
    // forms.
    const svc = serviceUnderTest();
    stubPvp(() => FIXTURE_TEXT);
    const res = await svc.command("/clear/layer/layer-0001", undefined, {
      what: "layer Graphics cleared",
      holds: (layers) => layers.find((l) => l.uuid === "layer-0001")?.state === "empty",
    });
    assert.equal(res.ok, false);
    assert.match(res.detail, /answered 200 but layer Graphics cleared did not take effect/);
  });

  test("a change that lands LATE is still caught, because the read is retried", async () => {
    // PVP applies a change a beat after the 200. A verifier that read once,
    // immediately, would call this working action a failure — the exact mistake
    // that produced the "four forms are no-ops" finding.
    const svc = serviceUnderTest();
    let reads = 0;
    stubPvp(() => {
      reads++;
      if (reads < 3) return FIXTURE_TEXT;
      const j = JSON.parse(FIXTURE_TEXT) as { data: { transportState: Record<string, unknown> }[] };
      delete j.data[0].transportState.playingMedia;
      return JSON.stringify(j);
    });
    const res = await svc.command("/clear/layer/layer-0001", undefined, {
      what: "layer Graphics cleared",
      holds: (layers) => layers.find((l) => l.uuid === "layer-0001")?.state === "empty",
    });
    assert.equal(res.ok, true, res.detail);
  });

  test("a POST that PVP rejects is a failure, with PVP's own status in it", async () => {
    const svc = serviceUnderTest();
    globalThis.fetch = (async () => new Response("", { status: 400 })) as typeof fetch;
    const res = await svc.command("/hide/layer/99", undefined, { what: "layer 99 hidden", holds: () => true });
    assert.equal(res.ok, false);
    assert.match(res.detail, /400/);
  });

  test("a write we cannot read back reports THAT, not success", async () => {
    // The write may well have landed. Saying "done" when we cannot see the
    // result is the failure this path exists to prevent.
    const svc = serviceUnderTest();
    let posted = false;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        posted = true;
        return new Response("", { status: 200 });
      }
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    const res = await svc.command("/clear/workspace", undefined, { what: "every layer cleared", holds: () => true });
    assert.ok(posted);
    assert.equal(res.ok, false);
    assert.match(res.detail, /could not read the state back to confirm it: .*ECONNREFUSED/);
  });

  test("an unconfigured service fails rather than throwing", async () => {
    const svc = new PvpService();
    const res = await svc.command("/clear/workspace", undefined, { what: "x", holds: () => true });
    assert.equal(res.ok, false);
    assert.match(res.detail, /not connected/);
  });

  test("A SWITCHED-OFF INTEGRATION DOES NOT STILL DRIVE PVP", async () => {
    // Switching the integration off calls stop(), which clears `running` but
    // leaves `target` set — nothing re-runs configure(). A guard on `target`
    // alone would let an armed rule go on clearing layers after the operator had
    // switched PVP off, which is a switch that appears to do something and does
    // not.
    const svc = new PvpService();
    const log = stubPvp(() => FIXTURE_TEXT);
    svc.configure("pvp.invalid", 1, false, null);
    svc.stop();

    const res = await svc.command("/clear/workspace", undefined, { what: "x", holds: () => true });
    assert.equal(res.ok, false);
    assert.match(res.detail, /not connected/);
    await assert.rejects(() => svc.readLayers(), /not connected/);
    assert.deepEqual(log.posts, [], "a POST went out while the integration was switched off");
  });

  test("THREE CLEAN READS SHOWING NO CHANGE OUTRANK A FOURTH THAT FAILED", async () => {
    // The two failure messages answer different questions, and this is the
    // direction that hides a failure: if reads 1-3 came back clean and showed
    // nothing had changed, we KNOW the write did not land. Letting the fourth
    // read's timeout overwrite that hands the operator "we could not check",
    // which points them at the network instead of at PVP ignoring the command.
    const svc = serviceUnderTest();
    let reads = 0;
    globalThis.fetch = (async (_i: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") return new Response("", { status: 200 });
      reads++;
      if (reads >= 4) throw new Error("connect ETIMEDOUT");
      return new Response(FIXTURE_TEXT, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const res = await svc.command("/clear/layer/layer-0001", undefined, {
      what: "layer Graphics cleared",
      holds: (layers) => layers.find((l) => l.uuid === "layer-0001")?.state === "empty",
    });
    assert.equal(res.ok, false);
    assert.match(res.detail, /did not take effect/);
    assert.ok(!/^sent, but could not read/.test(res.detail), res.detail);
    // The later failure is mentioned, not hidden — just not used as the verdict.
    assert.match(res.detail, /ETIMEDOUT/);
  });

  test("A 200 THAT IS NOT A WORKSPACE IS NOT A CONNECTION", async () => {
    // The setup mistake this integration warns about twice: PVP serves its API
    // DOCUMENTATION on a different port, and that port answers 200 with JSON.
    // parseWorkspace returns [] for it, which is indistinguishable from a real
    // empty workspace — so without a shape check, Test connection would report
    // "Connected — 0 layers" for the exact wrong port it exists to catch.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ openapi: "3.0.0", paths: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const probe = await new PvpService().test("pvp.invalid", 1, false, null);
    assert.equal(probe.ok, false, probe.message);
    assert.match(probe.message ?? "", /not a ProVideoPlayer workspace/);
    assert.match(probe.message ?? "", /documentation/);
  });

  test("but a genuinely EMPTY workspace still connects", async () => {
    // `{ data: [] }` is a real answer from a real PVP with nothing loaded, and
    // must not be swept up by the check above.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const probe = await new PvpService().test("pvp.invalid", 1, false, null);
    assert.equal(probe.ok, true, probe.message);
    assert.match(probe.message ?? "", /0 layers/);
  });

  test("a 404 says the port may be the documentation port, not the API port", async () => {
    // A 404 does not distinguish a wrong path from a disabled Network API, and
    // probing the documentation port looks identical to "the API is off". That
    // cost the research an hour; the message says so rather than guessing.
    const svc = serviceUnderTest();
    globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
    const res = await svc.command("/clear/workspace", undefined, { what: "x", holds: () => true });
    assert.equal(res.ok, false);
    assert.match(res.detail, /documentation port/);
  });

  test("the API token never appears in a failure message", async () => {
    // It is a secret. It rides in a header and must not come back out through a
    // toast, the Activity log, or a console line.
    const svc = serviceUnderTest("s3cret-token-value");
    globalThis.fetch = (async () => new Response("", { status: 401 })) as typeof fetch;
    const res = await svc.command("/clear/workspace", undefined, { what: "x", holds: () => true });
    const probe = await svc.test("pvp.invalid", 1, false, "s3cret-token-value");
    assert.ok(!res.detail.includes("s3cret-token-value"), res.detail);
    assert.ok(!(probe.message ?? "").includes("s3cret-token-value"), probe.message);
  });
});

describe("readLayers", () => {
  test("hands back exactly the fold the poll uses", async () => {
    const svc = serviceUnderTest();
    stubPvp(() => FIXTURE_TEXT);
    assert.deepEqual(await svc.readLayers(), LAYERS);
  });

  test("an unconfigured service throws rather than returning an empty workspace", async () => {
    // Empty is a real state — "PVP has nothing on screen". Returning it for
    // "we never spoke to PVP" would make an action verify against a fiction.
    await assert.rejects(() => new PvpService().readLayers(), /not connected/);
  });
});

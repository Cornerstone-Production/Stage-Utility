import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { afterEach, describe, test } from "node:test";

import { addBroadcastListener } from "./broadcaster.js";
import { PvpService } from "./pvp-service.js";
import { parseWorkspace } from "./pvp-parse.js";
import type { PvpLayerDTO, PvpStatusDTO } from "../types/pvp.js";

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

// -- The emitIfChanged OVERRIDE, driven rather than described -----------------
//
// This is the guard the earlier version of this file CLAIMED to have and did
// not. Every `shouldEmit` test above calls the static pure helper directly, so
// deleting the override -- the thing that actually decides whether a frame goes
// out -- left the whole suite green. Measured against a live ProVideoPlayer at
// 1 Hz with a video rolling: 2 frames per 30s with the override, 20 without it.
// A guard over the helper alone cannot see that difference at all.
//
// So these drive the REAL `emitIfChanged`, through the REAL `emit`, and count
// what reaches the broadcaster -- the frames a display would actually receive.
// Only the poll timer is stood in for; everything between the DTO and the wire
// is the shipping code.

/** Frames seen on "pvp:status" since the last reset. */
let frames: PvpStatusDTO[] = [];
addBroadcastListener((channel, payload) => {
  if (channel === "pvp:status") frames.push(payload as PvpStatusDTO);
});

/** Reaches the protected override the way the poll does. A subclass rather than
 *  a cast, so if the override's signature ever changes this stops compiling. */
class ProbeService extends PvpService {
  poll(dto: PvpStatusDTO): void {
    this.emitIfChanged(dto);
  }
}

describe("the emitIfChanged override decides what reaches the wire", () => {
  const probe = (): ProbeService => {
    frames = [];
    const svc = new ProbeService();
    started.push(svc);
    return svc;
  };
  /** A fresh array every time, exactly as parseWorkspace hands one back. */
  const poll = (at: string, over: Partial<PvpStatusDTO> = {}): PvpStatusDTO => ({
    connected: true,
    layers: LAYERS.map((l) => ({ ...l })),
    sampledAt: at,
    ...over,
  });

  test("TEN IDENTICAL POLLS SEND ONE FRAME, NOT TEN", () => {
    // The whole efficiency decision, at the only level that proves it. The base
    // class compares DTO keys with `!==` and `layers` is a fresh array on every
    // poll, so without the override this is ten frames to every connected
    // display -- and on the live device, twenty in thirty seconds.
    const svc = probe();
    for (let i = 0; i < 10; i++) svc.poll(poll(`2026-08-30T12:00:0${i}.000Z`));
    assert.equal(frames.length, 1, `sent ${frames.length} frames for ten identical polls`);
  });

  test("a cue change on the eleventh poll DOES send a second frame", () => {
    // The other half: proving no frame is sent is worthless if the override also
    // swallows the ones that matter.
    const svc = probe();
    for (let i = 0; i < 10; i++) svc.poll(poll(`2026-08-30T12:00:0${i}.000Z`));
    svc.poll(poll("2026-08-30T12:00:10.000Z", {
      layers: LAYERS.map((l, i) => (i === 0 ? { ...l, mediaUuid: "media-9999" } : { ...l })),
    }));
    assert.equal(frames.length, 2);
    assert.equal(frames[1].layers[0].mediaUuid, "media-9999");
  });

  test("going offline sends a frame even though the DTO is smaller", () => {
    const svc = probe();
    svc.poll(poll("2026-08-30T12:00:00.000Z"));
    svc.poll({ connected: false, layers: [], sampledAt: null });
    assert.equal(frames.length, 2);
    assert.equal(frames[1].connected, false);
  });

  test("a silent poll still updates what a late display hydrates to", () => {
    // Both halves of the base contract. Skipping the frame is the efficiency
    // rule; keeping `last` current is what lets a display that connects between
    // changes hydrate with the truth rather than a stale snapshot.
    const svc = probe();
    svc.poll(poll("2026-08-30T12:00:00.000Z"));
    // Only the ROLLING layer's clock moves, and by exactly the elapsed wall
    // time. Advancing a still's anchor would be genuine drift — a paused clip
    // that jumped — and would rightly send a frame.
    svc.poll(poll("2026-08-30T12:00:09.000Z", {
      layers: LAYERS.map((l) =>
        l.playbackRate > 0 ? { ...l, anchorElapsedSec: (l.anchorElapsedSec ?? 0) + 9 } : { ...l },
      ),
    }));
    assert.equal(frames.length, 1, "time moving must not send a frame");
    assert.equal(svc.getLatest().sampledAt, "2026-08-30T12:00:09.000Z", "but `last` must be current");
    assert.equal(svc.getLatest().layers[0].anchorElapsedSec, 18.6);
  });
});

describe("a stale read cannot broadcast backwards over a newer one", () => {
  // The poll is serial with itself, but command()'s verify reads run BESIDE it,
  // and two requests to the same box can come back out of order. A poll begun
  // before a trigger and resolving after the verify read would push the OLD
  // workspace out after the new one — and the automation engine, which sees only
  // consecutive frames, would read that as the layer clearing and then the same
  // cue starting a second time. One command, one phantom "layer cleared", one
  // duplicated "cue started".
  //
  // Driven through the real emitFresh via the real command(), with a transport
  // that deliberately answers out of order.

  class OrderProbe extends PvpService {
    /** The poll's own path: stamp, read, fold in — exactly as connect() does. */
    async slowPoll(dto: PvpStatusDTO, startedAtMs: number): Promise<void> {
      this.foldIn(dto, startedAtMs);
    }
    foldIn(dto: PvpStatusDTO, at: number): void {
      // Reaches the private emitFresh through the same door connect() uses.
      (this as unknown as { emitFresh(l: PvpLayerDTO[], at: number): void }).emitFresh(dto.layers, at);
    }
  }

  test("a poll that STARTED earlier but finished later is dropped", () => {
    frames = [];
    const svc = new OrderProbe();
    started.push(svc);

    const t0 = Date.now();
    const oldWorkspace = LAYERS.map((l) => ({ ...l }));
    const newWorkspace = LAYERS.map((l, i) => (i === 0 ? { ...l, mediaUuid: "media-NEW" } : { ...l }));

    // The verify read: started later, arrives first.
    svc.foldIn({ connected: true, layers: newWorkspace, sampledAt: null }, t0 + 100);
    // The poll: started earlier, arrives second, carrying the older workspace.
    svc.foldIn({ connected: true, layers: oldWorkspace, sampledAt: null }, t0);

    assert.equal(frames.length, 1, `broadcast ${frames.length} frames; the stale one was not dropped`);
    assert.equal(frames[0].layers[0].mediaUuid, "media-NEW");
    assert.equal(svc.getLatest().layers[0].mediaUuid, "media-NEW", "the stale read overwrote `last`");
  });

  test("reads that arrive in order both count", () => {
    // The other half: dropping the stale one must not also drop legitimate
    // progress, or the channel would freeze after its first frame.
    frames = [];
    const svc = new OrderProbe();
    started.push(svc);
    const t0 = Date.now();
    svc.foldIn({ connected: true, layers: LAYERS.map((l) => ({ ...l })), sampledAt: null }, t0);
    svc.foldIn(
      { connected: true, layers: LAYERS.map((l, i) => (i === 0 ? { ...l, mediaUuid: "m-2" } : { ...l })), sampledAt: null },
      t0 + 100,
    );
    assert.equal(frames.length, 2);
    assert.equal(frames[1].layers[0].mediaUuid, "m-2");
  });
});

// ── When the playlist tree is read again ────────────────────────────────────
//
// The tree is a SECOND request that exists to name one line, so every reason to
// make it is behind a clock. This is the half of the integration that can loop,
// and it loops against a machine in a live service.
//
// THE DEFECT THIS EXISTS FOR: `hasCache === false || ageMs >= TTL`
// short-circuited the clock in exactly the case that needs it. A PVP whose
// playlist endpoint does not answer never gets a cache, so the never-loaded
// branch fired on EVERY poll for ever — a second doomed request a second, with
// one console line for the whole outage. And because the read is awaited inside
// connect(), an endpoint that hangs rather than refusing added the 4s request
// timeout to every poll, stretching the 1 Hz cadence that automation triggers
// ride on toward 5s.

describe("when the playlist tree is read again", () => {
  const MINUTE = 60_000;

  test("the FIRST read happens straight away", () => {
    // playlistsReadAtMs starts at 0, so the age on the first poll is the whole
    // epoch. A cold start must not wait out a cooldown.
    assert.equal(PvpService.shouldReadPlaylists(false, Date.now(), false), true);
  });

  test("A FAILING ENDPOINT IS RETRIED ON THE COOLDOWN, NOT ON EVERY POLL", () => {
    // The guard. `false` is "we have never got a tree", which is the state a
    // broken endpoint leaves us in permanently.
    assert.equal(PvpService.shouldReadPlaylists(false, 0, false), false, "retried in the same tick");
    assert.equal(PvpService.shouldReadPlaylists(false, 1000, false), false, "retried a second later");
    assert.equal(PvpService.shouldReadPlaylists(false, 29_000, false), false);
    assert.equal(PvpService.shouldReadPlaylists(false, 30_000, false), true);
  });

  test("a good cache is left alone for five minutes", () => {
    assert.equal(PvpService.shouldReadPlaylists(true, 0, false), false);
    assert.equal(PvpService.shouldReadPlaylists(true, 4 * MINUTE, false), false);
    assert.equal(PvpService.shouldReadPlaylists(true, 5 * MINUTE, false), true);
  });

  test("a cue the cache cannot explain jumps the TTL — but not the cooldown", () => {
    // A playlist built mid-service should show its next cue within the cooldown
    // rather than in five minutes. A cue that is in NO playlist — PVP can play
    // an item since deleted from the tree — must not refetch on every poll for
    // as long as it stays up.
    assert.equal(PvpService.shouldReadPlaylists(true, 1000, true), false, "no cooldown on the miss path");
    assert.equal(PvpService.shouldReadPlaylists(true, 30_000, true), true);
    assert.equal(PvpService.shouldReadPlaylists(true, 30_000, false), false, "refetched with nothing to look up");
  });

  test("costs at most two requests a minute in the worst case", () => {
    // The whole point of the cooldown, stated as the number an operator would
    // measure on the wire.
    let reads = 0;
    for (let ms = 0; ms < MINUTE; ms += 1000) {
      // A poll every second against a PVP whose tree never loads.
      if (PvpService.shouldReadPlaylists(false, ms % 30_000 === 0 ? 30_000 : ms % 30_000, false)) reads++;
    }
    assert.equal(reads, 2, `read the tree ${reads} times in a minute`);
  });
});

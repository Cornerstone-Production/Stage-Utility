import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Before any store is constructed: every import below builds its stores
// against this directory, never the default data folder.
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-service-"));
process.env.STAGE_UTILITY_DATA = TMP;
const { videoService, SECRET_SLOT, STATUS_POLL_MS, PENDING_MARK_TTL_MS, RELAY_BOOT_GRACE_MS, videoPollDeps } = await import(
  "./video-service.js"
);
const { secretsStore } = await import("../secrets.js");
const { configSnapshot } = await import("../config-snapshot.js");
const { videoSeenStore, SEEN_WRITE_INTERVAL_MS } = await import("./seen-store.js");
const { DEFAULT_SETTLE_MS } = await import("../repeat-log.js");
const { RelaySupervisor } = await import("./supervisor.js");
const { serverPort } = await import("../server-port.js");
const { DEFAULT_VIDEO_PORTS } = await import("../../types/video.js");
type RelayPath = import("./relay.js").RelayPath;
type RelayFeed = import("./relay.js").RelayFeed;
type VideoRelay = import("./relay.js").VideoRelay;
type SupervisorStatus = import("./supervisor.js").SupervisorStatus;
type VideoPorts = import("../../types/video.js").VideoPorts;
type RelaySupervisorLike = import("./video-service.js").RelaySupervisorLike;

/**
 * attachRelay() with ports defaulted to DEFAULT_VIDEO_PORTS. Ports are
 * REQUIRED in production (R13a: a caller that does not know what it
 * started the relay on has no business attaching one — see
 * video-service.ts's own attachedPorts comment); almost every test below
 * does not care what the number is, only that some ports are pinned, so
 * this is the one place that default lives, not a parameter default on the
 * production method itself.
 */
const attach = (relay: VideoRelay, supervisor: RelaySupervisorLike, ports: VideoPorts = DEFAULT_VIDEO_PORTS) =>
  videoService.attachRelay(relay, supervisor, ports);

// Every test here shares the one videoService, and so its OutageLog: an outage
// one test leaves open would swallow, as a repeat of the same failure, the
// line a later test expects to see first. Each test starts with none open.
beforeEach(() => (videoService as unknown as { pollOutage: { forget(): void } }).pollOutage.forget());

test("a config snapshot never carries a feed's password", async () => {
  const password = "correct-horse-battery-staple";
  const made = await videoService.addFeed({ name: "Lobby cam", source: { kind: "pull", url: "rtsp://192.0.2.10:8554/s", username: "admin" }, password });
  assert.ok(made.ok, "expected the pull feed to be added");
  const id = (made as { feed: { id: string } }).feed.id;
  assert.equal((await secretsStore.getSecrets(SECRET_SLOT(id))).password, password, "the seed never reached the secrets store");

  const snapshot = await configSnapshot.build();
  const serialized = JSON.stringify(snapshot);
  assert.ok(serialized.includes(`"${id}"`), "the snapshot must carry the feed itself, or this proves nothing");
  assert.equal(serialized.includes(password), false, "a feed password reached a config snapshot");
});


test("parallel adds of one name get distinct ids", async () => {
  const body = { name: "Stage cam", source: { kind: "external", url: "http://192.0.2.20/cam/whep" } };
  const results = await Promise.all([videoService.addFeed(body), videoService.addFeed(body), videoService.addFeed(body)]);
  const ids = results.map((r) => (r as { ok: true; feed: { id: string } }).feed.id).sort();
  assert.deepEqual(ids, ["stage-cam", "stage-cam-2", "stage-cam-3"]);
  const stored = (await videoService.state()).feeds.filter((f) => f.name === "Stage cam").map((f) => f.id).sort();
  assert.deepEqual(stored, ids, "the store must hold each feed once, under the id its add returned");
});

test("an add whose password cannot be saved takes the feed back out and rejects", async () => {
  const store = secretsStore as unknown as { setSecret: (...a: unknown[]) => Promise<void> };
  store.setSecret = async () => {
    throw new Error("disk full");
  };
  try {
    await assert.rejects(
      videoService.addFeed({ name: "Balcony cam", source: { kind: "pull", url: "rtsp://192.0.2.30/s", username: "" }, password: "pw" }),
      /disk full/,
    );
  } finally {
    delete (store as { setSecret?: unknown }).setSecret;
  }
  const names = (await videoService.state()).feeds.map((f) => f.name);
  assert.equal(names.includes("Balcony cam"), false, "a feed was left in the store with no password behind it");
});

test("removeFeed refuses an id outside FEED_ID_PATTERN, even for a feed stored under one", async () => {
  // feedIdFor() never mints this shape (uppercase, an underscore) — the only
  // way a feed gets an id like this is a hand-edited or restored file, the
  // same case updateFeed already refuses. Written straight through the
  // store, not addFeed, so the id is exactly this and nothing feedIdFor()
  // would have chosen instead.
  const { videoFeedsStore } = await import("./feed-store.js");
  const badId = "Bad_ID";
  await videoFeedsStore.update((current) => ({
    ...current,
    feeds: [...(Array.isArray(current.feeds) ? current.feeds : []), { id: badId, name: "Corrupt", source: { kind: "external", url: "http://192.0.2.90/cam/whep" } }],
  }));
  assert.equal(await videoService.removeFeed(badId), false, "a pattern-failing id must be refused before the store is even asked");
  const names = (await videoService.state()).feeds.map((f) => f.id);
  assert.ok(names.includes(badId), "the malformed feed must still be there — refused, not silently dropped");
});

// ── The status poll, attach/detach, and the transition log lines ──────────
//
// Most of these tests use a fake relay and a fake supervisor. A few, marked
// where they appear, start a REAL RelaySupervisor against a fake child
// process instead, to exercise its actual timers and event ordering
// alongside the service's own polling. What is covered: the demand gate,
// the dedupe on publish(), the live/delayed/offline transition log lines,
// the B-frames mark (bound immediately when the path is already ready, or
// left pending until a later poll sees it ready), markRequested()'s effect,
// relayStatus()'s mapping from the supervisor's own status
// (including its "starting" window and the "not answering" verdict's scope
// to a single process), a failing poll's behaviour, the seen store's
// write-failure handling, and the guard against a stale in-flight poll.

class FakeSupervisor extends EventEmitter {
  // "running" by default — the service never polls while the supervisor
  // reports "off" (see pollOnce()'s own guard), so every test that expects
  // pollOnce() to actually call relay.status() would otherwise need its own
  // explicit override. The handful of tests ABOUT off/starting/failing set
  // their own.
  current: SupervisorStatus = { state: "running", since: 1 };
  ver: string | null = null;
  status(): SupervisorStatus {
    return this.current;
  }
  version(): string | null {
    return this.ver;
  }
}

/** A fake child process for the tests that drive a REAL RelaySupervisor —
 *  structurally satisfies SupervisedChild (an EventEmitter with
 *  pid/stdout/stderr/kill) with no cast, the same way supervisor.test.ts's
 *  own fixture does. */
class FakeChild extends EventEmitter {
  pid = 424242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill(): boolean {
    setImmediate(() => this.emit("exit", 0));
    return true;
  }
}

function fakeRelay(status: () => Promise<RelayPath[]>): VideoRelay {
  return {
    reconcile: async () => {},
    status,
    playback: (feedId: string) => ({ whep: `/video/${feedId}/whep`, hls: `/video/${feedId}/index.m3u8` }),
    kickPublisher: async () => {},
  };
}

const readyPath = (overrides: Partial<RelayPath> = {}): RelayPath => ({
  name: "cam",
  ready: true,
  readyTime: "2026-09-28T00:00:00Z",
  source: { type: "rtspSource", id: "s1" },
  video: { codec: "H264", width: 1920, height: 1080, profile: "High" },
  readers: 1,
  ...overrides,
});

const notReadyPath = (overrides: Partial<RelayPath> = {}): RelayPath => ({
  name: "cam",
  ready: false,
  readyTime: null,
  source: null,
  video: null,
  readers: 0,
  ...overrides,
});

/** Calls the service's private pollOnce() directly and awaits it, rather than
 *  going through the injected timer and guessing how long its fire-and-forget
 *  call takes to settle — deterministic for every test but the ones that
 *  actually assert on the timer wiring or the in-flight guard itself. */
const pollOnce = () => (videoService as unknown as { pollOnce(): Promise<void> }).pollOnce();

/** Restores videoPollDeps to whatever it was before a test overrides it. */
const restorePollDeps = (saved: typeof videoPollDeps) => Object.assign(videoPollDeps, saved);

// Module-level, like cue-live.test.ts's own `tick` — a `let` reassigned only
// from inside videoPollDeps.setInterval's callback below, and read only from
// callTick(), a SEPARATE top-level function. Both bodies deliberately live
// outside the test itself: TypeScript's flow analysis does not treat a
// closure's assignment as reachable evidence for a read in the SAME function
// body unless it can see the call, and a String()-wrapped comparison earlier
// in that same body is enough to pin the read's type to `null` — `tick?.()`
// then reports "Type 'never' has no call signatures". Reading it from a
// distinct function sidesteps the narrowing instead of fighting it.
let tick: (() => void) | null = null;
const callTick = () => tick?.();

// Same reasoning, same fix, for the deferred-resolve tests below: a
// `let` reassigned only inside a closure nested two levels deep (a fake
// relay's own status() implementation) is never narrowed away from its
// initializer's type at a read site in a THIRD, unrelated function, so
// `resolveA?.(...)` there reports "Type 'never' has no call signatures" with
// no assert involved at all — reading it from its own top-level function
// sidesteps the narrowing instead of fighting it.
let resolveA: ((paths: RelayPath[]) => void) | null = null;
const callResolveA = (paths: RelayPath[]) => resolveA?.(paths);
// Same again, for a stale request that rejects instead of resolving.
let rejectA: ((err: Error) => void) | null = null;
const callRejectA = (err: Error) => rejectA?.(err);

test("nothing polls until something is watching; the timer starts, reads immediately, and stops when demand drops", async () => {
  let calls = 0;
  const relay = fakeRelay(async () => {
    calls++;
    return [];
  });
  const supervisor = new FakeSupervisor();
  tick = null;
  let everyMs = 0;
  let cleared = 0;
  const real = { ...videoPollDeps };
  videoPollDeps.inDemand = () => false;
  videoPollDeps.setInterval = (fn, ms) => {
    tick = fn;
    everyMs = ms;
    return {} as NodeJS.Timeout;
  };
  videoPollDeps.clearInterval = () => {
    cleared++;
    tick = null;
  };

  try {
    attach(relay, supervisor);
    assert.equal(calls, 0, "attaching with nobody watching must not poll");
    assert.equal(String(tick === null), "true", "and must not arm a timer");

    videoPollDeps.inDemand = () => true;
    videoService.subscriptionsChanged();
    assert.equal(everyMs, STATUS_POLL_MS, "the timer must run at STATUS_POLL_MS");
    assert.equal(String(tick === null), "false", "the interval was never armed");
    await new Promise((r) => setTimeout(r, 30)); // let the immediate first read settle
    assert.equal(calls, 1, "the first read must go out at once, not after a full interval");

    callTick();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, 2, "the scheduled tick must read again");

    videoPollDeps.inDemand = () => false;
    videoService.subscriptionsChanged();
    assert.equal(cleared, 1, "the last watcher leaving must clear the timer");
    assert.equal(String(tick === null), "true");
  } finally {
    await videoService.detachRelay();
    restorePollDeps(real);
  }
});

test("a poll broadcasts only when the relay's answer actually changes the snapshot", async () => {
  const made = await videoService.addFeed({ name: "Atrium cam", source: { kind: "pull", url: "rtsp://192.0.2.50/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const { addBroadcastListener } = await import("../broadcaster.js");
  const frames: number[] = [];
  addBroadcastListener((channel, payload) => {
    if (channel !== "video:state") return;
    frames.push((payload as { rev: number }).rev);
  });

  let answer: RelayPath[] = [readyPath({ name: id })];
  const relay = fakeRelay(async () => answer);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  try {
    const before = frames.length;
    await pollOnce();
    assert.equal(frames.length, before + 1, "the feed going live must publish once");

    await pollOnce(); // identical answer
    assert.equal(frames.length, before + 1, "an unchanged answer must not publish again");

    answer = [notReadyPath({ name: id })];
    await pollOnce();
    assert.equal(frames.length, before + 2, "a real change must publish again");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("logs a feed's live/offline transitions on the poll, once each — never on every poll", async () => {
  const made = await videoService.addFeed({ name: "Narthex cam", source: { kind: "push", protocol: "rtmp" }, password: "pw" });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  let answer: RelayPath[] = [readyPath({ name: id })];
  const relay = fakeRelay(async () => answer);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));

  try {
    await pollOnce();
    await pollOnce(); // still live — must not repeat the line
    answer = [notReadyPath({ name: id })];
    await pollOnce();
    await pollOnce(); // still offline — must not repeat the line

    assert.deepEqual(
      lines.filter((l) => l.includes("Narthex cam")),
      ["[video] Narthex cam is live (1920×1080 H264)", "[video] Narthex cam went offline"],
    );
  } finally {
    console.log = realLog;
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("logs a feed's entry into delayed too, and never prints an unknown picture", async () => {
  // push, not pull: a not-ready pull feed nobody has requested reads
  // "standby" (a quieter, different fact — see feed-state.ts), and this test
  // is about the "went offline" / "is live" pair either side of "delayed".
  const made = await videoService.addFeed({ name: "Undercroft cam", source: { kind: "push", protocol: "rtmp" }, password: "pw" });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  // H265 is "delayed" the moment it is seen ready — no B-frames mark needed.
  let answer: RelayPath[] = [readyPath({ name: id, video: { codec: "H265" } })];
  const relay = fakeRelay(async () => answer);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));

  try {
    await pollOnce();
    await pollOnce(); // still delayed — must not repeat

    assert.deepEqual(
      lines.filter((l) => l.includes("Undercroft cam")),
      ["[video] Undercroft cam is delayed (H265) — an unsupported codec"],
    );

    // A ready path reporting NO video track at all must never print
    // "undefined×undefined undefined" — the whole parenthetical is omitted.
    lines.length = 0;
    answer = [notReadyPath({ name: id })];
    await pollOnce(); // offline first, so the next ready poll is a transition
    answer = [readyPath({ name: id, video: null })];
    await pollOnce();
    assert.deepEqual(
      lines.filter((l) => l.includes("Undercroft cam")),
      ["[video] Undercroft cam went offline", "[video] Undercroft cam is live"],
    );
  } finally {
    console.log = realLog;
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a B-frames close on an ALREADY-ready feed marks it delayed, and logs once per session", async () => {
  const made = await videoService.addFeed({ name: "Choir cam", source: { kind: "pull", url: "rtsp://192.0.2.51/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  const readyTime = "2026-09-28T01:00:00Z";
  const relay = fakeRelay(async () => [readyPath({ name: id, readyTime })]);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));

  try {
    await pollOnce(); // populates lastPaths with a READY path — the immediate-bind branch

    supervisor.emit("line", `[WebRTC] [session abcd1234] is reading from path '${id}'`);
    supervisor.emit("line", `[WebRTC] [session abcd1234] closed: WebRTC doesn't support H264 streams with B-frames`);
    await new Promise((r) => setTimeout(r, 20)); // markBFrames() has one async hop, for the feed's name

    const feed = (await videoService.state()).feeds.find((f) => f.id === id);
    assert.deepEqual(
      { state: feed?.status.state, why: feed?.status.delayedBecause },
      { state: "delayed", why: "b-frames" },
    );
    assert.deepEqual(
      lines.filter((l) => l.includes("B-frames")),
      ["[video] Choir cam sends B-frames, so screens play it over HLS, 2 to 6 s behind. Turn B-frames off on the device for under a second."],
    );

    // A second session closing against the SAME still-open readyTime is the
    // same fact restated, not news.
    supervisor.emit("line", `[WebRTC] [session ef567890] is reading from path '${id}'`);
    supervisor.emit("line", `[WebRTC] [session ef567890] closed: WebRTC doesn't support H264 streams with B-frames`);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(lines.filter((l) => l.includes("B-frames")).length, 1, "the line must not repeat for the same session");
  } finally {
    console.log = realLog;
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("binding an ALREADY-ready B-frames mark publishes immediately, not waiting for the next poll", async () => {
  const made = await videoService.addFeed({ name: "Instant cam", source: { kind: "pull", url: "rtsp://192.0.2.66/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  const readyTime = "T-instant";

  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(fakeRelay(async () => [readyPath({ name: id, readyTime })]), supervisor);

  const { addBroadcastListener } = await import("../broadcaster.js");
  const frames: { feeds: { id: string; status: { state: string } }[] }[] = [];
  addBroadcastListener((channel, payload) => {
    if (channel === "video:state") frames.push(payload as { feeds: { id: string; status: { state: string } }[] });
  });

  try {
    await pollOnce(); // the path is already ready and known — "live" published once

    const before = frames.length;
    supervisor.emit("line", `[WebRTC] [session 11aa22bb] is reading from path '${id}'`);
    supervisor.emit("line", `[WebRTC] [session 11aa22bb] closed: WebRTC doesn't support H264 streams with B-frames`);
    await new Promise((r) => setTimeout(r, 20)); // no pollOnce() call in between

    assert.ok(frames.length > before, "binding an already-ready mark must publish on its own, not wait for the next poll");
    const feed = frames.at(-1)?.feeds.find((f) => f.id === id);
    assert.equal(feed?.status.state, "delayed");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a B-frames close on an on-demand pull feed that is not yet ready binds on the next poll that sees it ready", async () => {
  const made = await videoService.addFeed({ name: "Annex cam", source: { kind: "pull", url: "rtsp://192.0.2.61/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  const readyTime = "2026-09-28T02:00:00Z";

  let answer: RelayPath[] = [notReadyPath({ name: id })];
  const relay = fakeRelay(async () => answer);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));

  try {
    await pollOnce(); // sees the not-ready path first

    supervisor.emit("line", `[WebRTC] [session bbbb2222] is reading from path '${id}'`);
    supervisor.emit("line", `[WebRTC] [session bbbb2222] closed: WebRTC doesn't support H264 streams with B-frames`);
    await new Promise((r) => setTimeout(r, 20)); // the mark is pending; there is no readyTime to bind to yet

    let feed = (await videoService.state()).feeds.find((f) => f.id === id);
    assert.notEqual(feed?.status.state, "delayed", "there is nothing to bind the mark to yet");
    assert.equal(lines.length, 0, "nothing is announced until the mark is bound to a real readyTime");

    answer = [readyPath({ name: id, readyTime })];
    await pollOnce(); // the first poll that sees the path ready — binds and announces

    feed = (await videoService.state()).feeds.find((f) => f.id === id);
    assert.deepEqual(
      { state: feed?.status.state, why: feed?.status.delayedBecause },
      { state: "delayed", why: "b-frames" },
    );
    assert.deepEqual(
      lines.filter((l) => l.includes("B-frames")),
      ["[video] Annex cam sends B-frames, so screens play it over HLS, 2 to 6 s behind. Turn B-frames off on the device for under a second."],
    );

    // A later new WebRTC attempt on the SAME still-open readyTime is not news.
    supervisor.emit("line", `[WebRTC] [session cccc3333] is reading from path '${id}'`);
    supervisor.emit("line", `[WebRTC] [session cccc3333] closed: WebRTC doesn't support H264 streams with B-frames`);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(lines.filter((l) => l.includes("B-frames")).length, 1);
  } finally {
    console.log = realLog;
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a pending B-frames mark does not survive a detach — it cannot bind to a later, unrelated session", async () => {
  const made = await videoService.addFeed({ name: "Pending cam", source: { kind: "pull", url: "rtsp://192.0.2.63/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(fakeRelay(async () => [notReadyPath({ name: id })]), supervisor);

  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));

  try {
    await pollOnce();
    supervisor.emit("line", `[WebRTC] [session dd44ee55] is reading from path '${id}'`);
    supervisor.emit("line", `[WebRTC] [session dd44ee55] closed: WebRTC doesn't support H264 streams with B-frames`);
    await new Promise((r) => setTimeout(r, 30));
    await pollOnce(); // still not ready — the on-demand source closed again, the mark is still pending

    await videoService.detachRelay(); // relay turned off / reconfigured

    // Hours later: a different relay, the device now reconfigured with B-frames off.
    attach(fakeRelay(async () => [readyPath({ name: id, readyTime: "T9" })]), new FakeSupervisor());
    await pollOnce();

    const feed = videoService.current().feeds.find((f) => f.id === id);
    assert.notEqual(feed?.status.state, "delayed", "an old pending mark must never bind to a session it never saw");
    assert.equal(lines.filter((l) => l.includes("B-frames")).length, 0, "no announcement belongs to the new session either");
  } finally {
    console.log = realLog;
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a pending B-frames mark expires after PENDING_MARK_TTL_MS without a ready poll", async (t) => {
  const made = await videoService.addFeed({ name: "Timeout cam", source: { kind: "pull", url: "rtsp://192.0.2.64/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  let answer: RelayPath[] = [notReadyPath({ name: id })];
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(fakeRelay(async () => answer), supervisor);

  t.mock.timers.enable({ apis: ["Date"], now: 0 });

  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));

  try {
    await pollOnce();
    supervisor.emit("line", `[WebRTC] [session ff11aa22] is reading from path '${id}'`);
    supervisor.emit("line", `[WebRTC] [session ff11aa22] closed: WebRTC doesn't support H264 streams with B-frames`);
    await new Promise((r) => setTimeout(r, 30));

    t.mock.timers.tick(PENDING_MARK_TTL_MS + 1000); // well past 30 s, with no ready poll in between
    await pollOnce(); // still not ready — this poll is what sweeps the expiry

    answer = [readyPath({ name: id, readyTime: "T9" })];
    await pollOnce(); // NOW it becomes ready — the expired mark must not bind

    const feed = videoService.current().feeds.find((f) => f.id === id);
    assert.notEqual(feed?.status.state, "delayed", "an expired pending mark must not bind once the feed eventually becomes ready");
    assert.equal(lines.filter((l) => l.includes("B-frames")).length, 0);
  } finally {
    console.log = realLog;
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a B-frames line for a path that is not a real feed is never logged, and never becomes a mark", async () => {
  // A relay path can outlive the feed it belonged to (reconcile() has not
  // yet dropped it), so "orphaned-path" is reported READY by the relay even
  // though no feed of that id exists in the store — the realistic shape of
  // the bug, not merely an id nobody's poll has ever touched.
  const relay = fakeRelay(async () => [readyPath({ name: "orphaned-path" })]);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));

  try {
    await pollOnce(); // lastPaths now reports 'orphaned-path' ready

    supervisor.emit("line", `[WebRTC] [session aaaa1111] is reading from path 'orphaned-path'`);
    supervisor.emit("line", `[WebRTC] [session aaaa1111] closed: WebRTC doesn't support H264 streams with B-frames`);
    await new Promise((r) => setTimeout(r, 20));

    assert.deepEqual(
      lines.filter((l) => l.includes("B-frames") || l.includes("orphaned-path")),
      [],
      "an id outside the feed list must never reach a log line, raw or scrubbed",
    );
  } finally {
    console.log = realLog;
    await videoService.detachRelay();
  }
});

test("a relay that stops answering warns once per outage; recovery logs once after the run truly settles", async (t) => {
  let fail = true;
  const relay = fakeRelay(async () => {
    if (fail) throw new Error("ECONNREFUSED");
    return [];
  });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  // Past the supervisor's boot grace window (FakeSupervisor's "since" is 1),
  // so these failures read as the relay actually not answering.
  t.mock.timers.enable({ apis: ["Date"], now: RELAY_BOOT_GRACE_MS + 1000 });

  const lines: string[] = [];
  const realWarn = console.warn;
  const realLog = console.log;
  console.warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));

  try {
    await pollOnce();
    await pollOnce();
    await pollOnce();
    assert.equal(
      lines.filter((l) => l.includes("not answering")).length,
      1,
      "three failed polls of the same outage must warn once, not three times",
    );

    fail = false;
    // ok() within the settle window keeps a flapping outage as ONE run — a
    // success right after the last failure is not yet a recovery. (This test
    // used to end here with a comment claiming one more poll "closes the run
    // out"; it does not, which is exactly what the assertion below proves.)
    await pollOnce();
    assert.equal(lines.filter((l) => l.includes("answering again")).length, 0, "a success inside the settle window is not a recovery yet");

    t.mock.timers.tick(DEFAULT_SETTLE_MS + 1000);
    await pollOnce();
    assert.equal(lines.filter((l) => l.includes("answering again")).length, 1, "a success held past the settle window is");
  } finally {
    console.warn = realWarn;
    console.log = realLog;
    await videoService.detachRelay();
  }
});

test("markRequested moves a not-ready pull feed off standby — its only observable effect", async () => {
  // Validation lives at the call site now (relayTarget(), which the proxy
  // calls before markRequested() — see video-proxy-routes.ts and its own
  // relayTarget-refusal tests): markRequested() itself is a trusted,
  // synchronous setter with nothing to reject, so there is no "unknown id"
  // or "pattern-failing id" case left to prove here.
  const made = await videoService.addFeed({ name: "Gym cam", source: { kind: "pull", url: "rtsp://192.0.2.52/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const relay = fakeRelay(async () => [notReadyPath({ name: id })]);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  try {
    await pollOnce();
    let feed = (await videoService.state()).feeds.find((f) => f.id === id);
    assert.equal(feed?.status.state, "standby", "nothing has asked for this feed yet");

    videoService.markRequested(id);
    await pollOnce();
    feed = (await videoService.state()).feeds.find((f) => f.id === id);
    assert.equal(feed?.status.state, "offline", "a real request must move a not-ready pull feed off standby");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

// ── relayTarget() — what the playback proxy is allowed to reach ───────────

test("relayTarget refuses a pattern-failing id, an unknown id, and a kind an embed/external feed cannot serve, all before ever asking whether the relay is up", async () => {
  // No relay attached at all — every one of these must read 404, not 503, so
  // an unknown feed can never be mistaken for "the relay is down".
  assert.deepEqual(videoService.relayTarget("../../etc/passwd", "whep"), { refuse: 404 });
  assert.deepEqual(videoService.relayTarget("Bad_ID", "whep"), { refuse: 404 });
  assert.deepEqual(videoService.relayTarget("no-such-feed", "whep"), { refuse: 404 });

  const made = await videoService.addFeed({
      name: "YouTube feed",
      source: { kind: "embed", player: "youtube-channel", ref: "UC0123456789abcdefghijkl" },
    });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  try {
    assert.deepEqual(videoService.relayTarget(id, "whep"), { refuse: 404 }, "embed has no relay path at all");
    assert.deepEqual(videoService.relayTarget(id, "hls"), { refuse: 404 });
  } finally {
    await videoService.removeFeed(id);
  }
});

test("relayTarget refuses whip on a pull feed and on a push feed whose own protocol is not whip", async () => {
  const relay = fakeRelay(async () => []);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const pull = await videoService.addFeed({ name: "Lobby", source: { kind: "pull", url: "rtsp://192.0.2.60/s", username: "" } });
  const srtPush = await videoService.addFeed({ name: "Stage box", source: { kind: "push", protocol: "srt" } });
  const whipPush = await videoService.addFeed({ name: "OBS", source: { kind: "push", protocol: "whip" } });
  assert.ok(pull.ok && srtPush.ok && whipPush.ok);
  const pullId = (pull as { feed: { id: string } }).feed.id;
  const srtId = (srtPush as { feed: { id: string } }).feed.id;
  const whipId = (whipPush as { feed: { id: string } }).feed.id;

  try {
    assert.deepEqual(videoService.relayTarget(pullId, "whip"), { refuse: 404 }, "a pull feed has nothing listening for a WHIP offer");
    assert.deepEqual(videoService.relayTarget(srtId, "whip"), { refuse: 404 }, "this push feed's device speaks SRT, not WHIP");
    // The one case that must NOT be refused: a genuine push+whip feed, relay running.
    assert.deepEqual(videoService.relayTarget(whipId, "whip"), {
      host: "127.0.0.1",
      port: 8889,
      path: `/${whipId}/whip`,
    });
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(pullId);
    await videoService.removeFeed(srtId);
    await videoService.removeFeed(whipId);
  }
});

test("relayTarget answers 503 only once the feed and kind both check out, and the relay itself is not running", async () => {
  const made = await videoService.addFeed({ name: "Balcony", source: { kind: "pull", url: "rtsp://192.0.2.61/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  try {
    // No relay attached — relayStatus() reads "off", which relayTarget must
    // treat as "not running" exactly like "starting" or "failing".
    assert.deepEqual(videoService.relayTarget(id, "whep"), { refuse: 503 });
    assert.deepEqual(videoService.relayTarget(id, "hls"), { refuse: 503 });

    const relay = fakeRelay(async () => []);
    const supervisor = new FakeSupervisor();
    supervisor.current = { state: "starting" };
    videoPollDeps.inDemand = () => false;
    attach(relay, supervisor);
    // attachRelay() itself does not publish (see its own comment) — force one
    // so the snapshot relayTarget reads picks up "starting" without waiting
    // on a poll. publish() is private; reached the same way pollOnce() above is.
    await (videoService as unknown as { publish(): Promise<void> }).publish();
    assert.deepEqual(videoService.relayTarget(id, "whep"), { refuse: 503 }, "starting is not running either");

    supervisor.current = { state: "running", since: Date.now() };
    await (videoService as unknown as { publish(): Promise<void> }).publish();
    assert.deepEqual(videoService.relayTarget(id, "hls"), { host: "127.0.0.1", port: 8888, path: `/${id}` });
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

// R13a (fix round 1): relayTarget must forward to the ports the RUNNING
// relay was actually STARTED with, never the store's current ports — a
// ports change (PR 2's PATCH /api/video/ports) writes the store at once,
// but the relay process itself keeps listening on its old ports until it
// restarts, and a poll landing in that gap must not point the proxy at a
// port nothing is listening on yet.
test("relayTarget uses the ports the relay was attached with, even after the store's own ports change under it", async () => {
  const { videoFeedsStore } = await import("./feed-store.js");
  const made = await videoService.addFeed({ name: "Dock cam", source: { kind: "pull", url: "rtsp://192.0.2.70/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const OLD_PORTS = { rtmp: 11935, srt: 18890, webrtcUdp: 18189, webrtcHttp: 18889, hls: 18888, api: 19997 };
  const relay = fakeRelay(async () => []);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor, OLD_PORTS);
  try {
    await (videoService as unknown as { publish(): Promise<void> }).publish();
    assert.deepEqual(
      videoService.relayTarget(id, "hls"),
      { host: "127.0.0.1", port: OLD_PORTS.hls, path: `/${id}` },
      "sanity: the relay's own attach-time ports before anything changes",
    );

    // The operator changes ports in the store — the relay itself has not
    // restarted and is still bound to OLD_PORTS.
    await videoFeedsStore.update((current) => ({
      ...current,
      ports: { rtmp: 21935, srt: 28890, webrtcUdp: 28189, webrtcHttp: 28889, hls: 28888, api: 29997 },
    }));
    // A poll/publish after the store write — the moment R13a's bug pointed
    // the proxy at a port the relay was not actually listening on.
    await (videoService as unknown as { publish(): Promise<void> }).publish();

    assert.deepEqual(
      videoService.relayTarget(id, "whep"),
      { host: "127.0.0.1", port: OLD_PORTS.webrtcHttp, path: `/${id}/whep` },
      "the relay has not restarted — the proxy must still reach it on the port it actually opened",
    );
    assert.deepEqual(videoService.relayTarget(id, "hls"), { host: "127.0.0.1", port: OLD_PORTS.hls, path: `/${id}` });
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("relay status maps the supervisor's status and version onto the wire shape, including a null starting version before the banner is parsed", async () => {
  const relay = fakeRelay(async () => []);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  try {
    supervisor.current = { state: "off" };
    assert.deepEqual((await videoService.state()).relay, { state: "off" });

    // A relay that has just spawned has not printed its version banner yet
    // — "starting" must be able to say so honestly, not fake a string.
    supervisor.current = { state: "starting" };
    supervisor.ver = null;
    assert.deepEqual((await videoService.state()).relay, { state: "starting", version: null });

    supervisor.ver = "v1.21.1";
    assert.deepEqual((await videoService.state()).relay, { state: "starting", version: "v1.21.1" });

    supervisor.current = { state: "running", since: 1000 };
    const running = (await videoService.state()).relay;
    assert.equal(running.state, "running");
    if (running.state === "running") {
      assert.equal(running.version, "v1.21.1");
      assert.ok(running.ports.rtmp > 0, "running must carry the configured ports");
    }

    supervisor.current = { state: "failing", reason: "port in use", retryAt: 12345 };
    assert.deepEqual((await videoService.state()).relay, { state: "failing", reason: "port in use", retryAt: 12345 });
  } finally {
    await videoService.detachRelay();
  }
});

test("detachRelay reports the relay off and forgets its last known paths — a stale answer must not linger", async () => {
  const made = await videoService.addFeed({ name: "Loft cam", source: { kind: "pull", url: "rtsp://192.0.2.53/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const relay = fakeRelay(async () => [readyPath({ name: id })]);
  const supervisor = new FakeSupervisor();
  supervisor.current = { state: "running", since: 1 };
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  try {
    await pollOnce();
    let feed = (await videoService.state()).feeds.find((f) => f.id === id);
    assert.equal(feed?.status.state, "live");

    await videoService.detachRelay();
    const state = await videoService.state();
    assert.deepEqual(state.relay, { state: "off" });
    feed = state.feeds.find((f) => f.id === id);
    // "no path at all" — not "standby" — is what feed-state.ts reads a
    // detached relay as, same as a relay that has never reconciled this feed.
    assert.equal(feed?.status.state, "offline");
    assert.ok((feed?.status.lastSeenAt ?? 0) > 0, "the earlier live poll must have recorded a seen time");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("detachRelay settles feeds — logs went offline and flushes the seen store, not just a bare publish", async (t) => {
  const made = await videoService.addFeed({ name: "Sanctum cam", source: { kind: "push", protocol: "rtmp" }, password: "pw" });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const relay = fakeRelay(async () => [readyPath({ name: id })]);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  t.mock.timers.enable({ apis: ["Date"], now: 0 });

  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));

  try {
    await pollOnce(); // t=0 — the first-ever write always lands
    t.mock.timers.tick(SEEN_WRITE_INTERVAL_MS - 1000); // t=59_000 — still inside the throttle window
    await pollOnce(); // still live — this write would be throttled away by noteSeen() alone

    await videoService.detachRelay(); // t=59_000 — must settle, not just publish

    assert.ok(lines.includes("[video] Sanctum cam went offline"), "detachRelay must log the transition, not silently drop it");
    const onDisk = (await videoSeenStore.reload())[id];
    assert.equal(
      onDisk,
      SEEN_WRITE_INTERVAL_MS - 1000,
      "the flush must carry the LATEST in-memory value, not the throttled-away first write",
    );
  } finally {
    console.log = realLog;
    await videoService.removeFeed(id);
  }
});

test("a poll that fails clears lastPaths and reports the relay as failing to answer", async () => {
  const made = await videoService.addFeed({ name: "Vestry cam", source: { kind: "pull", url: "rtsp://192.0.2.60/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  let fail = false;
  const relay = fakeRelay(async () => {
    if (fail) throw new Error("ECONNREFUSED");
    return [readyPath({ name: id })];
  });
  const supervisor = new FakeSupervisor();
  supervisor.current = { state: "running", since: 1 };
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  try {
    await pollOnce();
    assert.equal(videoService.current().feeds.find((f) => f.id === id)?.status.state, "live");
    assert.equal(videoService.current().relay.state, "running");

    fail = true;
    await pollOnce();
    const failed = videoService.current();
    assert.equal(
      failed.feeds.find((f) => f.id === id)?.status.state,
      "offline",
      "a relay that stops answering must not go on showing a stale live feed",
    );
    assert.deepEqual(failed.relay, { state: "failing", reason: "The relay is not answering", retryAt: null });

    await videoService.detachRelay();
    assert.deepEqual(videoService.current().relay, { state: "off" });
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a poll that fails within the supervisor's own boot grace window does not flip the relay to not answering, and logs nothing", async (t) => {
  const relay = fakeRelay(async () => {
    throw new Error("ECONNREFUSED");
  });
  const supervisor = new FakeSupervisor();
  supervisor.current = { state: "running", since: 0 };
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  // The supervisor marks a process "running" the moment it spawns, well
  // before MediaMTX has actually opened its API — 1 s before the grace
  // window ends, a failed poll is still that boot-up window, not a real
  // failure to answer.
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  t.mock.timers.tick(RELAY_BOOT_GRACE_MS - 1000);

  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));

  try {
    await pollOnce();
    assert.equal(videoService.current().relay.state, "running", "still within the boot grace window");
    assert.equal(warns.length, 0, "nothing worth logging while the relay is still starting up");
  } finally {
    console.warn = realWarn;
    await videoService.detachRelay();
  }
});

test("a poll that fails after the supervisor's own boot grace window flips the relay to not answering, and logs once", async (t) => {
  const relay = fakeRelay(async () => {
    throw new Error("ECONNREFUSED");
  });
  const supervisor = new FakeSupervisor();
  supervisor.current = { state: "running", since: 0 };
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  t.mock.timers.tick(RELAY_BOOT_GRACE_MS + 1000); // 1 s past the grace

  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));

  try {
    await pollOnce();
    assert.deepEqual(videoService.current().relay, { state: "failing", reason: "The relay is not answering", retryAt: null });
    assert.equal(warns.filter((l) => l.includes("not answering")).length, 1);
  } finally {
    console.warn = realWarn;
    await videoService.detachRelay();
  }
});

test("the service does not poll while the supervisor is off, so a relay switched off produces no \"not answering\" line", async () => {
  let calls = 0;
  const relay = fakeRelay(async () => {
    calls++;
    throw new Error("ECONNREFUSED");
  });
  const supervisor = new FakeSupervisor();
  supervisor.current = { state: "off" };
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));

  try {
    await pollOnce();
    assert.equal(calls, 0, "an off supervisor must never even be asked — the poll loop checks it first, before any relay.status() call");
    assert.deepEqual(videoService.current().relay, { state: "off" });
    assert.equal(warns.filter((l) => l.includes("not answering")).length, 0, "an off relay must never log as not answering");
  } finally {
    console.warn = realWarn;
    await videoService.detachRelay();
  }
});

test("a relay the supervisor already reports failing keeps its own reason, and logs no \"not answering\" line", async () => {
  const relay = fakeRelay(async () => {
    throw new Error("ECONNREFUSED");
  });
  const supervisor = new FakeSupervisor();
  supervisor.current = { state: "failing", reason: "Port 1935 is in use by OBS.", retryAt: 55555 };
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));

  try {
    await pollOnce(); // also fails to answer — the supervisor's own diagnosis still wins
    assert.deepEqual(videoService.current().relay, { state: "failing", reason: "Port 1935 is in use by OBS.", retryAt: 55555 });
    assert.deepEqual(
      warns.filter((l) => l.includes("not answering")),
      [],
      "the supervisor has already logged why it is failing; a poll must not add a second line",
    );
  } finally {
    console.warn = realWarn;
    await videoService.detachRelay();
  }
});

test("the \"not answering\" override never applies while starting, even with a version left over from a previous run, and logs nothing", async () => {
  const relay = fakeRelay(async () => {
    throw new Error("ECONNREFUSED");
  });
  const supervisor = new FakeSupervisor();
  supervisor.current = { state: "starting" };
  supervisor.ver = "v1.21.1"; // leftover from a PREVIOUS run — version() never resets on its own
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));

  try {
    await pollOnce(); // fails to answer — there is no live child yet to BE "not answering"
    assert.deepEqual(
      videoService.current().relay,
      { state: "starting", version: "v1.21.1" },
      "starting must never read as failing, however long ago the leftover version was logged",
    );
    assert.deepEqual(warns.filter((l) => l.includes("not answering")), [], "a relay still starting has nothing to answer with yet");
  } finally {
    console.warn = realWarn;
    await videoService.detachRelay();
  }
});

test("the attached supervisor's status events publish immediately, without waiting for a poll", async () => {
  const relay = fakeRelay(async () => []);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false; // no poll is running at all
  attach(relay, supervisor);

  const { addBroadcastListener } = await import("../broadcaster.js");
  const frames: { relay: unknown }[] = [];
  addBroadcastListener((channel, payload) => {
    if (channel === "video:state") frames.push(payload as { relay: unknown });
  });

  try {
    supervisor.current = { state: "starting" };
    supervisor.emit("status", supervisor.current);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(frames.length >= 1, "a status event must publish without a poll ever running");
    assert.deepEqual(frames.at(-1)?.relay, { state: "starting", version: null });

    const before = frames.length;
    supervisor.current = { state: "failing", reason: "boom", retryAt: 999 };
    supervisor.emit("status", supervisor.current);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(frames.length > before, "every status event must publish, not only the first");
    assert.deepEqual(frames.at(-1)?.relay, { state: "failing", reason: "boom", retryAt: 999 });
  } finally {
    await videoService.detachRelay();
  }
});

test("an in-flight SUCCESS against a process the supervisor has since reported failing does not resurrect the feed", async () => {
  const made = await videoService.addFeed({ name: "Inflight cam", source: { kind: "push", protocol: "rtmp" }, password: "pw" });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const supervisor = new FakeSupervisor();
  let hold = false;
  resolveA = null;
  videoPollDeps.inDemand = () => false;
  attach(
    fakeRelay(() =>
      hold ? new Promise<RelayPath[]>((resolve) => { resolveA = resolve; }) : Promise.resolve([readyPath({ name: id })]),
    ),
    supervisor,
  );

  try {
    await pollOnce();
    assert.equal(videoService.current().feeds.find((f) => f.id === id)?.status.state, "live");

    hold = true;
    const inFlight = pollOnce(); // request sent to the process now about to be reported crashed

    supervisor.current = { state: "failing", reason: "crashed", retryAt: 1 };
    supervisor.emit("status", supervisor.current);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      videoService.current().feeds.find((f) => f.id === id)?.status.state,
      "offline",
      "the status change must already have taken effect",
    );

    callResolveA([readyPath({ name: id })]); // the OLD process's answer lands after the status event
    await inFlight;

    const snap = videoService.current();
    assert.equal(
      snap.feeds.find((f) => f.id === id)?.status.state,
      "offline",
      "a stale success must not resurrect a feed the status change already marked offline",
    );
    assert.equal(snap.relay.state, "failing");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("an in-flight REJECTION against the old process, landing after a respawn, does not mark the new process not answering", async () => {
  const supervisor = new FakeSupervisor();
  rejectA = null;
  videoPollDeps.inDemand = () => false;
  attach(fakeRelay(() => new Promise<RelayPath[]>((_resolve, reject) => { rejectA = reject; })), supervisor);

  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));

  try {
    const inFlight = pollOnce(); // against the old (hung) process

    supervisor.current = { state: "failing", reason: "crashed", retryAt: 1 };
    supervisor.emit("status", supervisor.current);
    supervisor.current = { state: "running", since: 2 };
    supervisor.emit("status", supervisor.current); // respawned
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(videoService.current().relay.state, "running", "the respawn must already be published");

    callRejectA(new Error("timeout")); // the OLD process's rejection lands late
    await inFlight;

    assert.equal(
      videoService.current().relay.state,
      "running",
      "a stale rejection from the old process must not mark the NEW one not answering",
    );
    assert.equal(warns.filter((l) => l.includes("not answering")).length, 0);
  } finally {
    console.warn = realWarn;
    await videoService.detachRelay();
  }
});

test("a status change alone, with no detach, still lets the next poll run even while the previous one is stuck", async () => {
  const supervisor = new FakeSupervisor();
  let calls = 0;
  videoPollDeps.inDemand = () => false;
  attach(
    fakeRelay(() => {
      calls++;
      if (calls === 1) return new Promise<RelayPath[]>(() => {}); // the first request never resolves
      return Promise.resolve([]);
    }),
    supervisor,
  );

  try {
    void pollOnce(); // the first poll hangs forever
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls, 1);

    supervisor.current = { state: "failing", reason: "crashed", retryAt: 1 };
    supervisor.emit("status", supervisor.current); // bumps the generation with no detach at all
    await new Promise((r) => setTimeout(r, 10));

    await pollOnce(); // the new generation's own poll
    assert.equal(calls, 2, "a status change must free the reentry guard for a new poll, not leave it blocked by the still-hung first one");
  } finally {
    await videoService.detachRelay();
  }
});

test("a status event to a non-running state clears lastPaths immediately — a dead process's feed does not stay live", async () => {
  const made = await videoService.addFeed({ name: "Ember cam", source: { kind: "push", protocol: "rtmp" }, password: "pw" });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const relay = fakeRelay(async () => [readyPath({ name: id })]);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  try {
    await pollOnce();
    assert.equal(videoService.current().feeds.find((f) => f.id === id)?.status.state, "live");

    // The supervisor's OWN crash detection reports failing — no new poll has run.
    supervisor.current = { state: "failing", reason: "crashed", retryAt: 123 };
    supervisor.emit("status", supervisor.current);
    await new Promise((r) => setTimeout(r, 20));

    const snap = videoService.current();
    assert.equal(
      snap.feeds.find((f) => f.id === id)?.status.state,
      "offline",
      "a dead process's feed must not still read live just because no poll has run against it yet",
    );
    assert.deepEqual(snap.relay, { state: "failing", reason: "crashed", retryAt: 123 });
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("against a real supervisor: the not-answering flag does not carry over into a freshly respawned process", async () => {
  const made = await videoService.addFeed({ name: "Respawn cam", source: { kind: "push", protocol: "rtmp" }, password: "pw" });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const children: FakeChild[] = [];
  const sup = new RelaySupervisor({
    spawnImpl: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    psImpl: async () => null,
  });

  let apiUp = true;
  videoPollDeps.inDemand = () => false;
  attach(
    fakeRelay(async () => {
      if (!apiUp) throw new Error("ECONNREFUSED");
      return [readyPath({ name: id })];
    }),
    sup,
  );

  try {
    await sup.start("/bin/mediamtx", "/tmp/cfg.yml");
    children[0].stdout.write("2026/09/28 10:00:00 INF MediaMTX v1.21.1, ...\n");
    await new Promise((r) => setTimeout(r, 20));
    await pollOnce();
    assert.equal(videoService.current().relay.state, "running");
    assert.equal(videoService.current().feeds.find((f) => f.id === id)?.status.state, "live");

    apiUp = false;
    children[0].emit("exit", 1); // the process crashes — onExit(): status "failing", then "exit"
    await new Promise((r) => setTimeout(r, 20)); // the status listener's own publish

    await pollOnce(); // a poll during backoff — fails; the supervisor already says failing on its own
    assert.equal(videoService.current().relay.state, "failing");

    await new Promise((r) => setTimeout(r, 1100)); // restartDelayMs(0) = 1 s — the real respawn
    await new Promise((r) => setTimeout(r, 20)); // spawnChild()'s status event -> publish

    apiUp = true; // the fresh process's API is reachable, but nothing has POLLED it yet
    const afterRespawn = videoService.current();
    assert.equal(afterRespawn.relay.state, "running", "a fresh process must not still read failing");
    assert.notEqual(
      (afterRespawn.relay as { reason?: string }).reason,
      "The relay is not answering",
      "the OLD process's not-answering verdict must not have carried over to the NEW one",
    );
  } finally {
    await videoService.detachRelay();
    await sup.stop();
    await videoService.removeFeed(id);
  }
});

test("against a real supervisor: a poll failing during its crash backoff logs no \"not answering\" line after the supervisor's own exit line", async () => {
  const children: FakeChild[] = [];
  const sup = new RelaySupervisor({
    spawnImpl: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    psImpl: async () => null,
  });
  videoPollDeps.inDemand = () => false;
  attach(
    fakeRelay(async () => {
      throw new Error("ECONNREFUSED");
    }),
    sup,
  );

  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));

  try {
    await sup.start("/bin/mediamtx", "/tmp/cfg.yml");
    children[0].emit("exit", 1); // the process crashes; the supervisor backs off 1 s before respawning
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sup.status().state, "failing", "the supervisor must be in its backoff, or this proves nothing");
    assert.equal(warns.filter((l) => l.includes("relay exited")).length, 1, "the supervisor reports the crash itself");

    await pollOnce(); // fails: nothing is listening until the respawn
    assert.deepEqual(
      warns.filter((l) => l.includes("not answering")),
      [],
      "a poll during the supervisor's own backoff must not repeat the crash as a second line",
    );
  } finally {
    console.warn = realWarn;
    await videoService.detachRelay();
    await sup.stop();
  }
});

test("attaching a new relay without detaching first replaces the old one's listeners rather than leaking them", async () => {
  const relayA = fakeRelay(async () => []);
  const supervisorA = new FakeSupervisor();
  const relayB = fakeRelay(async () => []);
  const supervisorB = new FakeSupervisor();

  videoPollDeps.inDemand = () => false;
  attach(relayA, supervisorA);
  attach(relayB, supervisorB); // no explicit detach in between

  try {
    // "line" and "status" are the only two events attachRelay() subscribes to.
    assert.equal(supervisorA.listenerCount("line"), 0, "the old supervisor's line listener must be removed");
    assert.equal(supervisorA.listenerCount("status"), 0, "and its status listener");
    assert.equal(supervisorB.listenerCount("line"), 1, "the new supervisor must be the one actually listened to");
    assert.equal(supervisorB.listenerCount("status"), 1, "for its status events too");
  } finally {
    await videoService.detachRelay();
  }
});

test("attaching a new relay while the old one's poll is still in flight does not block the new relay's first read", async () => {
  resolveA = null;
  const relayA = fakeRelay(
    () =>
      new Promise<RelayPath[]>((resolve) => {
        resolveA = resolve;
      }),
  );
  const supervisorA = new FakeSupervisor();

  let bCalls = 0;
  const relayB = fakeRelay(async () => {
    bCalls++;
    return [];
  });
  const supervisorB = new FakeSupervisor();

  const real = { ...videoPollDeps };
  videoPollDeps.inDemand = () => true; // both attaches take their own immediate read
  videoPollDeps.setInterval = () => ({} as NodeJS.Timeout); // no real timer needed for this test
  videoPollDeps.clearInterval = () => {};

  try {
    attach(relayA, supervisorA); // starts A's poll, unawaited — still pending
    await videoService.detachRelay();
    attach(relayB, supervisorB); // must still take its OWN first read
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(bCalls, 1, "the new relay's first read must not be skipped by the old request's in-flight guard");

    callResolveA([]); // let A's stale response land late
    await new Promise((r) => setTimeout(r, 20));
    // Nothing about A's late answer may have touched B's own state — this is
    // implicitly proven by detachRelay()/state() staying consistent below,
    // and explicitly by bCalls not having been prevented above.
  } finally {
    await videoService.detachRelay();
    restorePollDeps(real);
  }
});

test("a stale in-flight SUCCESS from an already-detached relay is never applied, even when it resolves READY", async () => {
  const made = await videoService.addFeed({ name: "Race cam", source: { kind: "pull", url: "rtsp://192.0.2.70/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  resolveA = null;
  const relayA = fakeRelay(() => new Promise<RelayPath[]>((resolve) => { resolveA = resolve; }));
  videoPollDeps.inDemand = () => false;
  attach(relayA, new FakeSupervisor());
  const inFlight = pollOnce(); // A's status() is now pending, unawaited

  try {
    await videoService.detachRelay();
    attach(fakeRelay(async () => [notReadyPath({ name: id })]), new FakeSupervisor());

    // A's stale answer finally lands, claiming the feed IS ready — this is
    // the exact shape the staleness guard (the `this.relayGeneration !==
    // generation` check after a successful relay.status()) exists for.
    callResolveA([readyPath({ name: id })]);
    await inFlight;

    const feed = (await videoService.state()).feeds.find((f) => f.id === id);
    assert.notEqual(feed?.status.state, "live", "a stale answer from an already-detached relay must never be applied");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a stale in-flight REJECTION from an already-detached relay does not mark the new relay not answering", async () => {
  const made = await videoService.addFeed({ name: "Reject cam", source: { kind: "pull", url: "rtsp://192.0.2.71/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  rejectA = null;
  videoPollDeps.inDemand = () => false;
  attach(
    fakeRelay(() => new Promise<RelayPath[]>((_resolve, reject) => { rejectA = reject; })),
    new FakeSupervisor(),
  );
  const inFlight = pollOnce(); // A's status() is now pending, unawaited

  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));

  try {
    await videoService.detachRelay();
    attach(fakeRelay(async () => [readyPath({ name: id })]), new FakeSupervisor());
    await pollOnce(); // B answers on its own: feed live, relay running

    // A's stale FAILURE finally lands — this is the same staleness guard,
    // in the catch branch instead of the success one.
    callRejectA(new Error("ECONNREFUSED"));
    await inFlight;

    const snap = videoService.current();
    assert.equal(snap.relay.state, "running", "a stale rejection must not mark the NEW relay not answering");
    assert.equal(snap.feeds.find((f) => f.id === id)?.status.state, "live", "a stale rejection must not wipe the NEW relay's paths");
    assert.equal(warns.filter((l) => l.includes("not answering")).length, 0);
  } finally {
    console.warn = realWarn;
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a seen-store write that rejects still lets the poll publish its transitions, warns once per outage, and logs recovery once settled", async (t) => {
  const made = await videoService.addFeed({ name: "Crypt cam", source: { kind: "pull", url: "rtsp://192.0.2.62/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const store = videoSeenStore as unknown as { update: (...a: unknown[]) => Promise<unknown> };
  const realUpdate = store.update.bind(videoSeenStore);
  let failWrites = true;
  store.update = async (...args: unknown[]) => {
    if (failWrites) throw new Error("disk full");
    return realUpdate(...args);
  };

  t.mock.timers.enable({ apis: ["Date"], now: 0 });

  const relay = fakeRelay(async () => [readyPath({ name: id })]);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const lines: string[] = [];
  const realWarn = console.warn;
  const realLog = console.log;
  console.warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));

  try {
    await pollOnce();
    // The transition reached the wire even though its seen-store write
    // rejected underneath it — the poll's critical path was never aborted.
    assert.equal(videoService.current().feeds.find((f) => f.id === id)?.status.state, "live");
    assert.equal(lines.filter((l) => l.includes("could not save the last-seen time")).length, 1);

    await pollOnce(); // same outage, retried — must not warn a second time
    assert.equal(lines.filter((l) => l.includes("could not save the last-seen time")).length, 1);

    failWrites = false;
    t.mock.timers.tick(DEFAULT_SETTLE_MS + 1000);
    await pollOnce();
    assert.equal(lines.filter((l) => l.includes("saving the last-seen time is working again")).length, 1);
  } finally {
    console.warn = realWarn;
    console.log = realLog;
    store.update = realUpdate;
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a rejected forgetSeen write still lets removeFeed succeed and publish, and logs once through the seen-store outage", async () => {
  const made = await videoService.addFeed({ name: "Culvert cam", source: { kind: "push", protocol: "rtmp" }, password: "pw" });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const store = videoSeenStore as unknown as { update: (...a: unknown[]) => Promise<unknown> };
  const realUpdate = store.update.bind(videoSeenStore);
  store.update = async () => {
    throw new Error("disk full");
  };

  const lines: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));

  try {
    const removed = await videoService.removeFeed(id);
    assert.equal(removed, true, "removeFeed must still succeed despite the seen-store write rejecting");
    assert.equal((await videoService.state()).feeds.some((f) => f.id === id), false, "the feed must actually be gone");
    assert.equal(lines.filter((l) => l.includes("could not save the last-seen time")).length, 1, "the write failure must still reach the operator once");
  } finally {
    console.warn = realWarn;
    store.update = realUpdate;
  }
});

test("removeFeed forgets the seen store, so a re-added feed under the same name reads waiting, not a stale offline", async () => {
  const name = "Steeple cam";
  const made = await videoService.addFeed({ name, source: { kind: "push", protocol: "rtmp" }, password: "pw" });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const relay = fakeRelay(async () => [readyPath({ name: id })]);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);
  await pollOnce(); // records a lastSeenAt for id
  await videoService.detachRelay();

  await videoService.removeFeed(id);

  const readded = await videoService.addFeed({ name, source: { kind: "push", protocol: "rtmp" }, password: "pw" });
  assert.ok(readded.ok);
  const newId = (readded as { feed: { id: string } }).feed.id;
  assert.equal(newId, id, "feedIdFor() is deterministic — this only proves anything if the id really did come back");

  // A relay that has never seen this (new) feed ready — "not ready" is the
  // shape that distinguishes "waiting" from "offline"; with no relay at all,
  // every feed reads "no path", which is offline regardless of seen-store
  // history and would prove nothing either way.
  const relay2 = fakeRelay(async () => [notReadyPath({ name: newId })]);
  const supervisor2 = new FakeSupervisor();
  attach(relay2, supervisor2);
  try {
    await pollOnce();
    const feed = (await videoService.state()).feeds.find((f) => f.id === newId);
    assert.equal(feed?.status.state, "waiting", "a re-added feed must not inherit the deleted one's last-seen time");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(newId);
  }
});

test("the last-seen time is flushed to disk on the transition out of ready, not left to the throttle", async (t) => {
  const made = await videoService.addFeed({ name: "Vault cam", source: { kind: "push", protocol: "rtmp" }, password: "pw" });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  let answer: RelayPath[] = [readyPath({ name: id })];
  const relay = fakeRelay(async () => answer);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  t.mock.timers.enable({ apis: ["Date"], now: 0 });

  try {
    await pollOnce(); // t=0 — the first-ever write always lands
    let onDisk = (await videoSeenStore.reload())[id];
    assert.equal(onDisk, 0);

    t.mock.timers.tick(SEEN_WRITE_INTERVAL_MS - 1000); // t=59_000 — still inside the throttle window
    await pollOnce(); // still ready — this write is throttled away
    onDisk = (await videoSeenStore.reload())[id];
    assert.equal(onDisk, 0, "the throttle must still be suppressing writes here, or this test proves nothing");

    answer = [notReadyPath({ name: id })];
    await pollOnce(); // transition OUT of ready at t=59_000 — must flush regardless of the throttle

    onDisk = (await videoSeenStore.reload())[id];
    assert.equal(onDisk, SEEN_WRITE_INTERVAL_MS - 1000, "the flush must carry the LATEST in-memory value, not the throttled-away one");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

// ── Reconciling the relay on a feed change, push passwords and addresses ──

function recordingRelay(reconciled: RelayFeed[][], opts: { kickPublisher?: (feedId: string) => Promise<void> } = {}): VideoRelay {
  return {
    reconcile: async (feeds) => {
      reconciled.push(feeds);
    },
    status: async () => [],
    playback: (feedId: string) => ({ whep: `/video/${feedId}/whep`, hls: `/video/${feedId}/index.m3u8` }),
    kickPublisher: opts.kickPublisher ?? (async () => {}),
  };
}

test("addFeed, updateFeed and removeFeed each reconcile the relay while it is attached and running, with a pull feed's credentials folded into its plan entry", async () => {
  const reconciled: RelayFeed[][] = [];
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(recordingRelay(reconciled), supervisor);

  try {
    const made = await videoService.addFeed({
      name: "Pulpit cam",
      source: { kind: "pull", url: "rtsp://192.0.2.90:8554/s", username: "admin" },
      password: "cam-pw",
    });
    assert.ok(made.ok);
    const id = (made as { feed: { id: string } }).feed.id;
    assert.equal(reconciled.length, 1, "expected addFeed to reconcile the relay");
    // Other tests in this shared-store file leave their own feeds behind, so
    // the plan reconcile sees is never just this one feed — find it by id
    // rather than assume it is reconciled[0][0].
    const added = reconciled[0]!.find((f) => f.id === id) as Extract<RelayFeed, { kind: "pull" }> | undefined;
    assert.ok(added, "expected the just-added feed in the reconciled plan");
    assert.equal(added.kind, "pull");
    assert.equal(added.source, "rtsp://admin:cam-pw@192.0.2.90:8554/s", "expected the credentials folded into the URL the relay sees");

    await videoService.updateFeed(id, { name: "Pulpit cam 2" });
    assert.equal(reconciled.length, 2, "expected updateFeed to reconcile the relay");

    await videoService.removeFeed(id);
    assert.equal(reconciled.length, 3, "expected removeFeed to reconcile the relay");
    assert.equal(reconciled[2]!.some((f) => f.id === id), false, "the removed feed must be gone from the plan reconcile sees");
  } finally {
    await videoService.detachRelay();
  }
});

test("a push feed's plan entry carries its password, read fresh from secretsStore — a rotated password reaches the very next reconcile", async () => {
  const reconciled: RelayFeed[][] = [];
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(recordingRelay(reconciled), supervisor);

  try {
    const made = await videoService.addFeed({ name: "Stage box", source: { kind: "push", protocol: "srt" } });
    assert.ok(made.ok);
    const id = (made as { feed: { id: string } }).feed.id;
    const first = reconciled[0]!.find((f) => f.id === id) as Extract<RelayFeed, { kind: "push" }> | undefined;
    assert.ok(first, "expected the just-added feed in the reconciled plan");
    assert.equal(first.kind, "push");
    assert.equal(first.password, (await secretsStore.getSecrets(SECRET_SLOT(id))).password);

    await videoService.newPushPassword(id);
    const rotated = reconciled[reconciled.length - 1]!.find((f) => f.id === id) as Extract<RelayFeed, { kind: "push" }> | undefined;
    assert.ok(rotated);
    assert.notEqual(rotated.password, first.password, "expected the reconciled plan to carry the freshly rotated password, not the old one");
  } finally {
    await videoService.detachRelay();
  }
});

test("reconcile is skipped while the relay is attached but the supervisor is not running, and resumes once it is", async () => {
  const reconciled: RelayFeed[][] = [];
  const supervisor = new FakeSupervisor();
  supervisor.current = { state: "starting" };
  videoPollDeps.inDemand = () => false;
  attach(recordingRelay(reconciled), supervisor);

  try {
    const made = await videoService.addFeed({ name: "Choir loft cam", source: { kind: "external", url: "http://192.0.2.91/cam/whep" } });
    assert.ok(made.ok);
    assert.equal(reconciled.length, 0, "expected no reconcile while the supervisor reports \"starting\"");
    const id = (made as { feed: { id: string } }).feed.id;

    supervisor.current = { state: "running", since: 0 };
    await videoService.updateFeed(id, { name: "Choir loft" });
    assert.equal(reconciled.length, 1, "expected a reconcile once the supervisor reports running");
  } finally {
    await videoService.detachRelay();
  }
});

test("a reconcile failure is logged once per outage and never rejects addFeed/updateFeed — the feed store write is the source of truth", async () => {
  let fail = true;
  const relay: VideoRelay = {
    reconcile: async () => {
      if (fail) throw new Error("relay unreachable");
    },
    status: async () => [],
    playback: (feedId: string) => ({ whep: `/video/${feedId}/whep`, hls: `/video/${feedId}/index.m3u8` }),
    kickPublisher: async () => {},
  };
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const lines: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));

  try {
    const made = await videoService.addFeed({ name: "Narthex box", source: { kind: "push", protocol: "rtmp" } });
    assert.ok(made.ok, "a reconcile failure must not fail the add — the feed store write already succeeded");
    const id = (made as { feed: { id: string } }).feed.id;
    const updated = await videoService.updateFeed(id, { name: "Narthex" });
    assert.ok(updated.ok, "a reconcile failure must not fail the update either");
    assert.equal(
      lines.filter((l) => l.includes("could not reconcile")).length,
      1,
      "expected one line for the whole outage, not one per call",
    );

    fail = false;
    await videoService.removeFeed(id);
  } finally {
    console.warn = realWarn;
    await videoService.detachRelay();
  }
});

test("newPushPassword writes a fresh secret, reconciles, then kicks the current publisher — a kick failure is logged, not thrown, and the answer still carries the new password", async () => {
  const kicked: string[] = [];
  const reconciled: RelayFeed[][] = [];
  const relay = recordingRelay(reconciled, {
    kickPublisher: async (feedId) => {
      kicked.push(feedId);
      throw new Error("relay unreachable");
    },
  });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const lines: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));

  try {
    const made = await videoService.addFeed({ name: "ProPresenter output", source: { kind: "push", protocol: "srt" } });
    assert.ok(made.ok);
    const id = (made as { feed: { id: string } }).feed.id;
    const before = (await secretsStore.getSecrets(SECRET_SLOT(id))).password;

    const result = await videoService.newPushPassword(id);
    assert.ok(result, "expected newPushPassword to still answer even though the kick failed");
    assert.notEqual(result!.password, before, "expected a genuinely new password");
    assert.deepEqual(kicked, [id], "expected kickPublisher to be called with the feed's own id");
    assert.equal(lines.filter((l) => l.includes("could not kick")).length, 1);
  } finally {
    console.warn = realWarn;
    await videoService.detachRelay();
  }
});

test("newPushPassword and pushAddress answer null for an id outside FEED_ID_PATTERN, an unknown id, or a feed that is not push", async () => {
  const made = await videoService.addFeed({ name: "Online", source: { kind: "embed", player: "youtube-channel", ref: "UC1234567890123456789012" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  try {
    for (const badId of ["does-not-exist", "__proto__", id]) {
      assert.equal(await videoService.pushAddress(badId), null, badId);
      assert.equal(await videoService.newPushPassword(badId), null, badId);
    }
  } finally {
    await videoService.removeFeed(id);
  }
});

test("pushAddress's SRT and RTMP forms embed the password in the address; WHIP's password is the Bearer Token, prefixed video:", async () => {
  // Ports come from the feed store, not a hardcoded default — an earlier
  // test in this shared-store file (relayTarget uses the ports the relay was
  // attached with…) already rewrote it to a non-default set, which pinning
  // 8890/1935 here would have missed entirely.
  const { loadFeedsFile } = await import("./feed-store.js");
  const { ports } = await loadFeedsFile();
  for (const protocol of ["srt", "rtmp", "whip"] as const) {
    const made = await videoService.addFeed({ name: `Test ${protocol}`, source: { kind: "push", protocol } });
    assert.ok(made.ok);
    const id = (made as { feed: { id: string } }).feed.id;
    try {
      const stored = (await secretsStore.getSecrets(SECRET_SLOT(id))).password;
      assert.ok(stored, "expected addFeed to have minted a password already");
      const address = await videoService.pushAddress(id);
      assert.ok(address);
      assert.equal(address!.protocol, protocol);
      if (protocol === "srt") {
        assert.ok(address!.address.startsWith("srt://"), address!.address);
        assert.ok(address!.address.endsWith(`:${ports.srt}?streamid=publish:${id}:video:${stored}`), address!.address);
        assert.equal(address!.password, stored);
      } else if (protocol === "rtmp") {
        assert.ok(address!.address.endsWith(`:${ports.rtmp}/${id}?user=video&pass=${stored}`), address!.address);
        assert.equal(address!.password, stored);
      } else {
        assert.ok(address!.address.endsWith(`:${serverPort()}/video/${id}/whip`), address!.address);
        assert.equal(address!.password, `video:${stored}`, "expected WHIP's password to be the whole Bearer Token, user:pass");
      }
    } finally {
      await videoService.removeFeed(id);
    }
  }
});

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
const { withAllKinds } = await import("../fixtures/video-kinds.js");
const { videoSeenStore, SEEN_WRITE_INTERVAL_MS } = await import("./seen-store.js");
const { DEFAULT_SETTLE_MS } = await import("../repeat-log.js");
const { RelaySupervisor } = await import("./supervisor.js");
type RelayPath = import("./relay.js").RelayPath;
type VideoRelay = import("./relay.js").VideoRelay;
type SupervisorStatus = import("./supervisor.js").SupervisorStatus;

// Every test here shares the one videoService, and so its OutageLog: an outage
// one test leaves open would swallow, as a repeat of the same failure, the
// line a later test expects to see first. Each test starts with none open.
beforeEach(() => (videoService as unknown as { pollOutage: { forget(): void } }).pollOutage.forget());

test("a config snapshot never carries a feed's password", async () => {
  const password = "correct-horse-battery-staple";
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Lobby cam", source: { kind: "pull", url: "rtsp://192.0.2.10:8554/s", username: "admin" }, password }),
  );
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
      withAllKinds(() =>
        videoService.addFeed({ name: "Balcony cam", source: { kind: "pull", url: "rtsp://192.0.2.30/s", username: "" }, password: "pw" }),
      ),
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
// left pending until a later poll sees it ready), noteRequested()'s
// validation, relayStatus()'s mapping from the supervisor's own status
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
    videoService.attachRelay(relay, supervisor);
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
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Atrium cam", source: { kind: "pull", url: "rtsp://192.0.2.50/s", username: "" } }),
  );
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
  videoService.attachRelay(relay, supervisor);

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
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Narthex cam", source: { kind: "push", protocol: "rtmp" }, password: "pw" }),
  );
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  let answer: RelayPath[] = [readyPath({ name: id })];
  const relay = fakeRelay(async () => answer);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(relay, supervisor);

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
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Undercroft cam", source: { kind: "push", protocol: "rtmp" }, password: "pw" }),
  );
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  // H265 is "delayed" the moment it is seen ready — no B-frames mark needed.
  let answer: RelayPath[] = [readyPath({ name: id, video: { codec: "H265" } })];
  const relay = fakeRelay(async () => answer);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(relay, supervisor);

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
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Choir cam", source: { kind: "pull", url: "rtsp://192.0.2.51/s", username: "" } }),
  );
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  const readyTime = "2026-09-28T01:00:00Z";
  const relay = fakeRelay(async () => [readyPath({ name: id, readyTime })]);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(relay, supervisor);

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
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Instant cam", source: { kind: "pull", url: "rtsp://192.0.2.66/s", username: "" } }),
  );
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  const readyTime = "T-instant";

  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(fakeRelay(async () => [readyPath({ name: id, readyTime })]), supervisor);

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
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Annex cam", source: { kind: "pull", url: "rtsp://192.0.2.61/s", username: "" } }),
  );
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  const readyTime = "2026-09-28T02:00:00Z";

  let answer: RelayPath[] = [notReadyPath({ name: id })];
  const relay = fakeRelay(async () => answer);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(relay, supervisor);

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
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Pending cam", source: { kind: "pull", url: "rtsp://192.0.2.63/s", username: "" } }),
  );
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(fakeRelay(async () => [notReadyPath({ name: id })]), supervisor);

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
    videoService.attachRelay(fakeRelay(async () => [readyPath({ name: id, readyTime: "T9" })]), new FakeSupervisor());
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
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Timeout cam", source: { kind: "pull", url: "rtsp://192.0.2.64/s", username: "" } }),
  );
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  let answer: RelayPath[] = [notReadyPath({ name: id })];
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(fakeRelay(async () => answer), supervisor);

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
  videoService.attachRelay(relay, supervisor);

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
  videoService.attachRelay(relay, supervisor);

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

test("noteRequested only records a real feed id, taken from the feed list — never an arbitrary string", async () => {
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Gym cam", source: { kind: "pull", url: "rtsp://192.0.2.52/s", username: "" } }),
  );
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  await videoService.noteRequested("../../etc/passwd"); // fails FEED_ID_PATTERN outright
  await videoService.noteRequested("not-a-real-feed"); // pattern-valid, but not in the feed list

  const relay = fakeRelay(async () => [notReadyPath({ name: id })]);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(relay, supervisor);

  try {
    await pollOnce();
    let feed = (await videoService.state()).feeds.find((f) => f.id === id);
    assert.equal(feed?.status.state, "standby", "an untracked id must not count as a request for the real feed");

    await videoService.noteRequested(id);
    await pollOnce();
    feed = (await videoService.state()).feeds.find((f) => f.id === id);
    assert.equal(feed?.status.state, "offline", "a real request must move a not-ready pull feed off standby");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("relay status maps the supervisor's status and version onto the wire shape, including a null starting version before the banner is parsed", async () => {
  const relay = fakeRelay(async () => []);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(relay, supervisor);

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
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Loft cam", source: { kind: "pull", url: "rtsp://192.0.2.53/s", username: "" } }),
  );
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const relay = fakeRelay(async () => [readyPath({ name: id })]);
  const supervisor = new FakeSupervisor();
  supervisor.current = { state: "running", since: 1 };
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(relay, supervisor);

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
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Sanctum cam", source: { kind: "push", protocol: "rtmp" }, password: "pw" }),
  );
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const relay = fakeRelay(async () => [readyPath({ name: id })]);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(relay, supervisor);

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
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Vestry cam", source: { kind: "pull", url: "rtsp://192.0.2.60/s", username: "" } }),
  );
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
  videoService.attachRelay(relay, supervisor);

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
  videoService.attachRelay(relay, supervisor);

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
  videoService.attachRelay(relay, supervisor);

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
  videoService.attachRelay(relay, supervisor);

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
  videoService.attachRelay(relay, supervisor);

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
  videoService.attachRelay(relay, supervisor);

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
  videoService.attachRelay(relay, supervisor);

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
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Inflight cam", source: { kind: "push", protocol: "rtmp" }, password: "pw" }),
  );
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const supervisor = new FakeSupervisor();
  let hold = false;
  resolveA = null;
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(
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
  videoService.attachRelay(fakeRelay(() => new Promise<RelayPath[]>((_resolve, reject) => { rejectA = reject; })), supervisor);

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
  videoService.attachRelay(
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
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Ember cam", source: { kind: "push", protocol: "rtmp" }, password: "pw" }),
  );
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const relay = fakeRelay(async () => [readyPath({ name: id })]);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(relay, supervisor);

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
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Respawn cam", source: { kind: "push", protocol: "rtmp" }, password: "pw" }),
  );
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
  videoService.attachRelay(
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
  videoService.attachRelay(
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
  videoService.attachRelay(relayA, supervisorA);
  videoService.attachRelay(relayB, supervisorB); // no explicit detach in between

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
    videoService.attachRelay(relayA, supervisorA); // starts A's poll, unawaited — still pending
    await videoService.detachRelay();
    videoService.attachRelay(relayB, supervisorB); // must still take its OWN first read
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
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Race cam", source: { kind: "pull", url: "rtsp://192.0.2.70/s", username: "" } }),
  );
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  resolveA = null;
  const relayA = fakeRelay(() => new Promise<RelayPath[]>((resolve) => { resolveA = resolve; }));
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(relayA, new FakeSupervisor());
  const inFlight = pollOnce(); // A's status() is now pending, unawaited

  try {
    await videoService.detachRelay();
    videoService.attachRelay(fakeRelay(async () => [notReadyPath({ name: id })]), new FakeSupervisor());

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
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Reject cam", source: { kind: "pull", url: "rtsp://192.0.2.71/s", username: "" } }),
  );
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  rejectA = null;
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(
    fakeRelay(() => new Promise<RelayPath[]>((_resolve, reject) => { rejectA = reject; })),
    new FakeSupervisor(),
  );
  const inFlight = pollOnce(); // A's status() is now pending, unawaited

  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));

  try {
    await videoService.detachRelay();
    videoService.attachRelay(fakeRelay(async () => [readyPath({ name: id })]), new FakeSupervisor());
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
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Crypt cam", source: { kind: "pull", url: "rtsp://192.0.2.62/s", username: "" } }),
  );
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
  videoService.attachRelay(relay, supervisor);

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
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Culvert cam", source: { kind: "push", protocol: "rtmp" }, password: "pw" }),
  );
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
  const made = await withAllKinds(() => videoService.addFeed({ name, source: { kind: "push", protocol: "rtmp" }, password: "pw" }));
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const relay = fakeRelay(async () => [readyPath({ name: id })]);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(relay, supervisor);
  await pollOnce(); // records a lastSeenAt for id
  await videoService.detachRelay();

  await videoService.removeFeed(id);

  const readded = await withAllKinds(() => videoService.addFeed({ name, source: { kind: "push", protocol: "rtmp" }, password: "pw" }));
  assert.ok(readded.ok);
  const newId = (readded as { feed: { id: string } }).feed.id;
  assert.equal(newId, id, "feedIdFor() is deterministic — this only proves anything if the id really did come back");

  // A relay that has never seen this (new) feed ready — "not ready" is the
  // shape that distinguishes "waiting" from "offline"; with no relay at all,
  // every feed reads "no path", which is offline regardless of seen-store
  // history and would prove nothing either way.
  const relay2 = fakeRelay(async () => [notReadyPath({ name: newId })]);
  const supervisor2 = new FakeSupervisor();
  videoService.attachRelay(relay2, supervisor2);
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
  const made = await withAllKinds(() =>
    videoService.addFeed({ name: "Vault cam", source: { kind: "push", protocol: "rtmp" }, password: "pw" }),
  );
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  let answer: RelayPath[] = [readyPath({ name: id })];
  const relay = fakeRelay(async () => answer);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(relay, supervisor);

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

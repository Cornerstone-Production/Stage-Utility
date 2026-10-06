import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { captureConsole } from "../fixtures/capture-console.js";

// Before any store is constructed: every import below builds its stores
// against this directory, never the default data folder.
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-service-"));
process.env.STAGE_UTILITY_DATA = TMP;
const { videoService, SECRET_SLOT, STATUS_POLL_MS, PENDING_MARK_TTL_MS, RELAY_BOOT_GRACE_MS, RECENT_REQUEST_MS, videoPollDeps } =
  await import("./video-service.js");
const { PULL_START_TIMEOUT_MS } = await import("./reconcile-plan.js");
const { secretsStore } = await import("../secrets.js");
const { configSnapshot } = await import("../config-snapshot.js");
const { videoSeenStore, SEEN_WRITE_INTERVAL_MS } = await import("./seen-store.js");
const { DEFAULT_SETTLE_MS } = await import("../repeat-log.js");
const { RelaySupervisor } = await import("./supervisor.js");
const { serverPort } = await import("../server-port.js");
const { DEFAULT_VIDEO_PORTS } = await import("../../types/video.js");
const { fakeRelay } = await import("../fixtures/fake-relay.js");
type RelayPath = import("./relay.js").RelayPath;
type RelayFeed = import("./relay.js").RelayFeed;
type VideoRelay = import("./relay.js").VideoRelay;
type SupervisorStatus = import("./supervisor.js").SupervisorStatus;
type VideoPorts = import("../../types/video.js").VideoPorts;
type RelayStatus = import("../../types/video.js").RelayStatus;
type RelaySupervisorLike = import("./video-service.js").RelaySupervisorLike;

/**
 * attachRelay() with ports defaulted to DEFAULT_VIDEO_PORTS. Ports are
 * REQUIRED in production (a caller that does not know what it
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
beforeEach(() => {
  const outages = videoService as unknown as { pollOutage: { forget(): void }; sparseOutage: { forget(): void } };
  outages.pollOutage.forget();
  outages.sparseOutage.forget();
});

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

test("a pull or push feed reads standby, not offline, while no relay is attached at all (video switched off)", async () => {
  const pull = await videoService.addFeed({ name: "Off-cam pull", source: { kind: "pull", url: "rtsp://192.0.2.95/s", username: "" } });
  const push = await videoService.addFeed({ name: "Off-cam push", source: { kind: "push", protocol: "srt" } });
  assert.ok(pull.ok && push.ok);
  try {
    const feeds = (await videoService.state()).feeds;
    const pullId = (pull as { feed: { id: string } }).feed.id;
    const pushId = (push as { feed: { id: string } }).feed.id;
    assert.equal(feeds.find((f) => f.id === pullId)?.status.state, "standby", "no relay attached at all — standby, not offline");
    assert.equal(feeds.find((f) => f.id === pushId)?.status.state, "standby");
  } finally {
    await videoService.removeFeed((pull as { feed: { id: string } }).feed.id);
    await videoService.removeFeed((push as { feed: { id: string } }).feed.id);
  }
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
  const relay = fakeRelay({ status: async () => {
    calls++;
    return [];
  } });
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
  const relay = fakeRelay({ status: async () => answer });
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

test("logs a feed's live/offline transitions on the poll, once each — never on every poll", async (t) => {
  const made = await videoService.addFeed({ name: "Narthex cam", source: { kind: "push", protocol: "rtmp" }, password: "pw" });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  let answer: RelayPath[] = [readyPath({ name: id })];
  const relay = fakeRelay({ status: async () => answer });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const lines = captureConsole(t, "log");

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
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

// What "went offline" is measured against is the feed's last logged state and
// its last-seen time. A feed that now comes from somewhere else has neither.
async function liveThenEdited(
  t: import("node:test").TestContext,
  name: string,
  body: unknown,
  afterEdit: RelayPath[] | ((id: string) => RelayPath[]),
): Promise<string[]> {
  const made = await videoService.addFeed({ name, source: { kind: "pull", url: "rtsp://192.0.2.80/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  let answer: RelayPath[] = [readyPath({ name: id })];
  videoPollDeps.inDemand = () => false;
  attach(fakeRelay({ status: async () => answer }), new FakeSupervisor());
  const lines = captureConsole(t, "log");
  try {
    await pollOnce();
    assert.deepEqual(lines.filter((l) => l.includes(name)), [`[video] ${name} is live (1920×1080 H264)`]);
    answer = typeof afterEdit === "function" ? afterEdit(id) : afterEdit;
    assert.ok((await videoService.updateFeed(id, body)).ok);
    await pollOnce();
    return lines.filter((l) => l.includes(name));
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
}

test("a feed changed to another kind forgets the picture it logged for the old one: no \"went offline\" for a feed that never sent", async (t) => {
  const lines = await liveThenEdited(t, "Gym cam", { source: { kind: "push", protocol: "rtmp" } }, (id) => [notReadyPath({ name: id })]);
  assert.deepEqual(lines, ["[video] Gym cam is live (1920×1080 H264)"], "the pull feed's picture was reported gone as if the push feed had lost it");
});

test("a feed given a new address forgets the picture it logged for the old one", async (t) => {
  const lines = await liveThenEdited(t, "Atrium cam", { source: { kind: "pull", url: "rtsp://192.0.2.81/s", username: "" } }, []);
  assert.deepEqual(lines, ["[video] Atrium cam is live (1920×1080 H264)"], "the old address's picture was reported gone as if the new address had lost it");
});

test("a new login at the same address keeps what the feed logged: a picture lost afterwards is still news", async (t) => {
  const lines = await liveThenEdited(t, "Hall cam", { source: { kind: "pull", url: "rtsp://192.0.2.80/s", username: "admin" } }, []);
  assert.deepEqual(lines, ["[video] Hall cam is live (1920×1080 H264)", "[video] Hall cam went offline"]);
});

test("an import that replaces a feed with one from another address forgets the old picture, as an edit does", async (t) => {
  const made = await videoService.addFeed({ name: "Porch cam", source: { kind: "pull", url: "rtsp://192.0.2.80/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  let answer: RelayPath[] = [readyPath({ name: id })];
  videoPollDeps.inDemand = () => false;
  attach(fakeRelay({ status: async () => answer }), new FakeSupervisor());
  const lines = captureConsole(t, "log");
  try {
    await pollOnce();
    answer = [];
    const bundle = {
      kind: "stage-utility-video-feeds",
      version: 1,
      feeds: [{ id, name: "Porch cam", source: { kind: "pull", url: "rtsp://192.0.2.81/s", username: "" } }],
    };
    const reviewed = await videoService.previewImport(bundle);
    assert.ok(reviewed.ok);
    const here = reviewed.preview.feeds.find((f) => f.id === id)?.here;
    assert.ok(here, "the preview gave no fingerprint for the feed");
    const result = await videoService.importFeeds({ bundle, choices: { [id]: "replace" }, expect: { [id]: here } });
    assert.ok(result.ok && result.report.replaced.length === 1, JSON.stringify(result));
    await pollOnce();
    assert.deepEqual(
      lines.filter((l) => l.includes("Porch cam")),
      ["[video] Porch cam is live (1920×1080 H264)"],
      "the old address's picture was reported gone as if the imported address had lost it",
    );
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

// "went offline" is news once per outage, and only for a feed that was
// showing a picture: live or delayed, then offline.

test("a relay restart logs a live feed going offline once, not again as the new relay comes up", async (t) => {
  const made = await videoService.addFeed({ name: "Restart cam", source: { kind: "push", protocol: "rtmp" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  let answer: RelayPath[] = [readyPath({ name: id })];
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(fakeRelay({ status: async () => answer }), supervisor);
  const lines = captureConsole(t, "log");
  const settleStatus = () => new Promise((r) => setTimeout(r, 20));
  try {
    await pollOnce(); // live
    supervisor.current = { state: "failing", reason: "exit code 1", retryAt: 1, neverStarted: false };
    supervisor.emit("status", supervisor.current); // the relay exits: offline
    await settleStatus();
    supervisor.current = { state: "running", since: 2 };
    supervisor.emit("status", supervisor.current); // respawned: standby until it answers
    await settleStatus();
    answer = [notReadyPath({ name: id })];
    await pollOnce(); // the new relay answers: the device has not reconnected yet
    assert.equal((await videoService.state()).feeds.find((f) => f.id === id)?.status.state, "offline");
    assert.deepEqual(lines.filter((l) => l.includes("Restart cam went offline")), ["[video] Restart cam went offline"]);
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a push feed that was never live logs nothing when the relay exits", async (t) => {
  const made = await videoService.addFeed({ name: "Never-live push", source: { kind: "push", protocol: "srt" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(fakeRelay({ status: async () => [notReadyPath({ name: id })] }), supervisor);
  const lines = captureConsole(t, "log");
  try {
    await pollOnce(); // waiting
    supervisor.current = { state: "failing", reason: "exit code 1", retryAt: 1, neverStarted: false };
    supervisor.emit("status", supervisor.current);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await videoService.state()).feeds.find((f) => f.id === id)?.status.state, "offline");
    assert.deepEqual(lines.filter((l) => l.includes("Never-live push")), [], "waiting to offline is not going offline");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("logs a feed's entry into delayed too, and never prints an unknown picture", async (t) => {
  // push, not pull: a not-ready pull feed nobody has requested reads
  // "standby" (a quieter, different fact — see feed-state.ts), and this test
  // is about the "went offline" / "is live" pair either side of "delayed".
  const made = await videoService.addFeed({ name: "Undercroft cam", source: { kind: "push", protocol: "rtmp" }, password: "pw" });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  // H265 is "delayed" the moment it is seen ready — no B-frames mark needed.
  let answer: RelayPath[] = [readyPath({ name: id, video: { codec: "H265" } })];
  const relay = fakeRelay({ status: async () => answer });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const lines = captureConsole(t, "log");

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
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a B-frames close on an ALREADY-ready feed marks it delayed, and logs once per session", async (t) => {
  const made = await videoService.addFeed({ name: "Choir cam", source: { kind: "pull", url: "rtsp://192.0.2.51/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  const readyTime = "2026-09-28T01:00:00Z";
  const relay = fakeRelay({ status: async () => [readyPath({ name: id, readyTime })] });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const lines = captureConsole(t, "log");

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
  attach(fakeRelay({ status: async () => [readyPath({ name: id, readyTime })] }), supervisor);

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

test("a B-frames close on an on-demand pull feed that is not yet ready binds on the next poll that sees it ready", async (t) => {
  const made = await videoService.addFeed({ name: "Annex cam", source: { kind: "pull", url: "rtsp://192.0.2.61/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  const readyTime = "2026-09-28T02:00:00Z";

  let answer: RelayPath[] = [notReadyPath({ name: id })];
  const relay = fakeRelay({ status: async () => answer });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const lines = captureConsole(t, "log");

  try {
    await pollOnce(); // sees the not-ready path first

    supervisor.emit("line", `[WebRTC] [session bbbb2222] is reading from path '${id}'`);
    supervisor.emit("line", `[WebRTC] [session bbbb2222] closed: WebRTC doesn't support H264 streams with B-frames`);
    await new Promise((r) => setTimeout(r, 20)); // the mark is pending; there is no readyTime to bind to yet

    let feed = (await videoService.state()).feeds.find((f) => f.id === id);
    assert.notEqual(feed?.status.state, "delayed", "there is nothing to bind the mark to yet");
    // Scoped to THIS feed, not a bare `lines.length === 0`: this file shares
    // one videoFeedsStore across every test (several deliberately leave
    // their own feed behind), and one of THOSE can log its
    // own standby<->offline flap as other tests attach and detach relays
    // around it — a fact about test isolation in a shared store, not about
    // whether Annex cam's own mark was announced early.
    assert.equal(
      lines.some((l) => l.includes("Annex cam")),
      false,
      "nothing about Annex cam is announced until the mark is bound to a real readyTime",
    );

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
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a pending B-frames mark does not survive a detach — it cannot bind to a later, unrelated session", async (t) => {
  const made = await videoService.addFeed({ name: "Pending cam", source: { kind: "pull", url: "rtsp://192.0.2.63/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(fakeRelay({ status: async () => [notReadyPath({ name: id })] }), supervisor);

  const lines = captureConsole(t, "log");

  try {
    await pollOnce();
    supervisor.emit("line", `[WebRTC] [session dd44ee55] is reading from path '${id}'`);
    supervisor.emit("line", `[WebRTC] [session dd44ee55] closed: WebRTC doesn't support H264 streams with B-frames`);
    await new Promise((r) => setTimeout(r, 30));
    await pollOnce(); // still not ready — the on-demand source closed again, the mark is still pending

    await videoService.detachRelay(); // relay turned off / reconfigured

    // Hours later: a different relay, the device now reconfigured with B-frames off.
    attach(fakeRelay({ status: async () => [readyPath({ name: id, readyTime: "T9" })] }), new FakeSupervisor());
    await pollOnce();

    const feed = videoService.current().feeds.find((f) => f.id === id);
    assert.notEqual(feed?.status.state, "delayed", "an old pending mark must never bind to a session it never saw");
    assert.equal(lines.filter((l) => l.includes("B-frames")).length, 0, "no announcement belongs to the new session either");
  } finally {
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
  attach(fakeRelay({ status: async () => answer }), supervisor);

  t.mock.timers.enable({ apis: ["Date"], now: 0 });

  const lines = captureConsole(t, "log");

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
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a B-frames line for a path that is not a real feed is never logged, and never becomes a mark", async (t) => {
  // A relay path can outlive the feed it belonged to (reconcile() has not
  // yet dropped it), so "orphaned-path" is reported READY by the relay even
  // though no feed of that id exists in the store — the realistic shape of
  // the bug, not merely an id nobody's poll has ever touched.
  const relay = fakeRelay({ status: async () => [readyPath({ name: "orphaned-path" })] });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const lines = captureConsole(t, "log");

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
    await videoService.detachRelay();
  }
});

test("a relay that stops answering warns once per outage; recovery logs once after the run truly settles", async (t) => {
  let fail = true;
  const relay = fakeRelay({ status: async () => {
    if (fail) throw new Error("ECONNREFUSED");
    return [];
  } });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  // Past the supervisor's boot grace window (FakeSupervisor's "since" is 1),
  // so these failures read as the relay actually not answering.
  t.mock.timers.enable({ apis: ["Date"], now: RELAY_BOOT_GRACE_MS + 1000 });

  const lines = captureConsole(t, "warn", "log");

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
    await videoService.detachRelay();
  }
});

test("a requested pull feed reads standby while the relay dials it, offline once the dial has run out, standby again later", async (t) => {
  // The request is what starts the dial, and the first poll after it
  // routinely still finds the path not ready. Reading that as offline told
  // the widget whose request it was to give up on the session it had just
  // opened.
  const made = await videoService.addFeed({ name: "Dial cam", source: { kind: "pull", url: "rtsp://192.0.2.53/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  const relay = fakeRelay({ status: async () => [notReadyPath({ name: id })] });
  videoPollDeps.inDemand = () => false;
  attach(relay, new FakeSupervisor());
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const stateOf = async () => (await videoService.state()).feeds.find((f) => f.id === id)?.status.state;
  try {
    videoService.markRequested(id);
    await pollOnce();
    assert.equal(await stateOf(), "standby", "a pull feed still inside the relay's dial window is being dialled, not offline");

    t.mock.timers.tick(PULL_START_TIMEOUT_MS);
    await pollOnce();
    assert.equal(await stateOf(), "offline", "not ready once the dial window has run out is offline");

    t.mock.timers.tick(RECENT_REQUEST_MS - PULL_START_TIMEOUT_MS);
    await pollOnce();
    assert.equal(await stateOf(), "standby", "a request this old no longer counts");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

// Seen on a dev server, 1 Oct 2026: every pull feed logged "went offline"
// 9-15 s after "is live" as an operator switched browser tabs. A hidden tab
// stops its player; the relay closes the on-demand source ten seconds later;
// the request that had opened it was still inside its window, so the closed
// source read as a failed dial. A source that answered its request is not
// offline for being let go.
test("a pull feed the relay closed after its viewer left reads standby, not offline", async (t) => {
  const made = await videoService.addFeed({ name: "Tab cam", source: { kind: "pull", url: "rtsp://192.0.2.56/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  let answer: RelayPath[] = [notReadyPath({ name: id })];
  const relay = fakeRelay({ status: async () => answer });
  videoPollDeps.inDemand = () => false;
  attach(relay, new FakeSupervisor());
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const stateOf = async () => (await videoService.state()).feeds.find((f) => f.id === id)?.status.state;
  try {
    await pollOnce();
    videoService.markRequested(id); // the tab opens a session
    t.mock.timers.tick(2000);
    answer = [readyPath({ name: id })];
    await pollOnce();
    assert.equal(await stateOf(), "live", "sanity: the dial answered");

    answer = [notReadyPath({ name: id })]; // tab hidden, the relay closes the source
    t.mock.timers.tick(PULL_START_TIMEOUT_MS + 1000);
    await pollOnce();
    assert.equal(await stateOf(), "standby", "a source closed for want of a viewer is not offline");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a player retrying every two seconds against a dead source still reads offline once the dial window has run out", async (t) => {
  // HLS asks for its playlist every couple of seconds. Timed from the LAST
  // request, a dead source never aged past the dial window while anything
  // kept asking, and sat on standby for as long as a screen tried it.
  const made = await videoService.addFeed({ name: "Dead cam", source: { kind: "pull", url: "rtsp://192.0.2.57/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  const relay = fakeRelay({ status: async () => [notReadyPath({ name: id })] });
  videoPollDeps.inDemand = () => false;
  attach(relay, new FakeSupervisor());
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const stateOf = async () => (await videoService.state()).feeds.find((f) => f.id === id)?.status.state;
  try {
    await pollOnce();
    for (let ms = 0; ms <= PULL_START_TIMEOUT_MS; ms += 2000) {
      videoService.markRequested(id);
      t.mock.timers.tick(2000);
    }
    await pollOnce();
    assert.equal(await stateOf(), "offline");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a dead source asked for again after its requests lapsed is dialled afresh, not offline at once", async (t) => {
  const made = await videoService.addFeed({ name: "Again cam", source: { kind: "pull", url: "rtsp://192.0.2.58/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  const relay = fakeRelay({ status: async () => [notReadyPath({ name: id })] });
  videoPollDeps.inDemand = () => false;
  attach(relay, new FakeSupervisor());
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const stateOf = async () => (await videoService.state()).feeds.find((f) => f.id === id)?.status.state;
  try {
    await pollOnce();
    videoService.markRequested(id);
    t.mock.timers.tick(RECENT_REQUEST_MS + 30_000);
    await pollOnce();
    assert.equal(await stateOf(), "standby", "sanity: the old request has lapsed");

    videoService.markRequested(id);
    await pollOnce();
    assert.equal(await stateOf(), "standby", "a new request is a new dial, still inside its window");
    t.mock.timers.tick(PULL_START_TIMEOUT_MS);
    await pollOnce();
    assert.equal(await stateOf(), "offline", "and offline once that dial has run out");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

// Seen on a dev server, 1 Oct 2026: BOX pointed at another feed's encoder,
// which answers an unknown path's DESCRIBE with silence. The screen warned;
// the server said nothing, so the relay looked fine and the address was the
// last thing anyone checked.
test("a pull feed whose device never answers is one warning per outage, naming the address, and one line when it does", async (t) => {
  const made = await videoService.addFeed({ name: "Box cam", source: { kind: "pull", url: "rtsp://192.0.2.59:554/BOX", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  let answer: RelayPath[] = [notReadyPath({ name: id })];
  const relay = fakeRelay({ status: async () => answer });
  videoPollDeps.inDemand = () => false;
  attach(relay, new FakeSupervisor());
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const lines = captureConsole(t, "warn", "log");
  const dial = () => lines.filter((l) => l.includes("Box cam:"));
  try {
    await pollOnce();
    for (let attempt = 0; attempt < 3; attempt++) {
      videoService.markRequested(id); // a screen retrying, each attempt after the last lapsed
      t.mock.timers.tick(PULL_START_TIMEOUT_MS);
      await pollOnce();
      t.mock.timers.tick(RECENT_REQUEST_MS);
      await pollOnce();
    }
    assert.deepEqual(dial(), [
      "[video] Box cam: nothing from rtsp://192.0.2.59:554/BOX within 10 s of the relay asking — check the device is on and the address and path are right",
    ]);

    answer = [readyPath({ name: id })]; // the address corrected, say
    await pollOnce();
    t.mock.timers.tick(DEFAULT_SETTLE_MS + 1000);
    await pollOnce();
    assert.equal(dial().length, 2);
    assert.match(dial()[1]!, /^\[video\] Box cam: the device is answering again/);
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a pull feed removed mid-outage and added again under the same name logs its first failure afresh", async (t) => {
  const body = { name: "Rerun cam", source: { kind: "pull", url: "rtsp://192.0.2.57/s", username: "" } };
  const first = await videoService.addFeed(body);
  assert.ok(first.ok);
  const id = (first as { feed: { id: string } }).feed.id;
  let current = id;
  const relay = fakeRelay({ status: async () => [notReadyPath({ name: current })] });
  videoPollDeps.inDemand = () => false;
  attach(relay, new FakeSupervisor());
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const lines = captureConsole(t, "warn", "log");
  const dial = () => lines.filter((l) => l.includes("Rerun cam:"));
  const dialOnce = async (): Promise<void> => {
    await pollOnce();
    videoService.markRequested(current);
    t.mock.timers.tick(PULL_START_TIMEOUT_MS);
    await pollOnce();
  };
  try {
    await dialOnce();
    assert.equal(dial().length, 1, "sanity: the first feed's dial failure is logged");

    await videoService.removeFeed(id);
    const second = await videoService.addFeed(body);
    assert.ok(second.ok);
    current = (second as { feed: { id: string } }).feed.id;
    assert.equal(current, id, "sanity: the same name mints the same id");
    // The add reconciled the relay, which starts a poll of its own; one still in
    // flight would swallow the poll below.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    t.mock.timers.tick(RECENT_REQUEST_MS);
    await dialOnce();
    assert.equal(dial().length, 2, "the re-added feed's first failure was swallowed as a repeat of the deleted feed's");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(current);
  }
});

// Driven on the real binary: after a respawn the first poll finds no paths,
// and a pull feed read offline (so a screen did not ask for it) until the
// poll after the reconcile, up to STATUS_POLL_MS later.
test("a successful reconcile is followed by a poll, so a feed it just set up reads from the relay at once", async () => {
  const made = await videoService.addFeed({ name: "Reconcile cam", source: { kind: "pull", url: "rtsp://192.0.2.55/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  let paths: RelayPath[] = [];
  const relay = fakeRelay({
    status: async () => paths,
    reconcile: async (feeds) => {
      paths = feeds.map((f) => notReadyPath({ name: f.id }));
    },
  });
  videoPollDeps.inDemand = () => false;
  attach(relay, new FakeSupervisor());
  const stateOf = async () => (await videoService.state()).feeds.find((f) => f.id === id)?.status.state;
  try {
    await pollOnce();
    assert.equal(await stateOf(), "offline", "sanity: a polled relay with no path for the feed");
    assert.equal(await videoService.reconcileRelay(), true);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(await stateOf(), "standby");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

// Driven on the real binary: a screen that connected eleven seconds before
// the relay was killed found the pull feed offline after the respawn, and
// waited out the rest of the old request's window before asking again.
test("a request made to the previous relay process does not count against a respawned one", async (t) => {
  const made = await videoService.addFeed({ name: "Respawn cam", source: { kind: "pull", url: "rtsp://192.0.2.54/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  const relay = fakeRelay({ status: async () => [notReadyPath({ name: id })] });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const stateOf = async () => (await videoService.state()).feeds.find((f) => f.id === id)?.status.state;
  try {
    videoService.markRequested(id);
    t.mock.timers.tick(PULL_START_TIMEOUT_MS + 1000);
    await pollOnce();
    assert.equal(await stateOf(), "offline", "sanity: the old process had its whole dial window");

    supervisor.current = { state: "running", since: Date.now() };
    supervisor.emit("status", supervisor.current); // killed and respawned
    await pollOnce();
    assert.equal(await stateOf(), "standby", "nothing has asked the new process for this feed yet");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("markRequested moves a not-ready pull feed off standby — its only observable effect", async (t) => {
  // Validation lives at the call site now (relayTarget(), which the proxy
  // calls before markRequested() — see video-proxy-routes.ts and its own
  // relayTarget-refusal tests): markRequested() itself is a trusted,
  // synchronous setter with nothing to reject, so there is no "unknown id"
  // or "pattern-failing id" case left to prove here.
  const made = await videoService.addFeed({ name: "Gym cam", source: { kind: "pull", url: "rtsp://192.0.2.52/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const relay = fakeRelay({ status: async () => [notReadyPath({ name: id })] });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  try {
    await pollOnce();
    let feed = (await videoService.state()).feeds.find((f) => f.id === id);
    assert.equal(feed?.status.state, "standby", "nothing has asked for this feed yet");

    t.mock.timers.enable({ apis: ["Date"], now: 2_000_000 });
    videoService.markRequested(id);
    t.mock.timers.tick(PULL_START_TIMEOUT_MS);
    await pollOnce();
    feed = (await videoService.state()).feeds.find((f) => f.id === id);
    assert.equal(feed?.status.state, "offline", "a real request must move a not-ready pull feed off standby");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

// ── relayTarget() — what the playback proxy is allowed to reach ───────────

const NOT_RUNNING = { refuse: 503, error: "The video relay is not running" };
const NOT_GIVEN = { refuse: 503, error: "The video relay has not been given this feed yet" };

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
  const relay = fakeRelay({ status: async () => [] });
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
    assert.deepEqual(videoService.relayTarget(id, "whep"), NOT_RUNNING);
    assert.deepEqual(videoService.relayTarget(id, "hls"), NOT_RUNNING);

    const relay = fakeRelay({ status: async () => [] });
    const supervisor = new FakeSupervisor();
    supervisor.current = { state: "starting" };
    videoPollDeps.inDemand = () => false;
    attach(relay, supervisor);
    // attachRelay() itself does not publish (see its own comment) — force one
    // so the snapshot relayTarget reads picks up "starting" without waiting
    // on a poll. publish() is private; reached the same way pollOnce() above is.
    await (videoService as unknown as { publish(): Promise<void> }).publish();
    assert.deepEqual(videoService.relayTarget(id, "whep"), NOT_RUNNING, "starting is not running either");

    supervisor.current = { state: "running", since: Date.now() };
    await videoService.reconcileRelay();
    await (videoService as unknown as { publish(): Promise<void> }).publish();
    assert.deepEqual(videoService.relayTarget(id, "hls"), { host: "127.0.0.1", port: 8888, path: `/${id}` });
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

// A relay process starts with no paths at all (mediamtx.yml carries
// `paths: {}`); each feed's path arrives with the first reconcile. Until it
// does, the real v1.21.1 binary answers a WHEP offer 400 "path '<id>' is not
// configured", which a screen reads as the relay refusing the feed's encoder
// and falls back to HLS for — so the proxy must not forward there yet.
test("relayTarget answers 503 for a running relay until a reconcile has handed it this feed, and again after a respawn", async () => {
  const made = await videoService.addFeed({ name: "Stage left", source: { kind: "pull", url: "rtsp://192.0.2.62/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(fakeRelay(), supervisor);
  const publish = () => (videoService as unknown as { publish(): Promise<void> }).publish();
  const whep = { host: "127.0.0.1", port: 8889, path: `/${id}/whep` };
  try {
    await publish();
    assert.deepEqual(videoService.relayTarget(id, "whep"), NOT_GIVEN, "running, but not reconciled yet");

    assert.equal(await videoService.reconcileRelay(), true);
    assert.deepEqual(videoService.relayTarget(id, "whep"), whep);

    supervisor.current = { state: "running", since: 2 };
    supervisor.emit("status", supervisor.current); // a respawned process: no paths again
    await publish();
    assert.deepEqual(videoService.relayTarget(id, "whep"), NOT_GIVEN, "the new process has not been reconciled");

    assert.equal(await videoService.reconcileRelay(), true);
    assert.deepEqual(videoService.relayTarget(id, "whep"), whep);
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a reconcile that finishes after a respawn does not count for the new process", async () => {
  const made = await videoService.addFeed({ name: "Stage right", source: { kind: "pull", url: "rtsp://192.0.2.65/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  let release: () => void = () => {};
  const relay = fakeRelay({ reconcile: () => new Promise<void>((resolve) => (release = resolve)) });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);
  try {
    const pending = videoService.reconcileRelay();
    await new Promise((r) => setImmediate(r)); // into relay.reconcile()
    supervisor.current = { state: "running", since: 2 };
    supervisor.emit("status", supervisor.current); // the process it was talking to is gone
    release();
    await pending;
    await (videoService as unknown as { publish(): Promise<void> }).publish();
    assert.deepEqual(videoService.relayTarget(id, "whep"), NOT_GIVEN);
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("relayTarget keeps answering 503 for a feed the last reconcile failed to hand the relay", async () => {
  let fail = false;
  const relay = fakeRelay({
    reconcile: async () => {
      if (fail) throw new Error("MediaMTX answered 500");
    },
  });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);
  const first = await videoService.addFeed({ name: "Choir", source: { kind: "pull", url: "rtsp://192.0.2.63/s", username: "" } });
  assert.ok(first.ok);
  const firstId = (first as { feed: { id: string } }).feed.id;
  fail = true;
  const second = await videoService.addFeed({ name: "Balcony two", source: { kind: "pull", url: "rtsp://192.0.2.64/s", username: "" } });
  assert.ok(second.ok);
  const secondId = (second as { feed: { id: string } }).feed.id;
  try {
    await (videoService as unknown as { publish(): Promise<void> }).publish();
    assert.deepEqual(videoService.relayTarget(firstId, "hls"), { host: "127.0.0.1", port: 8888, path: `/${firstId}` });
    assert.deepEqual(videoService.relayTarget(secondId, "hls"), NOT_GIVEN);
  } finally {
    fail = false;
    await videoService.detachRelay();
    await videoService.removeFeed(firstId);
    await videoService.removeFeed(secondId);
  }
});

test("a reconcile that rejects one feed's path still hands the relay the others, and is retried", async (t) => {
  const { RelayReconcileError } = await import("./relay.js");
  // The id a feed named "Foyer" mints. The relay rejects its path from the very
  // first reconcile, so nothing has ever marked either feed as given.
  let failId: string | null = "foyer";
  const relay = fakeRelay({
    reconcile: async () => {
      if (failId !== null) {
        throw new RelayReconcileError(`could not set up 1 of 2 relay paths (${failId}: MediaMTX answered 500)`, [failId]);
      }
    },
  });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);
  const lines = captureConsole(t, "warn"); // before the adds: the first failed reconcile is the one logged
  const first = await videoService.addFeed({ name: "Narthex", source: { kind: "pull", url: "rtsp://192.0.2.66/s", username: "" } });
  const second = await videoService.addFeed({ name: "Foyer", source: { kind: "pull", url: "rtsp://192.0.2.67/s", username: "" } });
  assert.ok(first.ok && second.ok);
  const firstId = (first as { feed: { id: string } }).feed.id;
  const secondId = (second as { feed: { id: string } }).feed.id;
  assert.equal(secondId, "foyer", "the test's rejected path is the second feed's id");
  try {
    assert.equal(await videoService.reconcileRelay(), false, "a partial failure is still a failed reconcile, so the readiness poll retries");
    await (videoService as unknown as { publish(): Promise<void> }).publish();
    assert.deepEqual(videoService.relayTarget(firstId, "hls"), { host: "127.0.0.1", port: 8888, path: `/${firstId}` }, "the feed whose path was set up must play");
    assert.deepEqual(videoService.relayTarget(secondId, "hls"), NOT_GIVEN, "the feed whose path was rejected stays refused");
    assert.ok(
      lines.some((line) => line.includes("[video] could not reconcile the relay") && line.includes(secondId)),
      `the failure must be logged on a [video] line: ${JSON.stringify(lines)}`,
    );

    failId = null;
    assert.equal(await videoService.reconcileRelay(), true);
    assert.notDeepEqual(videoService.relayTarget(secondId, "hls"), NOT_GIVEN, "the retry hands the relay the feed");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(firstId);
    await videoService.removeFeed(secondId);
  }
});

// relayTarget() must forward to the ports the RUNNING
// relay was actually STARTED with, never the store's current ports — a
// ports change (PATCH /api/video/ports) writes the store at once,
// but the relay process itself keeps listening on its old ports until it
// restarts, and a poll landing in that gap must not point the proxy at a
// port nothing is listening on yet.
test("relayTarget uses the ports the relay was attached with, even after the store's own ports change under it", async () => {
  const { videoFeedsStore } = await import("./feed-store.js");
  const made = await videoService.addFeed({ name: "Dock cam", source: { kind: "pull", url: "rtsp://192.0.2.70/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const OLD_PORTS = { rtmp: 11935, srt: 18890, webrtcUdp: 18189, webrtcHttp: 18889, hls: 18888, api: 19997 };
  const relay = fakeRelay({ status: async () => [] });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor, OLD_PORTS);
  try {
    await videoService.reconcileRelay();
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
    // A poll/publish after the store write — the moment a proxy reading the
    // store would point at a port the relay is not listening on yet.
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
  const relay = fakeRelay({ status: async () => [] });
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

    supervisor.current = { state: "failing", reason: "port in use", retryAt: 12345, neverStarted: false };
    assert.deepEqual((await videoService.state()).relay, { state: "failing", reason: "port in use", kind: "crash-loop", retryAt: 12345 });
  } finally {
    await videoService.detachRelay();
  }
});

test("detachRelay reports the relay off and forgets its last known paths — a stale answer must not linger", async () => {
  const made = await videoService.addFeed({ name: "Loft cam", source: { kind: "pull", url: "rtsp://192.0.2.53/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const relay = fakeRelay({ status: async () => [readyPath({ name: id })] });
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
    // A detached relay is "off", not merely "no path yet" — standby
    // (neutral), not a red "offline" — not the same as a relay that has
    // simply never reconciled this feed, which is what this test proves.
    assert.equal(feed?.status.state, "standby");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("detachRelay settles feeds — flushes the seen store, not just a bare publish; the transition itself is to standby, not offline, so no \"went offline\" line fires", async (t) => {
  const made = await videoService.addFeed({ name: "Sanctum cam", source: { kind: "push", protocol: "rtmp" }, password: "pw" });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const relay = fakeRelay({ status: async () => [readyPath({ name: id })] });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  t.mock.timers.enable({ apis: ["Date"], now: 0 });

  const lines = captureConsole(t, "log");

  try {
    await pollOnce(); // t=0 — the first-ever write always lands
    t.mock.timers.tick(SEEN_WRITE_INTERVAL_MS - 1000); // t=59_000 — still inside the throttle window
    await pollOnce(); // still live — this write would be throttled away by noteSeen() alone
    const beforeDetach = lines.length; // the earlier "is live" poll also names "Sanctum cam"

    await videoService.detachRelay(); // t=59_000 — must settle, not just publish

    // Detaching the relay is a transition to "standby" (video
    // switched off), not "offline" — logTransition() has no "went to
    // standby" line, so nothing here claims the SOURCE dropped when it was
    // Stage Utility that stopped asking. The seen-store flush below is the
    // part of "settle" that still must happen regardless of what state the
    // transition lands on.
    assert.equal(
      lines.slice(beforeDetach).some((l) => l.includes("Sanctum cam")),
      false,
      "a deliberate detach must not log a per-feed \"went offline\" — nothing about the SOURCE changed",
    );
    const onDisk = (await videoSeenStore.reload())[id];
    assert.equal(
      onDisk,
      SEEN_WRITE_INTERVAL_MS - 1000,
      "the flush must carry the LATEST in-memory value, not the throttled-away first write",
    );
  } finally {
    await videoService.removeFeed(id);
  }
});

test("a poll that fails clears lastPaths and reports the relay as failing to answer", async () => {
  const made = await videoService.addFeed({ name: "Vestry cam", source: { kind: "pull", url: "rtsp://192.0.2.60/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  let fail = false;
  const relay = fakeRelay({ status: async () => {
    if (fail) throw new Error("ECONNREFUSED");
    return [readyPath({ name: id })];
  } });
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
    assert.deepEqual(failed.relay, { state: "failing", reason: "The relay is not answering", kind: "not-answering", retryAt: null });

    await videoService.detachRelay();
    assert.deepEqual(videoService.current().relay, { state: "off" });
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a poll that fails within the supervisor's own boot grace window does not flip the relay to not answering, and logs nothing", async (t) => {
  const relay = fakeRelay({ status: async () => {
    throw new Error("ECONNREFUSED");
  } });
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

  const warns = captureConsole(t, "warn");

  try {
    await pollOnce();
    assert.equal(videoService.current().relay.state, "running", "still within the boot grace window");
    assert.equal(warns.length, 0, "nothing worth logging while the relay is still starting up");
  } finally {
    await videoService.detachRelay();
  }
});

test("a poll that fails after the supervisor's own boot grace window flips the relay to not answering, and logs once", async (t) => {
  const relay = fakeRelay({ status: async () => {
    throw new Error("ECONNREFUSED");
  } });
  const supervisor = new FakeSupervisor();
  supervisor.current = { state: "running", since: 0 };
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  t.mock.timers.tick(RELAY_BOOT_GRACE_MS + 1000); // 1 s past the grace

  const warns = captureConsole(t, "warn");

  try {
    await pollOnce();
    assert.deepEqual(videoService.current().relay, { state: "failing", reason: "The relay is not answering", kind: "not-answering", retryAt: null });
    assert.equal(warns.filter((l) => l.includes("not answering")).length, 1);
  } finally {
    await videoService.detachRelay();
  }
});

test("the service does not poll while the supervisor is off, so a relay switched off produces no \"not answering\" line", async (t) => {
  let calls = 0;
  const relay = fakeRelay({ status: async () => {
    calls++;
    throw new Error("ECONNREFUSED");
  } });
  const supervisor = new FakeSupervisor();
  supervisor.current = { state: "off" };
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const warns = captureConsole(t, "warn");

  try {
    await pollOnce();
    assert.equal(calls, 0, "an off supervisor must never even be asked — the poll loop checks it first, before any relay.status() call");
    assert.deepEqual(videoService.current().relay, { state: "off" });
    assert.equal(warns.filter((l) => l.includes("not answering")).length, 0, "an off relay must never log as not answering");
  } finally {
    await videoService.detachRelay();
  }
});

test("a relay the supervisor already reports failing keeps its own reason, and logs no \"not answering\" line", async (t) => {
  const relay = fakeRelay({ status: async () => {
    throw new Error("ECONNREFUSED");
  } });
  const supervisor = new FakeSupervisor();
  supervisor.current = { state: "failing", reason: "Port 1935 is in use by OBS.", retryAt: 55555, neverStarted: false };
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const warns = captureConsole(t, "warn");

  try {
    await pollOnce(); // also fails to answer — the supervisor's own diagnosis still wins
    assert.deepEqual(videoService.current().relay, { state: "failing", reason: "Port 1935 is in use by OBS.", kind: "crash-loop", retryAt: 55555 });
    assert.deepEqual(
      warns.filter((l) => l.includes("not answering")),
      [],
      "the supervisor has already logged why it is failing; a poll must not add a second line",
    );
  } finally {
    await videoService.detachRelay();
  }
});

// The relay status reaches every LAN client (video:state, the integration
// row), so this server's data-folder path never does: a path inside it reads
// relative to it, and the full path stays in the server log.
test("a failing relay's reason and hand-place folder never carry the data-folder path", async () => {
  const relay = fakeRelay({ status: async () => [] });
  const supervisor = new FakeSupervisor();
  supervisor.current = {
    state: "failing",
    reason: `open ${path.join(TMP, "video-relay", "mediamtx.yml")}: permission denied`,
    retryAt: 55555,
    neverStarted: false,
  };
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);
  try {
    await pollOnce();
    const status = (await videoService.state()).relay;
    assert.equal(JSON.stringify(status).includes(TMP), false, `the data-folder path reached the relay status: ${JSON.stringify(status)}`);
    assert.equal((status as { reason: string }).reason, `open ${path.join("video-relay", "mediamtx.yml")}: permission denied`);
  } finally {
    await videoService.detachRelay();
  }

  videoService.setPreAttachStatus({
    state: "failing",
    reason: `hand-placed archive at ${path.join(TMP, "video-relay", "downloads", "m.tar.gz")} does not match`,
    kind: "download",
    retryAt: 55555,
    placeArchiveAt: path.join(TMP, "video-relay", "downloads"),
    assetName: "m.tar.gz",
  });
  try {
    const status = (await videoService.state()).relay as { reason: string; placeArchiveAt?: string };
    assert.equal(JSON.stringify(status).includes(TMP), false, `the data-folder path reached the relay status: ${JSON.stringify(status)}`);
    assert.equal(status.placeArchiveAt, path.join("video-relay", "downloads"));
    assert.equal(status.reason, `hand-placed archive at ${path.join("video-relay", "downloads", "m.tar.gz")} does not match`);
  } finally {
    videoService.setPreAttachStatus(null);
  }
});

test("a relay reporting \"failing\" (was running, crashed) reads a feed with no path as offline, not standby — it is up enough to have an opinion", async () => {
  const relay = fakeRelay({ status: async () => [] });
  const supervisor = new FakeSupervisor();
  supervisor.current = { state: "failing", reason: "Port 1935 is in use by OBS.", retryAt: 55555, neverStarted: false };
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const made = await videoService.addFeed({ name: "Failing-relay push", source: { kind: "push", protocol: "srt" } });
  assert.ok(made.ok);
  try {
    const feed = (await videoService.state()).feeds.find((f) => f.id === (made as { feed: { id: string } }).feed.id);
    assert.equal(feed?.status.state, "offline", "failing counts as \"up\" — the relay has an opinion, even a bad one");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed((made as { feed: { id: string } }).feed.id);
  }
});

// The OPPOSITE case from the test
// above — "failing" reported through setPreAttachStatus() (a busy port, a
// failed download — relay-lifecycle.ts's own pre-supervisor sequence, which
// never got as far as a child process existing at all) must NOT count as
// "up": nothing could ever have received a source, so a feed reads
// standby, never a red "offline" implying its device stopped sending.
test("a PRE-supervisor failure (a busy port, no process has ever run) reads a feed as standby, never offline", async () => {
  videoService.setPreAttachStatus({
    state: "failing",
    reason: "Port 1935 is in use by OBS Studio.",
    kind: "port-conflict",
    retryAt: 55555,
  });
  const made = await videoService.addFeed({ name: "Pre-supervisor push", source: { kind: "push", protocol: "srt" } });
  assert.ok(made.ok);
  try {
    const feed = (await videoService.state()).feeds.find((f) => f.id === (made as { feed: { id: string } }).feed.id);
    assert.equal(
      feed?.status.state,
      "standby",
      "no process has ever run in this outage — nothing could have received a source",
    );
  } finally {
    videoService.setPreAttachStatus(null);
    await videoService.removeFeed((made as { feed: { id: string } }).feed.id);
  }
});

// A spawn failure (the supervisor's own
// child 'error' with no pid) used to surface as "failing" with kind
// "crash-loop" — the SAME kind as a process that genuinely ran and
// exited — so a feed read "offline" even though nothing could ever have
// reached a source. neverStarted distinguishes the two; this is the
// spawn-failure half, reading standby like every other pre-process kind.
test("a spawn failure (neverStarted) reads kind 'spawn' and a feed as standby, not crash-loop/offline", async () => {
  const relay = fakeRelay({ status: async () => [] });
  const supervisor = new FakeSupervisor();
  supervisor.current = { state: "failing", reason: "could not start: spawn mediamtx ENOENT", retryAt: 55555, neverStarted: true };
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const made = await videoService.addFeed({ name: "Spawn-failure push", source: { kind: "push", protocol: "srt" } });
  assert.ok(made.ok);
  try {
    const snap = await videoService.state();
    assert.equal(snap.relay.state, "failing");
    if (snap.relay.state === "failing") assert.equal(snap.relay.kind, "spawn");
    const feed = snap.feeds.find((f) => f.id === (made as { feed: { id: string } }).feed.id);
    assert.equal(feed?.status.state, "standby", "a spawn failure means nothing ever ran — never offline");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed((made as { feed: { id: string } }).feed.id);
  }
});

test("between the supervisor reaching running and the first successful poll, a relay feed stays standby with no \"went offline\" line; the first successful poll with no path for it is what flips it to offline, with exactly one line", async (t) => {
  const relay = fakeRelay({ status: async () => [] }); // no path ever matches this feed
  const supervisor = new FakeSupervisor();
  supervisor.current = { state: "off" };
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const made = await videoService.addFeed({ name: "Boot window push", source: { kind: "push", protocol: "srt" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const lines = captureConsole(t, "log");

  try {
    supervisor.current = { state: "starting" };
    supervisor.emit("status", supervisor.current);
    await new Promise((r) => setTimeout(r, 20));
    let feed = videoService.current().feeds.find((f) => f.id === id);
    assert.equal(feed?.status.state, "standby", "still starting — nothing has answered a poll yet");

    supervisor.current = { state: "running", since: 0 };
    supervisor.emit("status", supervisor.current);
    await new Promise((r) => setTimeout(r, 20));
    feed = videoService.current().feeds.find((f) => f.id === id);
    assert.equal(feed?.status.state, "standby", "just reached running — no poll has answered for THIS process yet");
    assert.equal(
      lines.filter((l) => l.includes("Boot window push")).length,
      0,
      "reaching running with no poll yet must log nothing about this feed",
    );

    await pollOnce(); // the first successful poll — no path for this feed
    feed = videoService.current().feeds.find((f) => f.id === id);
    assert.equal(feed?.status.state, "offline", "the relay has now genuinely answered, and has no path for this feed");
    assert.equal(
      lines.filter((l) => l.includes("Boot window push went offline")).length,
      0,
      "a feed that was never live did not go offline",
    );
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("the \"not answering\" override never applies while starting, even with a version left over from a previous run, and logs nothing", async (t) => {
  const relay = fakeRelay({ status: async () => {
    throw new Error("ECONNREFUSED");
  } });
  const supervisor = new FakeSupervisor();
  supervisor.current = { state: "starting" };
  supervisor.ver = "v1.21.1"; // leftover from a PREVIOUS run — version() never resets on its own
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const warns = captureConsole(t, "warn");

  try {
    await pollOnce(); // fails to answer — there is no live child yet to BE "not answering"
    assert.deepEqual(
      videoService.current().relay,
      { state: "starting", version: "v1.21.1" },
      "starting must never read as failing, however long ago the leftover version was logged",
    );
    assert.deepEqual(warns.filter((l) => l.includes("not answering")), [], "a relay still starting has nothing to answer with yet");
  } finally {
    await videoService.detachRelay();
  }
});

test("the attached supervisor's status events publish immediately, without waiting for a poll", async () => {
  const relay = fakeRelay({ status: async () => [] });
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
    supervisor.current = { state: "failing", reason: "boom", retryAt: 999, neverStarted: false };
    supervisor.emit("status", supervisor.current);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(frames.length > before, "every status event must publish, not only the first");
    assert.deepEqual(frames.at(-1)?.relay, { state: "failing", reason: "boom", kind: "crash-loop", retryAt: 999 });
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
    fakeRelay({ status: () =>
      hold ? new Promise<RelayPath[]>((resolve) => { resolveA = resolve; }) : Promise.resolve([readyPath({ name: id })]), }),
    supervisor,
  );

  try {
    await pollOnce();
    assert.equal(videoService.current().feeds.find((f) => f.id === id)?.status.state, "live");

    hold = true;
    const inFlight = pollOnce(); // request sent to the process now about to be reported crashed

    supervisor.current = { state: "failing", reason: "crashed", retryAt: 1, neverStarted: false };
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

test("an in-flight REJECTION against the old process, landing after a respawn, does not mark the new process not answering", async (t) => {
  const supervisor = new FakeSupervisor();
  rejectA = null;
  videoPollDeps.inDemand = () => false;
  attach(fakeRelay({ status: () => new Promise<RelayPath[]>((_resolve, reject) => { rejectA = reject; }) }), supervisor);

  const warns = captureConsole(t, "warn");

  try {
    const inFlight = pollOnce(); // against the old (hung) process

    supervisor.current = { state: "failing", reason: "crashed", retryAt: 1, neverStarted: false };
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
    await videoService.detachRelay();
  }
});

test("a status change alone, with no detach, still lets the next poll run even while the previous one is stuck", async () => {
  const supervisor = new FakeSupervisor();
  let calls = 0;
  videoPollDeps.inDemand = () => false;
  attach(
    fakeRelay({ status: () => {
      calls++;
      if (calls === 1) return new Promise<RelayPath[]>(() => {}); // the first request never resolves
      return Promise.resolve([]);
    } }),
    supervisor,
  );

  try {
    void pollOnce(); // the first poll hangs forever
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls, 1);

    supervisor.current = { state: "failing", reason: "crashed", retryAt: 1, neverStarted: false };
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

  const relay = fakeRelay({ status: async () => [readyPath({ name: id })] });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  try {
    await pollOnce();
    assert.equal(videoService.current().feeds.find((f) => f.id === id)?.status.state, "live");

    // The supervisor's OWN crash detection reports failing — no new poll has run.
    supervisor.current = { state: "failing", reason: "crashed", retryAt: 123, neverStarted: false };
    supervisor.emit("status", supervisor.current);
    await new Promise((r) => setTimeout(r, 20));

    const snap = videoService.current();
    assert.equal(
      snap.feeds.find((f) => f.id === id)?.status.state,
      "offline",
      "a dead process's feed must not still read live just because no poll has run against it yet",
    );
    assert.deepEqual(snap.relay, { state: "failing", reason: "crashed", kind: "crash-loop", retryAt: 123 });
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

// The moment the relay's process exits, every client is told it is failing:
// the published state goes failing at the exit itself, not at the next poll
// (which nothing may be running), and "running" again only once the
// respawn after the backoff has actually happened. Measured on a real relay
// killed with SIGKILL: failing at 0.01 s, running at 1.09 s.
test("against a real supervisor: an exit publishes failing at once, and running only with the respawn", async () => {
  const children: FakeChild[] = [];
  const sup = new RelaySupervisor({
    spawnImpl: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    psImpl: async () => null,
  });
  const { addBroadcastListener } = await import("../broadcaster.js");
  const published: string[] = [];
  let recording = false;
  addBroadcastListener((channel, payload) => {
    if (recording && channel === "video:state") published.push((payload as { relay: { state: string } }).relay.state);
  });
  videoPollDeps.inDemand = () => false;
  attach(fakeRelay({ status: async () => [] }), sup);
  try {
    await sup.start("/bin/mediamtx", "/tmp/cfg.yml");
    await new Promise((r) => setTimeout(r, 20));
    recording = true;
    children[0]!.emit("exit", null, "SIGKILL");
    await new Promise((r) => setTimeout(r, 50)); // well inside the 1 s backoff
    assert.deepEqual(published, ["failing"], "the exit must reach every client before anything else happens");
    await new Promise((r) => setTimeout(r, 1100)); // the respawn
    assert.deepEqual(published, ["failing", "running"]);
  } finally {
    recording = false;
    await videoService.detachRelay();
    await sup.stop();
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
    fakeRelay({ status: async () => {
      if (!apiUp) throw new Error("ECONNREFUSED");
      return [readyPath({ name: id })];
    } }),
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

test("against a real supervisor: a poll failing during its crash backoff logs no \"not answering\" line after the supervisor's own exit line", async (t) => {
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
    fakeRelay({ status: async () => {
      throw new Error("ECONNREFUSED");
    } }),
    sup,
  );

  const warns = captureConsole(t, "warn");

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
    await videoService.detachRelay();
    await sup.stop();
  }
});

test("attaching a new relay without detaching first replaces the old one's listeners rather than leaking them", async () => {
  const relayA = fakeRelay({ status: async () => [] });
  const supervisorA = new FakeSupervisor();
  const relayB = fakeRelay({ status: async () => [] });
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
  const relayA = fakeRelay({ status: () =>
      new Promise<RelayPath[]>((resolve) => {
        resolveA = resolve;
      }), });
  const supervisorA = new FakeSupervisor();

  let bCalls = 0;
  const relayB = fakeRelay({ status: async () => {
    bCalls++;
    return [];
  } });
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
  const relayA = fakeRelay({ status: () => new Promise<RelayPath[]>((resolve) => { resolveA = resolve; }) });
  videoPollDeps.inDemand = () => false;
  attach(relayA, new FakeSupervisor());
  const inFlight = pollOnce(); // A's status() is now pending, unawaited

  try {
    await videoService.detachRelay();
    attach(fakeRelay({ status: async () => [notReadyPath({ name: id })] }), new FakeSupervisor());

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

test("a stale in-flight REJECTION from an already-detached relay does not mark the new relay not answering", async (t) => {
  const made = await videoService.addFeed({ name: "Reject cam", source: { kind: "pull", url: "rtsp://192.0.2.71/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  rejectA = null;
  videoPollDeps.inDemand = () => false;
  attach(
    fakeRelay({ status: () => new Promise<RelayPath[]>((_resolve, reject) => { rejectA = reject; }) }),
    new FakeSupervisor(),
  );
  const inFlight = pollOnce(); // A's status() is now pending, unawaited

  const warns = captureConsole(t, "warn");

  try {
    await videoService.detachRelay();
    attach(fakeRelay({ status: async () => [readyPath({ name: id })] }), new FakeSupervisor());
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

  const relay = fakeRelay({ status: async () => [readyPath({ name: id })] });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const lines = captureConsole(t, "warn", "log");

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
    store.update = realUpdate;
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a rejected forgetSeen write still lets removeFeed succeed and publish, and logs once through the seen-store outage", async (t) => {
  const made = await videoService.addFeed({ name: "Culvert cam", source: { kind: "push", protocol: "rtmp" }, password: "pw" });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const store = videoSeenStore as unknown as { update: (...a: unknown[]) => Promise<unknown> };
  const realUpdate = store.update.bind(videoSeenStore);
  store.update = async () => {
    throw new Error("disk full");
  };

  const lines = captureConsole(t, "warn");

  try {
    const removed = await videoService.removeFeed(id);
    assert.equal(removed, true, "removeFeed must still succeed despite the seen-store write rejecting");
    assert.equal((await videoService.state()).feeds.some((f) => f.id === id), false, "the feed must actually be gone");
    assert.equal(lines.filter((l) => l.includes("could not save the last-seen time")).length, 1, "the write failure must still reach the operator once");
  } finally {
    store.update = realUpdate;
  }
});

test("removeFeed forgets the seen store, so a re-added feed under the same name reads waiting, not a stale offline", async () => {
  const name = "Steeple cam";
  const made = await videoService.addFeed({ name, source: { kind: "push", protocol: "rtmp" }, password: "pw" });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  const relay = fakeRelay({ status: async () => [readyPath({ name: id })] });
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
  const relay2 = fakeRelay({ status: async () => [notReadyPath({ name: newId })] });
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
  const relay = fakeRelay({ status: async () => answer });
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

function recordingRelay(reconciled: RelayFeed[][], opts: { kickPublisher?: (feedId: string) => Promise<boolean> } = {}): VideoRelay {
  return fakeRelay({
    reconcile: async (feeds) => {
      reconciled.push(feeds);
    },
    ...opts,
  });
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

// The relay's API opens a moment after its process starts, so the first
// reconcile of every start routinely fails. Not news — until the API has
// answered once, or the boot grace has passed with it still shut.
test("a reconcile failing before this relay's API has ever answered, inside the boot grace, logs nothing", async (t) => {
  let fail = true;
  const relay = fakeRelay({ status: async () => [] });
  relay.reconcile = async () => {
    if (fail) throw new Error("fetch failed");
  };
  const supervisor = new FakeSupervisor();
  t.mock.timers.enable({ apis: ["Date"], now: 50_000 });
  supervisor.current = { state: "running", since: 50_000 - 1000 };
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);
  const lines = captureConsole(t, "warn", "log");
  try {
    assert.equal(await videoService.reconcileRelay(), false);
    fail = false;
    assert.equal(await videoService.reconcileRelay(), true);
    assert.deepEqual(
      lines.filter((l) => l.includes("reconcil")),
      [],
      "a relay still opening its API is not news, and nothing was reported to recover from",
    );
  } finally {
    await videoService.detachRelay();
  }
});

test("once the relay's API has answered, a reconcile failure is news, and the next success closes the run", async (t) => {
  let fail = false;
  const relay = fakeRelay({ status: async () => [] });
  relay.reconcile = async () => {
    if (fail) throw new Error("relay unreachable");
  };
  const supervisor = new FakeSupervisor();
  t.mock.timers.enable({ apis: ["Date"], now: 50_000 });
  supervisor.current = { state: "running", since: 50_000 - 1000 };
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);
  const lines = captureConsole(t, "warn", "log");
  const failures = () => lines.filter((l) => l.includes("could not reconcile")).length;
  const recoveries = () => lines.filter((l) => l.includes("reconciling the relay is working again")).length;
  try {
    assert.equal(await videoService.reconcileRelay(), true); // the API has answered
    fail = true;
    await videoService.reconcileRelay();
    assert.equal(failures(), 1, "a failure after the API has answered is news");
    fail = false;
    t.mock.timers.tick(1000);
    await videoService.reconcileRelay();
    assert.equal(recoveries(), 1, "the next success must close the run — reconciles are too sparse to wait for one to hold");
    fail = true;
    await videoService.reconcileRelay();
    assert.equal(failures(), 2, "a failure after the run closed is a new outage, and news again");
  } finally {
    await videoService.detachRelay();
  }
});

test("a reconcile failure is logged once per outage and never rejects addFeed/updateFeed — the feed store write is the source of truth", async (t) => {
  let fail = true;
  const relay = fakeRelay({
    reconcile: async () => {
      if (fail) throw new Error("relay unreachable");
    },
  });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const lines = captureConsole(t, "warn");

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
    await videoService.detachRelay();
  }
});

test("newPushPassword writes a fresh secret, reconciles, then kicks the current publisher — a kick failure is logged, not thrown, and the answer still carries the new password", async (t) => {
  const kicked: string[] = [];
  const reconciled: RelayFeed[][] = [];
  const relay = recordingRelay(reconciled, {
    kickPublisher: async (feedId): Promise<boolean> => {
      kicked.push(feedId);
      throw new Error("relay unreachable");
    },
  });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const lines = captureConsole(t, "warn");

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
    assert.equal(result!.kicked, "failed", "a publisher WAS there and dropping it threw — kicked must read \"failed\", never \"none\"");
  } finally {
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

// ── Reconciles, secrets and push passwords ────────────────────────────────

test("reconciles are single-flight — a change arriving mid-reconcile is folded into ONE more pass with the LATEST store contents, never a second overlapping relay.reconcile() call", async () => {
  const reconciled: RelayFeed[][] = [];
  // A mutable container, not a bare `let`: TS's reachability analysis reads
  // `while (!releaseFirst.fn)` as possibly-infinite when the only
  // reassignment is inside a closure it does not track the same way for a
  // bare captured variable, and marks everything after the loop
  // unreachable (`never`) — a property on an object sidesteps that.
  const releaseFirst: { fn: (() => void) | null } = { fn: null };
  let firstCallStarted = false;
  const relay = fakeRelay({
    reconcile: async (feeds) => {
      if (!firstCallStarted) {
        firstCallStarted = true;
        // Genuinely blocks the FIRST call until the test releases it below,
        // so the second addFeed's own reconcileRelay() call arrives while
        // this one is still talking to the relay — not just fast, actually
        // overlapping in time.
        await new Promise<void>((resolve) => {
          releaseFirst.fn = () => resolve();
        });
      }
      reconciled.push(feeds);
    },
  });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  let idA: string | undefined;
  let idB: string | undefined;
  try {
    const addA = videoService.addFeed({ name: "Interleave A", source: { kind: "push", protocol: "srt" } });
    while (!releaseFirst.fn) await new Promise((r) => setTimeout(r, 1));

    // A's reconcile is now genuinely in flight and blocked. B's own store
    // write completes fully — feed-store.ts's own write queue serialises
    // that independently of the relay — before its reconcileRelay() call
    // arrives here, finds one already running, and marks dirty rather than
    // firing a second overlapping relay.reconcile() call.
    const addB = videoService.addFeed({ name: "Interleave B", source: { kind: "push", protocol: "rtmp" } });
    await new Promise((r) => setTimeout(r, 20)); // let B's own write + reconcileRelay() call actually reach "mark dirty"

    releaseFirst.fn!();
    const [madeA, madeB] = await Promise.all([addA, addB]);
    assert.ok(madeA.ok && madeB.ok, "both adds must still succeed");
    idA = (madeA as { feed: { id: string } }).feed.id;
    idB = (madeB as { feed: { id: string } }).feed.id;

    assert.equal(
      reconciled.length,
      2,
      "expected exactly two relay.reconcile() calls — A's own blocked one, and ONE dirty-triggered follow-up — never two overlapping calls racing each other",
    );
    const followUp = reconciled[1]!;
    assert.ok(followUp.some((f) => f.id === idA), "expected the follow-up pass to still carry A's own feed");
    assert.ok(followUp.some((f) => f.id === idB), "expected the follow-up pass to carry B's feed — the one that arrived mid-flight, proving the plan is computed INSIDE the chain, not captured before it");
  } finally {
    await videoService.detachRelay();
    if (idA) await videoService.removeFeed(idA);
    if (idB) await videoService.removeFeed(idB);
  }
});

test("a change landing between the loop's own last dirty check and reconcileRunning actually clearing is not silently dropped", async () => {
  const reconciled: RelayFeed[][] = [];
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(recordingRelay(reconciled), supervisor);

  const made = await videoService.addFeed({ name: "Gap-race push", source: { kind: "push", protocol: "srt" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  reconciled.length = 0; // addFeed's own reconcile already ran once

  // Wraps the private reconcileLoop() so a SECOND reconcileRelay() call is
  // attached, via .then(), directly onto the SAME promise reconcileRelay()
  // itself consumes — registered first, so it runs in whatever gap exists
  // between the real reconcileLoop() deciding to return and anything else
  // that promise's resolution triggers (the OLD `.finally()` this used to be
  // the exact gap this item closes; a genuinely separate caller landing in
  // production would see the same ordering, for the same reason: promise
  // reactions run in registration order).
  const svc = videoService as unknown as { reconcileLoop(): Promise<boolean>; reconcileRelay(): Promise<boolean> };
  const realLoop = svc.reconcileLoop.bind(videoService);
  let armed = true;
  let injected: Promise<boolean> | null = null;
  svc.reconcileLoop = () => {
    const p = realLoop();
    if (armed) {
      armed = false;
      p.then(() => {
        injected = svc.reconcileRelay();
      });
    }
    return p;
  };

  try {
    await videoService.updateFeed(id, { name: "Gap-race push 2" }); // the main pass
    while (!injected) await new Promise((r) => setTimeout(r, 1));
    await injected;

    assert.equal(
      reconciled.length,
      2,
      "expected a SECOND relay.reconcile() call for the change that landed in the gap — under the bug it is silently dropped and the count stays at 1",
    );
  } finally {
    svc.reconcileLoop = realLoop;
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a rejecting reconcileOnce still clears reconcileRunning — a later reconcileRelay() call still runs a pass, not wedged behind a stuck flag", async () => {
  const reconciled: RelayFeed[][] = [];
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(recordingRelay(reconciled), supervisor);

  const made = await videoService.addFeed({ name: "Reject-once push", source: { kind: "push", protocol: "srt" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  reconciled.length = 0; // addFeed's own reconcile already ran once

  // reconcileOnce() catches its own errors internally and returns false —
  // it never actually rejects today. This simulates the case where it does
  // anyway (a future change, or anything outside its own try/catch), which
  // is exactly the shape reconcileLoop()'s own try/finally has to survive.
  const svc = videoService as unknown as { reconcileOnce(): Promise<boolean>; reconcileRelay(): Promise<boolean> };
  const realOnce = svc.reconcileOnce.bind(videoService);
  let calls = 0;
  svc.reconcileOnce = async () => {
    calls++;
    if (calls === 1) throw new Error("reconcileOnce rejected");
    return realOnce();
  };

  try {
    await assert.rejects(svc.reconcileRelay());
    // If reconcileRunning were left stuck true, this would just fold in
    // (set reconcileDirty) and await the SAME already-rejected chain,
    // rather than ever running a fresh pass.
    await videoService.updateFeed(id, { name: "Reject-once push 2" });
    assert.equal(
      reconciled.length,
      1,
      "expected a later reconcileRelay() call to actually run a pass, not be wedged behind a stuck flag",
    );
  } finally {
    svc.reconcileOnce = realOnce;
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a push feed with no stored secret (a restored snapshot, a wiped secrets file) mints and stores a fresh password before the relay or the address ever sees it — never an empty publish password", async (t) => {
  const made = await videoService.addFeed({ name: "Snapshot restore", source: { kind: "push", protocol: "srt" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  try {
    // Simulate a restored snapshot / wiped secrets file: the secret is gone,
    // but the feed itself is still there.
    await secretsStore.clearSecrets(SECRET_SLOT(id));
    assert.deepEqual(await secretsStore.getSecrets(SECRET_SLOT(id)), {});

    const lines = captureConsole(t, "warn");
    const address = await videoService.pushAddress(id);

    assert.ok(address);
    assert.ok(address!.password.length > 0, "expected pushAddress to mint a fresh password rather than publish with none");
    assert.equal(
      (await secretsStore.getSecrets(SECRET_SLOT(id))).password,
      address!.password,
      "expected the minted password to actually be stored, not just handed out once",
    );
    assert.ok(
      lines.some((l) => l.includes("made a new publish password")),
      "expected the one-time \"made a new publish password\" log line",
    );
  } finally {
    await videoService.removeFeed(id);
  }
});

test("relayFeeds() mints a password for a push feed with no stored secret too, so the relay is never handed an empty one", async () => {
  const reconciled: RelayFeed[][] = [];
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(recordingRelay(reconciled), supervisor);

  try {
    const made = await videoService.addFeed({ name: "No-secret push", source: { kind: "push", protocol: "rtmp" } });
    assert.ok(made.ok);
    const id = (made as { feed: { id: string } }).feed.id;
    await secretsStore.clearSecrets(SECRET_SLOT(id));

    // A no-op update just to trigger another reconcile without touching the secret directly.
    await videoService.updateFeed(id, { name: "No-secret push 2" });

    const last = reconciled[reconciled.length - 1]!.find((f) => f.id === id) as Extract<RelayFeed, { kind: "push" }> | undefined;
    assert.ok(last);
    assert.notEqual(last.password, "", "the relay must never be handed an empty publish password");
    await videoService.removeFeed(id);
  } finally {
    await videoService.detachRelay();
  }
});

test("a kind change's store write failing leaves the OLD secret in place — the secret only changes after the store write succeeds", async () => {
  const made = await videoService.addFeed({ name: "Reorder push", source: { kind: "push", protocol: "srt" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  const before = (await secretsStore.getSecrets(SECRET_SLOT(id))).password;
  assert.ok(before);

  const { videoFeedsStore } = await import("./feed-store.js");
  const store = videoFeedsStore as unknown as { update: (...a: unknown[]) => Promise<void> };
  const realUpdate = store.update.bind(videoFeedsStore);
  store.update = async () => {
    throw new Error("disk full");
  };
  try {
    await assert.rejects(
      videoService.updateFeed(id, { source: { kind: "external", url: "http://192.0.2.98/x/whep" } }),
      /disk full/,
    );
  } finally {
    store.update = realUpdate;
  }

  assert.equal(
    (await secretsStore.getSecrets(SECRET_SLOT(id))).password,
    before,
    "a failed store write must leave the OLD (push) secret exactly as it was — the kind on disk is still push",
  );
  await videoService.removeFeed(id);
});

test("pushPassword mints single-flight — two concurrent callers on a wiped secret share ONE mint, not two racing ones", async (t) => {
  const made = await videoService.addFeed({ name: "Racing mint push", source: { kind: "push", protocol: "srt" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  await secretsStore.clearSecrets(SECRET_SLOT(id));
  assert.deepEqual(await secretsStore.getSecrets(SECRET_SLOT(id)), {});

  // Every read of THIS feed's slot waits on one shared gate, released only
  // once BOTH callers' reads are pending on it — so both resolve together,
  // and whichever caller's synchronous continuation reaches the mint-map
  // check first (there is no `await` between checking the map and setting
  // it — see pushPassword()'s own comment) wins the mint, and the other
  // must find its entry rather than racing its own. Genuinely overlapping
  // reads, not just two fast, sequential ones.
  const realGetSecrets = secretsStore.getSecrets.bind(secretsStore);
  const gate: { fn: (() => void) | null } = { fn: null };
  const gatePromise = new Promise<void>((resolve) => {
    gate.fn = resolve;
  });
  let readsPending = 0;
  (secretsStore as unknown as { getSecrets: typeof secretsStore.getSecrets }).getSecrets = async (slot: string) => {
    const result = await realGetSecrets(slot);
    if (slot === SECRET_SLOT(id)) {
      readsPending++;
      await gatePromise;
    }
    return result;
  };

  const lines = captureConsole(t, "warn");

  try {
    const first = videoService.pushAddress(id);
    const second = videoService.pushAddress(id);
    while (readsPending < 2) await new Promise((r) => setTimeout(r, 1));
    gate.fn!(); // release both reads at once — genuinely overlapping from here

    const [a, b] = await Promise.all([first, second]);
    assert.ok(a && b);
    assert.equal(a!.password, b!.password, "expected one password everywhere, not two callers racing two mints");
    assert.equal(
      (await secretsStore.getSecrets(SECRET_SLOT(id))).password,
      a!.password,
      "expected the shared mint to actually be the one stored, not overwritten by a second write",
    );
    assert.equal(
      lines.filter((l) => l.includes("made a new publish password")).length,
      1,
      "expected exactly one mint line, not one per racing caller",
    );
  } finally {
    (secretsStore as unknown as { getSecrets: typeof secretsStore.getSecrets }).getSecrets = realGetSecrets;
    await videoService.removeFeed(id);
  }
});

test("newPushPassword's applied shape — true with nothing to apply to, false only when a running relay's reconcile fails", async () => {
  // No relay attached at all: nothing to apply to — vacuously true.
  const madeNoRelay = await videoService.addFeed({ name: "No relay push", source: { kind: "push", protocol: "srt" } });
  assert.ok(madeNoRelay.ok);
  const idNoRelay = (madeNoRelay as { feed: { id: string } }).feed.id;
  const resultNoRelay = await videoService.newPushPassword(idNoRelay);
  assert.ok(resultNoRelay);
  assert.equal(resultNoRelay!.applied, true, "nothing to apply to — vacuously true");
  await videoService.removeFeed(idNoRelay);

  // A running relay whose reconcile fails: applied false.
  const failingRelay = fakeRelay({
    reconcile: async () => {
      throw new Error("relay unreachable");
    },
  });
  const supervisor1 = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(failingRelay, supervisor1);
  const madeFailing = await videoService.addFeed({ name: "Failing reconcile push", source: { kind: "push", protocol: "srt" } });
  assert.ok(madeFailing.ok);
  const idFailing = (madeFailing as { feed: { id: string } }).feed.id;
  try {
    const resultFailing = await videoService.newPushPassword(idFailing);
    assert.ok(resultFailing);
    assert.equal(resultFailing!.applied, false, "a running relay whose reconcile failed — applied must be false");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(idFailing);
  }
});

// `kicked` is
// three-way, not a boolean — "none" and "failed" are both "nothing got
// dropped," but only "failed" means a device really was connected and
// stayed connected under the old password. One test per value.
test("kicked is \"none\" with no relay attached at all — nothing to ask, not a failure", async () => {
  const made = await videoService.addFeed({ name: "No relay kick", source: { kind: "push", protocol: "srt" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  const result = await videoService.newPushPassword(id);
  assert.ok(result);
  assert.equal(result!.kicked, "none");
  await videoService.removeFeed(id);
});

test("kicked is \"none\" with a running relay but nobody publishing", async () => {
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(recordingRelay([], { kickPublisher: async () => false }), supervisor);
  const made = await videoService.addFeed({ name: "Nobody publishing push", source: { kind: "push", protocol: "srt" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  try {
    const result = await videoService.newPushPassword(id);
    assert.ok(result);
    assert.equal(result!.kicked, "none", "kickPublisher returned false — nobody was there to drop, not a failure");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("kicked is \"dropped\" only once the relay actually drops a connected publisher", async () => {
  const supervisor = new FakeSupervisor();
  attach(recordingRelay([], { kickPublisher: async () => true }), supervisor);
  const made = await videoService.addFeed({ name: "Kicked push", source: { kind: "push", protocol: "srt" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  try {
    const result = await videoService.newPushPassword(id);
    assert.ok(result);
    assert.equal(result!.kicked, "dropped");
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("kickPublisher runs only while the supervisor is running, and its own outage run closes with ok() on a successful kick", async (t) => {
  let kickCalls = 0;
  const relay = recordingRelay([], {
    kickPublisher: async () => {
      kickCalls++;
      return true;
    },
  });
  const supervisor = new FakeSupervisor();
  supervisor.current = { state: "starting" };
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const made = await videoService.addFeed({ name: "Starting-relay push", source: { kind: "push", protocol: "srt" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  try {
    await videoService.newPushPassword(id);
    assert.equal(kickCalls, 0, "the kick must not even be attempted while the supervisor is not running");

    supervisor.current = { state: "running", since: 0 };
    const lines = captureConsole(t, "log");
    const result = await videoService.newPushPassword(id);
    assert.ok(result);
    assert.equal(kickCalls, 1, "expected the kick to be attempted now that the supervisor is running");
    assert.equal(result!.kicked, "dropped");
    assert.ok(
      lines.some((l) => l.includes("kicking a publisher is working again")) === false,
      "no PRIOR failure was open, so ok() must settle silently — nothing to announce recovering from",
    );
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

// The test above only proves ok() settles SILENTLY when no failure was ever
// open — true whether or not the ok("push-kick", ...) call exists at all,
// since nothing was ever failing.
// This proves the actual recovery line fires: a kick failure opens the
// outage, and a kick succeeding once the settle window has passed closes it
// with the announcement.
test("a kick failure opens the push-kick outage, and a kick succeeding past the settle window announces the recovery", async (t) => {
  let fail = true;
  const relay = recordingRelay([], {
    kickPublisher: async () => {
      if (fail) throw new Error("relay unreachable");
      return true;
    },
  });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const made = await videoService.addFeed({ name: "Recovering kick push", source: { kind: "push", protocol: "srt" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;

  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const lines = captureConsole(t, "log", "warn");

  try {
    await videoService.newPushPassword(id); // the kick throws — opens the run
    assert.equal(
      lines.filter((l) => l.includes("could not kick the previous publisher")).length,
      1,
      "expected the failure itself to open the outage",
    );

    fail = false;
    t.mock.timers.tick(DEFAULT_SETTLE_MS + 1000); // past the settle window
    await videoService.newPushPassword(id); // the kick succeeds now
    assert.equal(
      lines.filter((l) => l.includes("kicking a publisher is working again")).length,
      1,
      "a kick succeeding past the settle window must announce the recovery — deleting the ok() call leaves this at 0",
    );
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("newPushPassword reconciles BEFORE it kicks — the new password must already be live at the relay before the old connection is dropped", async () => {
  const order: string[] = [];
  const relay = fakeRelay({
    reconcile: async () => {
      order.push("reconcile");
    },
    kickPublisher: async () => {
      order.push("kick");
      return true;
    },
  });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  attach(relay, supervisor);

  const made = await videoService.addFeed({ name: "Order push", source: { kind: "push", protocol: "srt" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  try {
    order.length = 0; // addFeed's own reconcile already ran once
    await videoService.newPushPassword(id);
    const reconcileIndex = order.indexOf("reconcile");
    const kickIndex = order.indexOf("kick");
    assert.ok(reconcileIndex >= 0 && kickIndex >= 0, "expected both a reconcile and a kick");
    assert.ok(reconcileIndex < kickIndex, `expected reconcile (${reconcileIndex}) before kick (${kickIndex})`);
  } finally {
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("newPushPassword logs one summary line per rotation, without the password, naming what happened to the current publisher", async (t) => {
  const lines = captureConsole(t, "log");

  // No relay: "nothing was publishing".
  const made = await videoService.addFeed({ name: "Summary line push", source: { kind: "push", protocol: "srt" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  try {
    const before = (await secretsStore.getSecrets(SECRET_SLOT(id))).password;
    lines.length = 0;
    await videoService.newPushPassword(id);
    const summary = lines.find((l) => l.startsWith("[video] Summary line push: new publish password"));
    assert.ok(summary, `expected a rotation summary line; got: ${JSON.stringify(lines)}`);
    assert.equal(summary, "[video] Summary line push: new publish password; nothing was publishing");
    assert.equal(summary!.includes(before!), false, "the summary line must never carry the password");
  } finally {
    await videoService.removeFeed(id);
  }
});

test("pull -> external/embed clears the slot; pull -> push overwrites the pull password with a fresh push one", async () => {
  const madePull = await videoService.addFeed({
    name: "Gap pull",
    source: { kind: "pull", url: "rtsp://192.0.2.99:8554/s", username: "" },
    password: "pull-secret",
  });
  assert.ok(madePull.ok);
  const pullId = (madePull as { feed: { id: string } }).feed.id;
  assert.equal((await secretsStore.getSecrets(SECRET_SLOT(pullId))).password, "pull-secret");

  await videoService.updateFeed(pullId, { source: { kind: "external", url: "http://192.0.2.100/x/whep" } });
  assert.deepEqual(await secretsStore.getSecrets(SECRET_SLOT(pullId)), {}, "pull -> external must clear the slot");
  await videoService.removeFeed(pullId);

  const madePull2 = await videoService.addFeed({
    name: "Gap pull 2",
    source: { kind: "pull", url: "rtsp://192.0.2.101:8554/s", username: "" },
    password: "pull-secret-2",
  });
  assert.ok(madePull2.ok);
  const pullId2 = (madePull2 as { feed: { id: string } }).feed.id;
  await videoService.updateFeed(pullId2, { source: { kind: "embed", player: "youtube-channel", ref: "UC1234567890123456789012" } });
  assert.deepEqual(await secretsStore.getSecrets(SECRET_SLOT(pullId2)), {}, "pull -> embed must clear the slot");
  await videoService.removeFeed(pullId2);

  const madePull3 = await videoService.addFeed({
    name: "Gap pull 3",
    source: { kind: "pull", url: "rtsp://192.0.2.102:8554/s", username: "" },
    password: "pull-secret-3",
  });
  assert.ok(madePull3.ok);
  const pullId3 = (madePull3 as { feed: { id: string } }).feed.id;
  await videoService.updateFeed(pullId3, { source: { kind: "push", protocol: "srt" } });
  const afterPushSecret = (await secretsStore.getSecrets(SECRET_SLOT(pullId3))).password;
  assert.ok(afterPushSecret, "expected pull -> push to mint a push password");
  assert.notEqual(afterPushSecret, "pull-secret-3", "expected the OLD pull password overwritten, not reused as the push password");
  await videoService.removeFeed(pullId3);
});

test("pushAddress's protocolOverride previews another protocol's address with the SAME stored password, without saving anything", async () => {
  const made = await videoService.addFeed({ name: "Preview push", source: { kind: "push", protocol: "srt" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  try {
    const saved = await videoService.pushAddress(id);
    assert.ok(saved);
    assert.equal(saved!.protocol, "srt");

    const preview = await videoService.pushAddress(id, "whip");
    assert.ok(preview);
    assert.equal(preview!.protocol, "whip");
    assert.equal(preview!.password, `video:${saved!.password}`, "expected the SAME underlying password, just formatted for WHIP");
    assert.ok(preview!.address.includes("/whip"));

    // Nothing was saved — the feed's own stored protocol is unchanged.
    const stillSaved = await videoService.pushAddress(id);
    assert.equal(stillSaved!.protocol, "srt", "a preview must never write anything");
  } finally {
    await videoService.removeFeed(id);
  }
});

test("view() reports hasPassword for a pull feed (never the value), true once a password is stored and false once cleared", async () => {
  const made = await videoService.addFeed({ name: "HasPassword pull", source: { kind: "pull", url: "rtsp://192.0.2.103:8554/s", username: "" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  try {
    let feed = (await videoService.state()).feeds.find((f) => f.id === id);
    assert.equal(feed?.hasPassword, false, "no password stored yet");

    await videoService.updateFeed(id, { password: "now-set" });
    feed = (await videoService.state()).feeds.find((f) => f.id === id);
    assert.equal(feed?.hasPassword, true);
    assert.equal(JSON.stringify(feed).includes("now-set"), false, "hasPassword must never leak the value itself");

    await videoService.updateFeed(id, { password: "" });
    feed = (await videoService.state()).feeds.find((f) => f.id === id);
    assert.equal(feed?.hasPassword, false, "cleared again");
  } finally {
    await videoService.removeFeed(id);
  }
});

// ── relay-lifecycle.ts's own hooks: fired on every feed/ports change ───────

test("setFeedsChangedListener fires on addFeed, updateFeed and removeFeed — the hook relay-lifecycle.ts starts/stops the relay from", async () => {
  const calls: string[] = [];
  videoService.setFeedsChangedListener(() => calls.push("changed"));
  try {
    const made = await videoService.addFeed({ name: "Hook pull", source: { kind: "pull", url: "rtsp://192.0.2.104:8554/s", username: "" } });
    assert.ok(made.ok);
    const id = (made as { feed: { id: string } }).feed.id;
    assert.equal(calls.length, 1, "addFeed did not fire the hook");

    await videoService.updateFeed(id, { name: "Hook pull renamed" });
    assert.equal(calls.length, 2, "updateFeed did not fire the hook");

    await videoService.removeFeed(id);
    assert.equal(calls.length, 3, "removeFeed did not fire the hook");
  } finally {
    videoService.setFeedsChangedListener(null);
  }
});

test("setPortsChangedListener fires from setPorts, and only on a body that validates", async () => {
  const calls: string[] = [];
  videoService.setPortsChangedListener(() => calls.push("changed"));
  try {
    const bad = await videoService.setPorts({ rtmp: 80, srt: 8890, webrtcUdp: 8189, webrtcHttp: 8889, hls: 8888, api: 9997 });
    assert.equal(bad.ok, false, "a port below 1024 must be refused");
    assert.equal(calls.length, 0, "the hook fired on a body that never saved anything");

    const ok = await videoService.setPorts({ rtmp: 31935, srt: 38890, webrtcUdp: 38189, webrtcHttp: 38889, hls: 38888, api: 39997 });
    assert.ok(ok.ok);
    assert.equal(calls.length, 1, "a valid ports save never fired the hook");
  } finally {
    videoService.setPortsChangedListener(null);
    const { videoFeedsStore } = await import("./feed-store.js");
    await videoFeedsStore.update((current) => ({ ...current, ports: DEFAULT_VIDEO_PORTS }));
  }
});

test("saving the SAME ports never fires the hook — an unchanged save must not restart a running relay and drop every publisher", async () => {
  const CHANGED = { rtmp: 41935, srt: 48890, webrtcUdp: 48189, webrtcHttp: 48889, hls: 48888, api: 49997 };
  const calls: string[] = [];
  try {
    const setup = await videoService.setPorts(CHANGED);
    assert.ok(setup.ok);

    videoService.setPortsChangedListener(() => calls.push("changed"));
    const again = await videoService.setPorts({ ...CHANGED });
    assert.ok(again.ok);
    assert.equal(calls.length, 0, "saving the identical six values again must not fire the restart hook");

    const real = await videoService.setPorts(DEFAULT_VIDEO_PORTS);
    assert.ok(real.ok);
    assert.equal(calls.length, 1, "a genuine change must still fire it");
  } finally {
    videoService.setPortsChangedListener(null);
    const { videoFeedsStore } = await import("./feed-store.js");
    await videoFeedsStore.update((current) => ({ ...current, ports: DEFAULT_VIDEO_PORTS }));
  }
});

/** setPreAttachStatus()/attachRelay() both call publish() fire-and-forget —
 *  intentionally, so relay-lifecycle.ts's own callers are never made to wait
 *  on it. A test therefore cannot rely on either call
 *  having settled synchronously, or even after a single microtask: publish()
 *  itself awaits a real feed-store read. Real wall-clock polling, bounded,
 *  rather than a guessed number of ticks. */
async function waitForCount(seen: unknown[], count: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (seen.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("setRelayStatusListener fires on every publish that actually changes the relay, with the fresh RelayStatus", async () => {
  const seen: RelayStatus[] = [];
  videoService.setRelayStatusListener((relay) => seen.push(relay));
  try {
    videoService.setPreAttachStatus({ state: "downloading", receivedBytes: 1, totalBytes: 2 });
    await waitForCount(seen, 1);
    assert.deepEqual(seen.at(-1), { state: "downloading", receivedBytes: 1, totalBytes: 2 });

    // The identical status again must not re-fire — publish() itself is
    // gated on a real change, and the listener rides that same gate.
    videoService.setPreAttachStatus({ state: "downloading", receivedBytes: 1, totalBytes: 2 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seen.length, 1, "an unchanged status must not re-fire the listener");

    videoService.setPreAttachStatus(null);
    await waitForCount(seen, 2);
    assert.deepEqual(seen.at(-1), { state: "off" });
  } finally {
    videoService.setRelayStatusListener(null);
    videoService.setPreAttachStatus(null);
  }
});

// Seen in a full test run: a publish still reading the disk when attachRelay
// published "running" finished afterwards, and its older "off" became the
// snapshot and the connection row's last word, with the relay running.
test("a publish that started before a newer one never lands after it", async (t) => {
  const seen: RelayStatus[] = [];
  videoService.setRelayStatusListener((relay) => seen.push(relay));
  const real = videoService.state.bind(videoService);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  let read: () => void = () => {};
  const olderRead = new Promise<void>((resolve) => (read = resolve));
  t.mock.method(videoService, "state", async () => {
    const first = ++calls === 1; // the older publish, slow on its reads
    const s = await real();
    if (first) {
      read();
      await held;
    }
    return s;
  });
  try {
    const older = (videoService as unknown as { publish(): Promise<void> }).publish();
    await olderRead; // it has read "off"
    const supervisor = new FakeSupervisor();
    supervisor.ver = "v1.21.1";
    attach(fakeRelay({ status: async () => [] }), supervisor); // publishes "running"
    // Give the newer publish its chance to land first.
    const until = performance.now() + 500;
    while (seen.length === 0 && performance.now() < until) await new Promise((r) => setImmediate(r));
    release();
    await older;
    assert.equal(videoService.current().relay.state, "running", "the snapshot every screen hydrates from");
    assert.equal(seen.at(-1)?.state, "running", `the row was told, in order: ${JSON.stringify(seen)}`);
  } finally {
    release();
    videoService.setRelayStatusListener(null);
    await videoService.detachRelay();
  }
});

test("attachRelay itself publishes the settled state — a caller must not need a SEPARATE trigger to have the row learn the relay just came up", async () => {
  const seen: RelayStatus[] = [];
  videoService.setRelayStatusListener((relay) => seen.push(relay));
  try {
    const supervisor = new FakeSupervisor();
    supervisor.ver = "v1.21.1";
    attach(fakeRelay({ status: async () => [] }), supervisor);
    await waitForCount(seen, 1);
    assert.deepEqual(seen.at(-1), { state: "running", version: "v1.21.1", ports: DEFAULT_VIDEO_PORTS });
  } finally {
    videoService.setRelayStatusListener(null);
    await videoService.detachRelay();
  }
});

test("setPreAttachStatus reports a RelayStatus with no supervisor attached, and clearing it falls back to off", async () => {
  assert.equal((await videoService.state()).relay.state, "off");
  videoService.setPreAttachStatus({ state: "downloading", receivedBytes: 10, totalBytes: 100 });
  assert.deepEqual((await videoService.state()).relay, { state: "downloading", receivedBytes: 10, totalBytes: 100 });

  videoService.setPreAttachStatus(null);
  assert.deepEqual((await videoService.state()).relay, { state: "off" });
});

test("attachRelay always wins over a stale setPreAttachStatus — a supervisor's own status is the only truth once one exists", async () => {
  videoService.setPreAttachStatus({ state: "downloading", receivedBytes: 1, totalBytes: 2 });
  const supervisor = new FakeSupervisor();
  attach(fakeRelay({ status: async () => [] }), supervisor);
  try {
    assert.equal((await videoService.state()).relay.state, "running", "attachRelay must clear a stale pre-attach status");
  } finally {
    await videoService.detachRelay();
  }
});

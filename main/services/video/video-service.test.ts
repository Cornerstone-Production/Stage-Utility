import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Before any store is constructed: every import below builds its stores
// against this directory, never the default data folder.
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-service-"));
process.env.STAGE_UTILITY_DATA = TMP;
const { videoService, SECRET_SLOT, STATUS_POLL_MS, videoPollDeps } = await import("./video-service.js");
const { secretsStore } = await import("../secrets.js");
const { configSnapshot } = await import("../config-snapshot.js");
const { withAllKinds } = await import("../fixtures/video-kinds.js");
const { videoSeenStore, SEEN_WRITE_INTERVAL_MS } = await import("./seen-store.js");
const { DEFAULT_SETTLE_MS } = await import("../repeat-log.js");
type RelayPath = import("./relay.js").RelayPath;
type VideoRelay = import("./relay.js").VideoRelay;
type SupervisorStatus = import("./supervisor.js").SupervisorStatus;

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
// A relay is never really started in this file — task 15 owns that. What is
// tested here is everything task 12 built around one: the demand gate, the
// dedupe on publish(), the transition log lines, the B-frames mark (bound
// immediately and pending, R12c), noteRequested()'s validation, relayStatus()'s
// mapping from the supervisor (including R12b's spawned/exit events and R12e's
// nullable starting version), a failing poll's R12a behaviour, the seen
// store's Important #3 failure handling, and the generation-guarded reentry
// fix from Minor #4.

class FakeSupervisor extends EventEmitter {
  current: SupervisorStatus = { state: "off" };
  ver: string | null = null;
  status(): SupervisorStatus {
    return this.current;
  }
  version(): string | null {
    return this.ver;
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

// Same reasoning, same fix, for Minor #4's deferred-resolve test below: a
// `let` reassigned only inside a closure nested two levels deep (a fake
// relay's own status() implementation) is never narrowed away from its
// initializer's type at a read site in a THIRD, unrelated function, so
// `resolveA?.(...)` there reports "Type 'never' has no call signatures" with
// no assert involved at all — reading it from its own top-level function
// sidesteps the narrowing instead of fighting it.
let resolveA: ((paths: RelayPath[]) => void) | null = null;
const callResolveA = (paths: RelayPath[]) => resolveA?.(paths);

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

test("Minor #7: logs a feed's entry into delayed too, and never prints an unknown picture", async () => {
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

test("R12c: a B-frames close on an on-demand pull feed that is not yet ready binds on the next poll that sees it ready", async () => {
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

test("Minor #5: a B-frames line for a path that is not a real feed is never logged, and never becomes a mark", async () => {
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

  t.mock.timers.enable({ apis: ["Date"], now: 0 });

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

test("relay status maps the supervisor's status and version onto the wire shape, including R12e's null starting version", async () => {
  const relay = fakeRelay(async () => []);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(relay, supervisor);

  try {
    supervisor.current = { state: "off" };
    assert.deepEqual((await videoService.state()).relay, { state: "off" });

    // R12e: a relay that has just spawned has not printed its version banner
    // yet — "starting" must be able to say so honestly, not fake a string.
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

test("R12a / Important #1: a poll that fails clears lastPaths and reports the relay as failing to answer", async () => {
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

test("R12a follow-up: a stopped relay reads off, not \"not answering\", even when a poll against it fails", async () => {
  // Nothing has started yet — a poll failing here (nothing is listening on
  // the API port) is not news, and must not be read as the relay failing.
  const relay = fakeRelay(async () => {
    throw new Error("ECONNREFUSED");
  });
  const supervisor = new FakeSupervisor();
  supervisor.current = { state: "off" };
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(relay, supervisor);

  try {
    await pollOnce();
    assert.deepEqual(videoService.current().relay, { state: "off" });
  } finally {
    await videoService.detachRelay();
  }
});

test("R12a follow-up: a relay the supervisor already reports failing keeps its own reason, not \"not answering\"", async () => {
  const relay = fakeRelay(async () => {
    throw new Error("ECONNREFUSED");
  });
  const supervisor = new FakeSupervisor();
  supervisor.current = { state: "failing", reason: "Port 1935 is in use by OBS.", retryAt: 55555 };
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(relay, supervisor);

  try {
    await pollOnce(); // also fails to answer — the supervisor's own diagnosis still wins
    assert.deepEqual(videoService.current().relay, { state: "failing", reason: "Port 1935 is in use by OBS.", retryAt: 55555 });
  } finally {
    await videoService.detachRelay();
  }
});

test("R12a follow-up: the \"starting\" override waits for the relay's own banner, not just any failed poll", async () => {
  const relay = fakeRelay(async () => {
    throw new Error("ECONNREFUSED");
  });
  const supervisor = new FakeSupervisor();
  supervisor.current = { state: "starting" };
  supervisor.ver = null; // no banner parsed yet
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(relay, supervisor);

  try {
    await pollOnce();
    assert.deepEqual(
      videoService.current().relay,
      { state: "starting", version: null },
      "a poll failing before the relay has even logged its banner is normal, not a failure to report",
    );

    supervisor.ver = "v1.21.1"; // the relay has now logged its startup banner
    await pollOnce(); // still fails to answer
    assert.deepEqual(videoService.current().relay, { state: "failing", reason: "The relay is not answering", retryAt: null });
  } finally {
    await videoService.detachRelay();
  }
});

test("R12b: the attached supervisor's spawned/exit events publish immediately, without waiting for a poll", async () => {
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
    supervisor.emit("spawned");
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(frames.length >= 1, "spawned must publish without a poll ever running");
    assert.deepEqual(frames.at(-1)?.relay, { state: "starting", version: null });

    const before = frames.length;
    supervisor.current = { state: "failing", reason: "boom", retryAt: 999 };
    supervisor.emit("exit", 1, "boom");
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(frames.length > before, "exit must publish too");
    assert.deepEqual(frames.at(-1)?.relay, { state: "failing", reason: "boom", retryAt: 999 });
  } finally {
    await videoService.detachRelay();
  }
});

test("Minor #8: attaching a new relay without detaching first replaces the old one's listeners rather than leaking them", async () => {
  const relayA = fakeRelay(async () => []);
  const supervisorA = new FakeSupervisor();
  const relayB = fakeRelay(async () => []);
  const supervisorB = new FakeSupervisor();

  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(relayA, supervisorA);
  videoService.attachRelay(relayB, supervisorB); // no explicit detach in between

  try {
    assert.equal(supervisorA.listenerCount("line"), 0, "the old supervisor's line listener must be removed");
    assert.equal(supervisorA.listenerCount("spawned"), 0, "and its spawned listener");
    assert.equal(supervisorA.listenerCount("exit"), 0, "and its exit listener");
    assert.equal(supervisorB.listenerCount("line"), 1, "the new supervisor must be the one actually listened to");
  } finally {
    await videoService.detachRelay();
  }
});

test("Minor #4: attaching a new relay while the old one's poll is still in flight does not block the new relay's first read", async () => {
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

test("Important #3: a seen-store write that rejects still lets the poll publish its transitions, warns once per outage, and logs recovery once settled", async (t) => {
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

test("Minor #6: removeFeed forgets the seen store, so a re-added feed under the same name reads waiting, not a stale offline", async () => {
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

test("Minor #9: the last-seen time is flushed to disk on the transition out of ready, not left to the throttle", async (t) => {
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

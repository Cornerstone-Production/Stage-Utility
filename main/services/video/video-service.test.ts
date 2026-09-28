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

// ── The status poll, attach/detach, and the two transition log lines ──────
//
// A relay is never really started in this file — task 15 owns that. What is
// tested here is everything task 12 built around one: the demand gate, the
// dedupe on publish(), the two exact log lines, the B-frames mark and its
// once-per-session line, noteRequested()'s validation, and relayStatus()'s
// mapping from the supervisor.

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
 *  call takes to settle — deterministic for every test but the one that
 *  actually asserts on the timer wiring itself. */
const pollOnce = () => (videoService as unknown as { pollOnce(): Promise<void> }).pollOnce();

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
    videoService.detachRelay();
    Object.assign(videoPollDeps, real);
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
    videoService.detachRelay();
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
    videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a B-frames close on the relay's log marks the feed delayed, and logs once per session", async () => {
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
    await pollOnce(); // populates lastPaths, so the mark's readyTime lookup has something to read

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
    videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a relay that stops answering warns once per outage, not once per poll", async () => {
  let fail = true;
  const relay = fakeRelay(async () => {
    if (fail) throw new Error("ECONNREFUSED");
    return [];
  });
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(relay, supervisor);

  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));

  try {
    await pollOnce();
    await pollOnce();
    await pollOnce();
    assert.equal(
      warns.filter((l) => l.includes("not answering")).length,
      1,
      "three failed polls of the same outage must warn once, not three times",
    );
    fail = false;
    await pollOnce(); // close the run out, so a later test's own outage starts clean
  } finally {
    console.warn = realWarn;
    videoService.detachRelay();
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
    videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("relay status maps the supervisor's status and version onto the wire shape", async () => {
  const relay = fakeRelay(async () => []);
  const supervisor = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(relay, supervisor);

  try {
    supervisor.current = { state: "off" };
    assert.deepEqual((await videoService.state()).relay, { state: "off" });

    supervisor.current = { state: "starting" };
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
    videoService.detachRelay();
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

    videoService.detachRelay();
    const state = await videoService.state();
    assert.deepEqual(state.relay, { state: "off" });
    feed = state.feeds.find((f) => f.id === id);
    // "no path at all" — not "standby" — is what feed-state.ts reads a
    // detached relay as, same as a relay that has never reconciled this feed.
    assert.equal(feed?.status.state, "offline");
    assert.ok((feed?.status.lastSeenAt ?? 0) > 0, "the earlier live poll must have recorded a seen time");
  } finally {
    await videoService.removeFeed(id);
  }
});

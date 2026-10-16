// video-service-probe.test.ts — the camera checks as the video service wires
// them: what reaches the log (and what must never), which feeds are asked, and
// what `video:probe` carries. The scheduler's own timing is
// probe-scheduler.test.ts; the probe itself is probe.test.ts.

import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, test, type TestContext } from "node:test";

import { captureConsole } from "../fixtures/capture-console.js";
import { fakeRelay } from "../fixtures/fake-relay.js";
import { within } from "../fixtures/within.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-probe-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { videoService, videoProbeDeps, videoPollDeps } = await import("./video-service.js");
const { addBroadcastListener } = await import("../broadcaster.js");
const { DEFAULT_SETTLE_MS } = await import("../repeat-log.js");
const { PULL_START_TIMEOUT_MS } = await import("./reconcile-plan.js");
const { RECENT_REQUEST_MS } = await import("./video-service.js");
const { DEFAULT_VIDEO_PORTS } = await import("../../types/video.js");

type ProbeResult = import("./probe.js").ProbeResult;
type RelayPath = import("./relay.js").RelayPath;
type SupervisorStatus = import("./supervisor.js").SupervisorStatus;
type VideoProbeState = import("../../types/video.js").VideoProbeState;

const PASSWORD = "hunter2-secret";

const probeFrames: VideoProbeState[] = [];
addBroadcastListener((channel, payload) => {
  if (channel === "video:probe") probeFrames.push(structuredClone(payload as VideoProbeState));
});

class FakeSupervisor extends EventEmitter {
  current: SupervisorStatus = { state: "running", since: 1 };
  status(): SupervisorStatus {
    return this.current;
  }
  version(): string | null {
    return null;
  }
}

const notReadyPath = (name: string): RelayPath => ({ name, ready: false, readyTime: null, source: null, video: null, readers: 0 });
const readyPath = (name: string): RelayPath => ({
  name,
  ready: true,
  readyTime: "2026-09-28T00:00:00Z",
  source: { type: "rtspSource", id: "s1" },
  video: { codec: "H264", width: 1920, height: 1080, profile: "High" },
  readers: 1,
});

/** Every camera-check round the last call started has landed. A round reads
 *  the feed file and the secrets store, so no fixed count of event-loop turns
 *  covers it under load. */
const settle = (): Promise<void> => within(videoService.whenProbesIdle(), "the camera-check rounds to land");

/** A feed the service owns, with the password in the real secrets store. */
async function addPull(name: string, url: string, username = "admin", password = PASSWORD): Promise<string> {
  const made = await videoService.addFeed({ name, source: { kind: "pull", url, username }, password });
  assert.ok(made.ok, "expected the feed to be added");
  return (made as { feed: { id: string } }).feed.id;
}

interface Rig {
  /** Everything the probe was asked, and what it answers next. */
  asked: string[];
  answer: ProbeResult | ((url: string) => ProbeResult);
  /** Fires the scheduler's captured interval, as 15 s passing would. */
  tick(): Promise<void>;
  /** A client subscribes to / leaves `video:probe`. */
  watch(on: boolean): Promise<void>;
  restore(): void;
}

function rig(): Rig {
  const savedProbe = { ...videoProbeDeps };
  const savedPoll = { ...videoPollDeps };
  let fn: (() => void) | null = null;
  const r: Rig = {
    asked: [],
    answer: { state: "ready" },
    async tick() {
      fn?.();
      await settle();
    },
    async watch(on) {
      videoProbeDeps.inDemand = () => on;
      videoService.subscriptionsChanged();
      await settle();
    },
    restore() {
      videoProbeDeps.inDemand = () => false;
      videoService.subscriptionsChanged();
      Object.assign(videoProbeDeps, savedProbe);
      Object.assign(videoPollDeps, savedPoll);
    },
  };
  videoProbeDeps.setInterval = (f) => {
    fn = f;
    return {} as NodeJS.Timeout;
  };
  videoProbeDeps.clearInterval = () => {
    fn = null;
  };
  videoProbeDeps.probe = async (target) => {
    r.asked.push(target.url);
    return typeof r.answer === "function" ? r.answer(target.url) : r.answer;
  };
  // Nobody is watching until a test says so: the real check answers "yes"
  // when no transport has registered, which would start probes unasked.
  videoProbeDeps.inDemand = () => false;
  // The relay status poll is not under test here.
  videoPollDeps.inDemand = () => false;
  videoService.setVideoEnabled(true);
  return r;
}

beforeEach(() => {
  const outages = videoService as unknown as { dialOutage: { forget(): void }; probeRoundOutage: { forget(): void } };
  outages.dialOutage.forget();
  outages.probeRoundOutage.forget();
});

const NO_ANSWER = "No answer from 192.0.2.59 for this path · check the address and path";

test("a camera that does not answer is one warning for the whole outage, naming the address with no login, and no log line ever carries the password", async (t: TestContext) => {
  const lines = captureConsole(t, "log", "warn", "error");
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const id = await addPull("Box cam", "rtsp://192.0.2.59:554/BOX");
  const r = rig();
  r.answer = { state: "failed", reason: NO_ANSWER };
  try {
    await r.watch(true);
    for (let i = 0; i < 4; i++) await r.tick();
    assert.ok(r.asked.length >= 5, "five rounds ran");
    assert.deepEqual(
      lines.filter((l) => l.includes("Box cam")),
      [`[video] Box cam: ${NO_ANSWER} (rtsp://192.0.2.59:554/BOX)`],
    );
    assert.equal(lines.some((l) => l.includes(PASSWORD)), false, "a password reached the log");
  } finally {
    r.restore();
    await videoService.removeFeed(id);
  }
});

test("an address typed with a login in it is logged without it", async (t: TestContext) => {
  const lines = captureConsole(t, "log", "warn", "error");
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  // parseFeedInput refuses userinfo, so seed the store as a restored file might.
  const { videoFeedsStore } = await import("./feed-store.js");
  await videoFeedsStore.update((c) => ({
    ...c,
    feeds: [...(Array.isArray(c.feeds) ? c.feeds : []), { id: "legacy-cam", name: "Legacy cam", source: { kind: "pull", url: `rtsp://admin:${PASSWORD}@192.0.2.60:554/BOX`, username: "" } }],
  }));
  const r = rig();
  r.answer = { state: "failed", reason: "192.0.2.60 is not reachable" };
  try {
    await r.watch(true);
    assert.deepEqual(lines.filter((l) => l.includes("Legacy cam")), ["[video] Legacy cam: 192.0.2.60 is not reachable (rtsp://192.0.2.60:554/BOX)"]);
    assert.equal(lines.some((l) => l.includes(PASSWORD)), false);
  } finally {
    r.restore();
    await videoService.removeFeed("legacy-cam");
  }
});

test("a feed name carrying a newline cannot forge a log line from a probe failure", async (t: TestContext) => {
  const lines = captureConsole(t, "log", "warn", "error");
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const id = await addPull("Evil\n[video] forged entry", "rtsp://192.0.2.61:554/BOX");
  const r = rig();
  r.answer = { state: "failed", reason: "192.0.2.61 is not reachable" };
  try {
    await r.watch(true);
    const mine = lines.filter((l) => l.includes("192.0.2.61"));
    assert.equal(mine.length, 1);
    assert.equal(/[\r\n]/.test(mine[0]!), false, "the line holds a raw newline");
    assert.ok(mine[0]!.includes("\\n"), "the newline is escaped, so it stays visible");
  } finally {
    r.restore();
    await videoService.removeFeed(id);
  }
});

test("a probe failure then the relay's dial failing on the same feed is ONE line, not two", async (t: TestContext) => {
  const lines = captureConsole(t, "log", "warn", "error");
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const id = await addPull("Both cam", "rtsp://192.0.2.62:554/BOX");
  const r = rig();
  r.answer = { state: "failed", reason: "No answer from 192.0.2.62 for this path · check the address and path" };
  videoService.attachRelay(fakeRelay({ status: async () => [notReadyPath(id)] }), new FakeSupervisor(), DEFAULT_VIDEO_PORTS);
  try {
    await r.watch(true);
    const poll = () => (videoService as unknown as { pollOnce(): Promise<void> }).pollOnce();
    await poll();
    videoService.markRequested(id);
    t.mock.timers.tick(PULL_START_TIMEOUT_MS + 1000);
    await poll(); // the dial has now run out: reportDial() fails the same key
    assert.equal(lines.filter((l) => l.includes("Both cam")).length, 1, `two lines for one outage: ${JSON.stringify(lines.filter((l) => l.includes("Both cam")))}`);
    assert.match(lines.find((l) => l.includes("Both cam"))!, /No answer from 192\.0\.2\.62/, "the probe, which found it first, is the one that spoke");
  } finally {
    r.restore();
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("the relay's dial failing first, then a probe failure on the same feed, is still ONE line", async (t: TestContext) => {
  const lines = captureConsole(t, "log", "warn", "error");
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const id = await addPull("Dial first cam", "rtsp://192.0.2.63:554/BOX");
  const r = rig();
  r.answer = { state: "failed", reason: "No answer from 192.0.2.63 for this path · check the address and path" };
  videoService.attachRelay(fakeRelay({ status: async () => [notReadyPath(id)] }), new FakeSupervisor(), DEFAULT_VIDEO_PORTS);
  try {
    const poll = () => (videoService as unknown as { pollOnce(): Promise<void> }).pollOnce();
    await poll();
    videoService.markRequested(id);
    t.mock.timers.tick(PULL_START_TIMEOUT_MS + 1000);
    await poll();
    assert.equal(lines.filter((l) => l.includes("Dial first cam")).length, 1);
    assert.match(lines.find((l) => l.includes("Dial first cam"))!, /nothing from rtsp:\/\/192\.0\.2\.63:554\/BOX within 10 s/);

    await r.watch(true);
    await r.tick();
    assert.equal(lines.filter((l) => l.includes("Dial first cam")).length, 1, "the probe repeats what the dial already said");
  } finally {
    r.restore();
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("a camera that comes back says so once, after the answer has held for the settle window", async (t: TestContext) => {
  const lines = captureConsole(t, "log", "warn", "error");
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const id = await addPull("Flaky cam", "rtsp://192.0.2.64:554/BOX");
  const r = rig();
  r.answer = { state: "failed", reason: "192.0.2.64 is not reachable" };
  try {
    await r.watch(true);
    r.answer = { state: "ready" };
    await r.tick();
    assert.equal(lines.filter((l) => l.includes("answering again")).length, 0, "one good answer is not a recovery yet");
    for (let ms = 0; ms <= DEFAULT_SETTLE_MS + 15_000; ms += 15_000) {
      t.mock.timers.tick(15_000);
      await r.tick();
    }
    assert.equal(lines.filter((l) => l.includes("Flaky cam") && l.includes("the device is answering again")).length, 1);
    for (let i = 0; i < 3; i++) {
      t.mock.timers.tick(15_000);
      await r.tick();
    }
    assert.equal(lines.filter((l) => l.includes("answering again")).length, 1, "and not again on later answers");
  } finally {
    r.restore();
    await videoService.removeFeed(id);
  }
});

test("a camera that answers all along writes nothing", async (t: TestContext) => {
  const lines = captureConsole(t, "log", "warn", "error");
  const id = await addPull("Quiet cam", "rtsp://192.0.2.65:554/BOX");
  const r = rig();
  r.answer = { state: "ready", codec: "H264", width: 1920, height: 1080 };
  try {
    await r.watch(true);
    for (let i = 0; i < 3; i++) await r.tick();
    assert.deepEqual(lines.filter((l) => l.includes("Quiet cam")), []);
  } finally {
    r.restore();
    await videoService.removeFeed(id);
  }
});

test("with nobody on the page nothing is asked; a feed the relay reports ready is not asked either", async () => {
  const idle = await addPull("Idle cam", "rtsp://192.0.2.66:554/BOX");
  const live = await addPull("Live cam", "rtsp://192.0.2.67:554/BOX");
  const r = rig();
  videoService.attachRelay(fakeRelay({ status: async () => [readyPath(live), notReadyPath(idle)] }), new FakeSupervisor(), DEFAULT_VIDEO_PORTS);
  try {
    await r.watch(false);
    await r.tick();
    assert.equal(r.asked.length, 0, "no subscriber, no probe");

    await (videoService as unknown as { pollOnce(): Promise<void> }).pollOnce();
    await r.watch(true);
    assert.deepEqual(r.asked.filter((u) => u.includes("192.0.2.66") || u.includes("192.0.2.67")), ["rtsp://192.0.2.66:554/BOX"], "only the idle feed");

    await r.watch(false);
    const before = r.asked.length;
    await r.tick();
    assert.equal(r.asked.length, before, "leaving the page stops it");
  } finally {
    r.restore();
    await videoService.detachRelay();
    await videoService.removeFeed(idle);
    await videoService.removeFeed(live);
  }
});

test("with the Video feeds switch off no camera is asked, and switching it on while watched asks them", async () => {
  const id = await addPull("Switch cam", "rtsp://192.0.2.68:554/BOX");
  const r = rig();
  videoService.setVideoEnabled(false);
  try {
    await r.watch(true);
    assert.equal(r.asked.filter((u) => u.includes("192.0.2.68")).length, 0);
    assert.equal(videoService.probeState().feeds[id], undefined);

    videoService.setVideoEnabled(true);
    await settle();
    assert.equal(r.asked.filter((u) => u.includes("192.0.2.68")).length, 1);
    assert.equal(videoService.probeState().feeds[id]?.state, "ready");
  } finally {
    r.restore();
    await videoService.removeFeed(id);
  }
});

test("video:probe carries the results, never a password, and a removed feed is dropped from it", async () => {
  const keep = await addPull("Keep cam", "rtsp://192.0.2.69:554/BOX");
  const drop = await addPull("Drop cam", "rtsp://192.0.2.70:554/BOX");
  const r = rig();
  r.answer = { state: "ready", codec: "H264", width: 1920, height: 1080 };
  try {
    probeFrames.length = 0;
    await r.watch(true);
    const state = videoService.probeState();
    assert.equal(state.feeds[keep]?.state, "ready");
    assert.equal(state.feeds[keep]?.codec, "H264");
    assert.equal(state.feeds[keep]?.width, 1920);
    assert.ok(probeFrames.length > 0, "the channel was published to");
    assert.equal(JSON.stringify(probeFrames).includes(PASSWORD), false);

    await videoService.removeFeed(drop);
    await settle();
    assert.equal(videoService.probeState().feeds[drop], undefined, "the removed feed is gone");
    assert.equal(probeFrames.at(-1)!.feeds[drop], undefined, "and the page was told");
    assert.ok(videoService.probeState().feeds[keep], "the other feed stays");
  } finally {
    r.restore();
    await videoService.removeFeed(keep);
  }
});

test("the last subscriber leaving clears the snapshot a later hello burst would hydrate", async () => {
  const id = await addPull("Clear cam", "rtsp://192.0.2.71:554/BOX");
  const r = rig();
  try {
    await r.watch(true);
    assert.equal(videoService.probeState().feeds[id]?.state, "ready");
    await r.watch(false);
    assert.deepEqual(videoService.probeState().feeds, {});
  } finally {
    r.restore();
    await videoService.removeFeed(id);
  }
});

test("push and external feeds are never asked", async () => {
  const push = await videoService.addFeed({ name: "Push cam", source: { kind: "push", protocol: "srt" } });
  const ext = await videoService.addFeed({ name: "Ext cam", source: { kind: "external", url: "https://relay.example/whep" } });
  assert.ok(push.ok && ext.ok);
  const r = rig();
  try {
    await r.watch(true);
    assert.deepEqual(Object.keys(videoService.probeState().feeds).filter((k) => ["push-cam", "ext-cam"].includes(k)), []);
  } finally {
    r.restore();
    await videoService.removeFeed("push-cam");
    await videoService.removeFeed("ext-cam");
  }
});

test("a feed the relay was asked for a moment ago is not probed; once the request lapses it is", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const id = await addPull("Dialling cam", "rtsp://192.0.2.81:554/BOX");
  const r = rig();
  try {
    videoService.markRequested(id);
    await r.watch(true);
    assert.equal(r.asked.filter((u) => u.includes("192.0.2.81")).length, 0, "the relay may be dialling it: do not add a second DESCRIBE");
    t.mock.timers.tick(RECENT_REQUEST_MS + 1000);
    await r.tick();
    assert.equal(r.asked.filter((u) => u.includes("192.0.2.81")).length, 1);
  } finally {
    r.restore();
    await videoService.removeFeed(id);
  }
});

test("a round that cannot read the feeds warns once, and says so once when checking works again", async (t: TestContext) => {
  const lines = captureConsole(t, "log", "warn", "error");
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const id = await addPull("Round cam", "rtsp://192.0.2.82:554/BOX");
  const r = rig();
  const { videoFeedsStore } = await import("./feed-store.js");
  const realLoad = videoFeedsStore.load.bind(videoFeedsStore);
  videoFeedsStore.load = async () => {
    throw new Error("disk on fire");
  };
  try {
    await r.watch(true);
    for (let i = 0; i < 3; i++) await r.tick();
    assert.deepEqual(lines.filter((l) => l.includes("could not check the pulled feeds")), ["[video] could not check the pulled feeds: disk on fire"]);

    videoFeedsStore.load = realLoad;
    for (let ms = 0; ms <= DEFAULT_SETTLE_MS + 15_000; ms += 15_000) {
      t.mock.timers.tick(15_000);
      await r.tick();
    }
    assert.equal(lines.filter((l) => l.includes("checking the pulled feeds is working again")).length, 1);
  } finally {
    videoFeedsStore.load = realLoad;
    r.restore();
    await videoService.removeFeed(id);
  }
});

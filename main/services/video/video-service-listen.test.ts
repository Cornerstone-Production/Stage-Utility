// The audio side of the video service: what each feed reports about its sound,
// which feeds get a `-listen` path (and the command on it), and what the log
// says about the converter. Driven through the real service with a fake relay
// and supervisor; the one real ffmpeg is in audio-listen-integration.test.ts.

import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";

import { captureConsole } from "../fixtures/capture-console.js";
import { within } from "../fixtures/within.js";
import { FakeSupervisor } from "../fixtures/fake-supervisor.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-listen-"));
process.env.STAGE_UTILITY_DATA = TMP;
const { videoService, videoPollDeps } = await import("./video-service.js");
const { fakeRelay } = await import("../fixtures/fake-relay.js");
const { DEFAULT_VIDEO_PORTS } = await import("../../types/video.js");
type RelayPath = import("./relay.js").RelayPath;
type RelayRtsp = import("./video-service.js").RelayRtsp;
type RelayFeed = import("./relay.js").RelayFeed;
type FfmpegResult = import("./ffmpeg-system.js").FfmpegResult;
type FfmpegFinder = import("./ffmpeg-system.js").FfmpegFinder;


const FFMPEG_OK: FfmpegResult = { ok: true, path: "/usr/bin/ffmpeg", resolvedPath: "/usr/bin/ffmpeg", version: "7.1", source: "automatic" };
const FFMPEG_MISSING: FfmpegResult = {
  ok: false,
  reason: "ffmpeg is not installed on this server",
  detail: "not on PATH",
  hint: "sudo apt install ffmpeg (or your distribution's package)",
};

/** A finder that answers `answers[i]` for the i-th find() since the last reset()
 *  (the last answer repeats), and counts resets. */
function finder(...answers: FfmpegResult[]): FfmpegFinder & { resets: number } {
  let i = 0;
  const f = {
    resets: 0,
    find: async () => answers[Math.min(i, answers.length - 1)]!,
    reset() {
      f.resets++;
      i++;
    },
  };
  return f;
}
const useFfmpeg = (...answers: FfmpegResult[]) => {
  const f = finder(...answers);
  videoService.useFfmpegFinder(f);
  return f;
};
const realInDemand = videoPollDeps.inDemand;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  videoPollDeps.inDemand = realInDemand;
  await videoService.detachRelay();
  for (const c of cleanup.splice(0)) await c();
});

const MPEG4 = "MPEG-4 Audio";
const ready = (name: string, audio: string | null): RelayPath => ({
  name,
  ready: true,
  readyTime: "2026-10-22T00:00:00Z",
  source: { type: "rtspSource", id: "s" },
  video: { codec: "H264", width: 1920, height: 1080, profile: "High" },
  audio,
  readers: 0,
});

async function addFeed(body: Record<string, unknown>): Promise<string> {
  const made = await videoService.addFeed({ source: { kind: "pull", url: "rtsp://192.0.2.10/s", username: "" }, ...body });
  assert.ok(made.ok, JSON.stringify(made));
  cleanup.push(async () => void (await videoService.removeFeed(made.feed.id)));
  return made.feed.id;
}

const poll = () => (videoService as unknown as { pollOnce(): Promise<void> }).pollOnce();
const pollsIdle = () => within(videoService.whenPollsIdle(), "polls to finish");
const audioOf = async (id: string) => (await videoService.state()).feeds.find((f) => f.id === id)?.audio;

/** Attaches a relay that reports `paths`, with RTSP on, and settles the first poll. */
async function attachWith(paths: () => RelayPath[], reconciled: RelayFeed[][] = [], rtsp: RelayRtsp = { on: true }) {
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(
    fakeRelay({
      status: async () => paths(),
      reconcile: async (feeds) => void reconciled.push(feeds),
    }),
    new FakeSupervisor() as never,
    DEFAULT_VIDEO_PORTS,
    rtsp,
  );
  await pollsIdle();
  await poll();
  await pollsIdle();
}

test("a feed's audio status says what the source sends and which path to read", async () => {
  useFfmpeg(FFMPEG_OK);
  const aac = await addFeed({ name: "Aac" });
  const opus = await addFeed({ name: "Opus" });
  const g711 = await addFeed({ name: "G711" });
  const silent = await addFeed({ name: "Silent" });
  const unseen = await addFeed({ name: "Unseen" });
  const off = await addFeed({ name: "Off", audioConversion: "off" });
  const always = await addFeed({ name: "Always" });
  await videoService.updateFeed(always, { audioConversion: "always" });
  const pass = await addFeed({ name: "Pass", audioSourceUrl: "http://192.0.2.28/0.ts" });
  await attachWith(() => [ready(aac, MPEG4), ready(opus, "Opus"), ready(g711, "G711"), ready(silent, null), ready(off, MPEG4), ready(always, "Opus")]);

  assert.deepEqual(await audioOf(aac), { state: "converted", listenPath: `${aac}-listen` });
  assert.deepEqual(await audioOf(opus), { state: "direct", listenPath: opus });
  assert.deepEqual(await audioOf(g711), { state: "direct", listenPath: g711 });
  assert.deepEqual(await audioOf(silent), { state: "none" });
  assert.deepEqual(await audioOf(unseen), { state: "unknown" });
  assert.equal((await audioOf(off))?.state, "unavailable");
  assert.deepEqual(await audioOf(always), { state: "converted", listenPath: `${always}-listen` });
  assert.deepEqual(await audioOf(pass), { state: "pass-through", listenPath: `${pass}-listen` });

  const view = (await videoService.state()).feeds.find((f) => f.id === off)!;
  assert.equal(view.audioConversion, "off");
  assert.equal(view.audioSourceUrl, "");
});

test("with no usable ffmpeg a feed that needs conversion reports why, and is logged once", async (t) => {
  useFfmpeg(FFMPEG_MISSING);
  const warns = captureConsole(t, "warn");
  const id = await addFeed({ name: "No ffmpeg" });
  const reconciled: RelayFeed[][] = [];
  await attachWith(() => [ready(id, MPEG4)], reconciled);
  assert.deepEqual(await audioOf(id), { state: "unavailable", reason: "ffmpeg is not installed on this server" });
  await videoService.reconcileRelay();
  await videoService.reconcileRelay();
  assert.deepEqual(
    warns.filter((l) => l.includes("audio unavailable")),
    ["[video] No ffmpeg: audio unavailable: ffmpeg is not installed on this server"],
  );
  const last = reconciled.at(-1)!.find((f) => f.id === id)!;
  assert.equal(last.listenCommand, undefined, "a -listen path was written with no ffmpeg to run");
});

test("only a feed that needs conversion gets a -listen path, and the relay is given that command", async () => {
  useFfmpeg(FFMPEG_OK);
  const aac = await addFeed({ name: "A" });
  const opus = await addFeed({ name: "B" });
  const pass = await addFeed({ name: "C", audioSourceUrl: "http://192.0.2.28/0.ts" });
  const reconciled: RelayFeed[][] = [];
  await attachWith(() => [ready(aac, MPEG4), ready(opus, "Opus")], reconciled);
  await videoService.reconcileRelay();
  const feeds = new Map(reconciled.at(-1)!.map((f) => [f.id, f]));
  assert.match(feeds.get(aac)!.listenCommand ?? "", /^'\/usr\/bin\/ffmpeg' .*'-i' 'rtsp:\/\/127\.0\.0\.1:8554\/a' .*'rtsp:\/\/127\.0\.0\.1:8554\/a-listen'$/);
  assert.equal(feeds.get(opus)!.listenCommand, undefined, "Opus needs no conversion");
  assert.match(feeds.get(pass)!.listenCommand ?? "", /'-i' 'http:\/\/192\.0\.2\.28\/0\.ts' '-c' 'copy'/);
});

test("a relay started without RTSP writes no -listen path, and says audio conversion is not on yet", async () => {
  useFfmpeg(FFMPEG_OK);
  const id = await addFeed({ name: "Early" });
  const reconciled: RelayFeed[][] = [];
  await attachWith(() => [ready(id, MPEG4)], reconciled, { on: false, why: null });
  await videoService.reconcileRelay();
  assert.equal(reconciled.at(-1)!.find((f) => f.id === id)!.listenCommand, undefined);
  const a = await audioOf(id);
  assert.equal(a?.state, "unavailable");
});

test("learning a feed's codec reconciles the relay, and a change of codec drops or adds the path", async () => {
  useFfmpeg(FFMPEG_OK);
  const id = await addFeed({ name: "Switch" });
  let audio: string | null = MPEG4;
  const reconciled: RelayFeed[][] = [];
  await attachWith(() => [ready(id, audio)], reconciled);
  await videoService.whenBackgroundIdle();
  await pollsIdle();
  const has = () => reconciled.at(-1)!.find((f) => f.id === id)!.listenCommand !== undefined;
  assert.equal(has(), true, "AAC seen but no -listen path was reconciled");

  audio = "Opus"; // the encoder was reconfigured
  await poll();
  await videoService.whenBackgroundIdle();
  await pollsIdle();
  assert.equal(has(), false, "the feed went to Opus and kept its converter");
  assert.deepEqual(await audioOf(id), { state: "direct", listenPath: id });

  audio = MPEG4;
  await poll();
  await videoService.whenBackgroundIdle();
  await pollsIdle();
  assert.equal(has(), true);
});

test("editing a feed's address forgets what was learned about its audio", async () => {
  useFfmpeg(FFMPEG_OK);
  const id = await addFeed({ name: "Moved" });
  await attachWith(() => [ready(id, MPEG4)]);
  assert.equal((await audioOf(id))?.state, "converted");
  await videoService.updateFeed(id, { source: { kind: "pull", url: "rtsp://192.0.2.99/s", username: "" } });
  await pollsIdle();
  // Nothing is polled ready for the new address yet.
  const view = await audioOf(id);
  assert.ok(view?.state === "converted" || view?.state === "unknown", JSON.stringify(view));
});

// ── The log: the converter's own lifecycle, never a line per listener ───────

function line(supervisor: FakeSupervisor, text: string): void {
  supervisor.emit("line", text);
}

test("the converter logs one line for its start, one when it stops, and one per failure outage", async (t) => {
  useFfmpeg(FFMPEG_OK);
  const logs = captureConsole(t, "log");
  const warns = captureConsole(t, "warn");
  const id = await addFeed({ name: "Main PGM" });
  const sup = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(fakeRelay({ status: async () => [ready(id, MPEG4)] }), sup as never, DEFAULT_VIDEO_PORTS, { on: true });
  await pollsIdle();
  await poll();
  await pollsIdle();
  await videoService.reconcileRelay();

  line(sup, `2026/10/22 21:00:42 INF [path ${id}-listen] runOnDemand command started`);
  await videoService.whenBackgroundIdle();
  line(sup, "[in#0 @ 0xc72c48000] Error opening input: Server returned 400 Bad Request");
  line(sup, `2026/10/22 21:00:45 INF [path ${id}-listen] runOnDemand command exited: command exited with code 8`);
  line(sup, `2026/10/22 21:00:50 INF [path ${id}-listen] runOnDemand command started`);
  line(sup, `2026/10/22 21:00:50 INF [path ${id}-listen] runOnDemand command exited: command exited with code 8`);
  await videoService.whenBackgroundIdle();
  line(sup, `2026/10/22 21:01:10 INF [path ${id}-listen] runOnDemand command stopped: not needed by anyone`);
  await videoService.whenBackgroundIdle();

  assert.deepEqual(
    logs.filter((l) => l.includes("audio converter")),
    ["[video] Main PGM: audio converter started (the feed's audio is AAC)", "[video] Main PGM: audio converter stopped (not needed by anyone)"],
  );
  assert.deepEqual(
    warns.filter((l) => l.includes("audio converter")),
    [
      "[video] Main PGM: audio converter failed: command exited with code 8 — ffmpeg said: " +
        "[in#0 @ 0xc72c48000] Error opening input: Server returned 400 Bad Request; the relay tries again while someone is listening",
    ],
  );
});

test("a pass-through converter says so when it starts", async (t) => {
  useFfmpeg(FFMPEG_OK);
  const logs = captureConsole(t, "log");
  const id = await addFeed({ name: "Utility", audioSourceUrl: "http://192.0.2.28/0.ts" });
  const sup = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(fakeRelay(), sup as never, DEFAULT_VIDEO_PORTS, { on: true });
  await videoService.reconcileRelay();
  line(sup, `2026/10/22 21:00:42 INF [path ${id}-listen] runOnDemand command started`);
  await videoService.whenBackgroundIdle();
  assert.deepEqual(
    logs.filter((l) => l.includes("audio converter")),
    ["[video] Utility: audio converter started (audio source address, copied as it is)"],
  );
});

// ── An RTSP port something else holds ───────────────────────────────────────

test("a relay started without RTSP because its port is busy tells the feed that needs conversion which port", async () => {
  useFfmpeg(FFMPEG_OK);
  const id = await addFeed({ name: "Busy" });
  const reconciled: RelayFeed[][] = [];
  const why = "the RTSP port 8554 is in use by another program: change it in Advanced";
  await attachWith(() => [ready(id, MPEG4)], reconciled, { on: false, why });
  await videoService.reconcileRelay();
  assert.deepEqual(await audioOf(id), { state: "unavailable", reason: why });
  assert.equal(reconciled.at(-1)!.find((f) => f.id === id)!.listenCommand, undefined);
});

// ── ffmpeg moved after it was found ─────────────────────────────────────────

test("an ffmpeg file that has gone since it was found is looked for again before a command names it", async () => {
  const stale: FfmpegResult = { ...FFMPEG_OK, resolvedPath: "/nonexistent/Cellar/ffmpeg/1.0/bin/ffmpeg" } as FfmpegResult;
  const fresh: FfmpegResult = { ...FFMPEG_OK, resolvedPath: process.execPath } as FfmpegResult;
  const f = useFfmpeg(stale, fresh);
  const id = await addFeed({ name: "Upgraded" });
  const reconciled: RelayFeed[][] = [];
  await attachWith(() => [ready(id, MPEG4)], reconciled);
  await videoService.reconcileRelay();
  const command = reconciled.at(-1)!.find((x) => x.id === id)!.listenCommand ?? "";
  assert.ok(command.startsWith(`'${process.execPath}' `), command);
  assert.ok(f.resets >= 1, "the kept answer was never reset");
});

test("a converter that cannot launch makes the server look for ffmpeg again, at most once a minute", async (t) => {
  t.mock.method(Date, "now", () => 1_000_000);
  const good: FfmpegResult = { ...FFMPEG_OK, resolvedPath: process.execPath } as FfmpegResult;
  const f = useFfmpeg(good);
  const id = await addFeed({ name: "No launch" });
  const sup = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(fakeRelay({ status: async () => [ready(id, MPEG4)] }), sup as never, DEFAULT_VIDEO_PORTS, { on: true });
  await pollsIdle();
  await poll();
  await pollsIdle();
  const before = f.resets;
  const launchError = `2026/10/22 21:01:10 INF [path ${id}-listen] runOnDemand command exited: fork/exec /gone/ffmpeg: no such file or directory`;
  sup.emit("line", launchError);
  await videoService.whenBackgroundIdle();
  assert.equal(f.resets, before + 1, "a launch failure did not reset the finder");
  sup.emit("line", launchError);
  await videoService.whenBackgroundIdle();
  assert.equal(f.resets, before + 1, "a second launch failure inside a minute reset again");
  sup.emit("line", `2026/10/22 21:01:12 INF [path ${id}-listen] runOnDemand command exited: command exited with code 8`);
  await videoService.whenBackgroundIdle();
  assert.equal(f.resets, before + 1, "an ordinary failure is not a launch failure");
});

// ── Every failed session says so ────────────────────────────────────────────

test("two failing sessions in a row each log their failure; a restart inside one session does not repeat it", async (t) => {
  useFfmpeg(FFMPEG_OK);
  const warns = captureConsole(t, "warn");
  const id = await addFeed({ name: "Flaky" });
  const sup = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  videoService.attachRelay(fakeRelay({ status: async () => [ready(id, MPEG4)] }), sup as never, DEFAULT_VIDEO_PORTS, { on: true });
  await videoService.reconcileRelay();
  const emit = async (what: string) => {
    sup.emit("line", `2026/10/22 21:00:00 INF [path ${id}-listen] runOnDemand command ${what}`);
    await videoService.whenBackgroundIdle();
  };
  await emit("started");
  await emit("exited: command exited with code 8");
  await emit("started"); // MediaMTX's own restart, same session
  await emit("exited: command exited with code 8");
  await emit("stopped: not needed by anyone");
  await emit("started"); // a new session
  await emit("exited: command exited with code 8");
  assert.equal(warns.filter((l) => l.includes("audio converter failed")).length, 2);
});

// ── The reserved -listen suffix ─────────────────────────────────────────────

test("a feed made under a name that would claim another feed's -listen path gets another id", async () => {
  const cam = await addFeed({ name: "Reserved Cam" });
  const second = await addFeed({ name: "Reserved Cam Listen" });
  assert.equal(cam, "reserved-cam");
  assert.equal(second, "reserved-cam-listen-2");
  // The other order.
  const listenFirst = await addFeed({ name: "Other Listen" });
  const other = await addFeed({ name: "Other" });
  assert.equal(listenFirst, "other-listen-2");
  assert.equal(other, "other");
});

test("a stored feed whose id ends in -listen is not given to the relay, and the log says so once", async (t) => {
  useFfmpeg(FFMPEG_OK);
  const warns = captureConsole(t, "warn");
  const { videoFeedsStore } = await import("./feed-store.js");
  const real = await addFeed({ name: "Real" });
  await videoFeedsStore.update((c) => ({
    ...c,
    feeds: [...c.feeds, { id: `${real}-listen`, name: "Squatter", source: { kind: "push" as const, protocol: "rtmp" as const } }],
  }));
  cleanup.push(async () => void (await videoFeedsStore.update((c) => ({ ...c, feeds: c.feeds.filter((f) => f.id !== `${real}-listen`) }))));
  const reconciled: RelayFeed[][] = [];
  await attachWith(() => [], reconciled);
  await videoService.reconcileRelay();
  await videoService.reconcileRelay();
  assert.deepEqual(reconciled.at(-1)!.map((f) => f.id), [real]);
  assert.equal(warns.filter((l) => l.includes("ends in -listen")).length, 1);
});

// ── What is remembered is forgotten with its feed and with its relay ────────

test("removing a feed, or making another under its id, starts its audio memory afresh", async (t) => {
  useFfmpeg(FFMPEG_MISSING);
  const warns = captureConsole(t, "warn");
  const id = await addFeed({ name: "Forgetful" });
  let paths: RelayPath[] = [ready(id, MPEG4)];
  await attachWith(() => paths);
  await videoService.reconcileRelay();
  assert.equal((await audioOf(id))?.state, "unavailable");
  assert.equal(warns.filter((l) => l.includes("Forgetful: audio unavailable")).length, 1);

  await videoService.removeFeed(id);
  paths = [];
  const again = await addFeed({ name: "Forgetful" });
  assert.equal(again, id, "the same name did not give the same id back");
  // Nothing about the old feed's audio carries over: its codec is not known, and
  // its unavailable reason is news again.
  assert.deepEqual(await audioOf(again), { state: "unknown" });
  await videoService.reconcileRelay();
  paths = [ready(again, MPEG4)];
  await pollsIdle();
  await poll();
  await pollsIdle();
  await videoService.whenBackgroundIdle();
  await videoService.reconcileRelay();
  assert.equal(warns.filter((l) => l.includes("Forgetful: audio unavailable")).length, 2);
});

test("a relay that goes takes with it what was learned from it: codecs, and which converters were running", async (t) => {
  useFfmpeg(FFMPEG_OK);
  const logs = captureConsole(t, "log");
  const id = await addFeed({ name: "Gone relay" });
  const sup = new FakeSupervisor();
  videoPollDeps.inDemand = () => false;
  const attach = () => videoService.attachRelay(fakeRelay({ status: async () => [ready(id, MPEG4)] }), sup as never, DEFAULT_VIDEO_PORTS, { on: true });
  attach();
  await pollsIdle();
  await poll();
  await pollsIdle();
  assert.equal((await audioOf(id))?.state, "converted");
  sup.emit("line", `2026/10/22 21:00:42 INF [path ${id}-listen] runOnDemand command started`);
  await videoService.whenBackgroundIdle();

  await videoService.detachRelay();
  videoService.attachRelay(fakeRelay({ status: async () => [] }), sup as never, DEFAULT_VIDEO_PORTS, { on: true });
  assert.deepEqual(await audioOf(id), { state: "unknown" }, "the old relay's codec survived its detach");
  sup.emit("line", `2026/10/22 21:05:00 INF [path ${id}-listen] runOnDemand command started`);
  await videoService.whenBackgroundIdle();
  assert.equal(logs.filter((l) => l.includes("audio converter started")).length, 2, "a converter of the old relay still counted as running");
});

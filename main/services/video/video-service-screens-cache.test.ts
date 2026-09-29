// video-service-screens-cache.test.ts — VideoState.screens is a CACHE,
// written only when a heartbeat's own record() call says something changed,
// or by the one-shot expiry timer for a pair nothing heartbeats again —
// never a fresh playbackHealth.snapshot(Date.now()) read inside state()
// itself.
//
// Measured live: a fake relay polled every 3 s for 90 s gave 0 broadcasts
// with no screen reporting, and 15 with one healthy screen heartbeating
// every 9 s — because the window totals and `reportedAt` move on almost
// every tick and as samples age out, and publishOnce()'s whole-body diff
// read that as a real change every time, dragging integrations:state-changed
// (setRelayStatusListener) along with it for nothing having actually
// changed.

import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";

import { captureConsole } from "../fixtures/capture-console.js";
import { fakeRelay } from "../fixtures/fake-relay.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-screens-cache-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { videoService, videoPollDeps } = await import("./video-service.js");
const { stageController } = await import("../stage-controller.js");
const { addBroadcastListener } = await import("../broadcaster.js");
const { WINDOW_MS, CLEAR_AFTER_MS } = await import("./playback-health.js");
const { DEFAULT_VIDEO_PORTS } = await import("../../types/video.js");

type VideoPlaybackReport = import("../../types/video.js").VideoPlaybackReport;
type VideoState = import("../../types/video.js").VideoState;
type RelayStatus = import("../../types/video.js").RelayStatus;
type SupervisorStatus = import("./supervisor.js").SupervisorStatus;
type RelaySupervisorLike = import("./video-service.js").RelaySupervisorLike;

/** The smallest RelaySupervisorLike that reports "running" — enough to let
 *  attachRelay()/pollOnce() run without a real MediaMTX process. */
class FakeSupervisor extends EventEmitter implements RelaySupervisorLike {
  status(): SupervisorStatus {
    return { state: "running", since: 1 };
  }
  version(): string | null {
    return null;
  }
}

const OUTPUT_ID = stageController.getOutputs()[0]!.id;
const OUTPUT_NAME = stageController.getOutputs()[0]!.name;

const frames: VideoState[] = [];
addBroadcastListener((channel, payload) => {
  if (channel === "video:state") frames.push(payload as VideoState);
});

function report(overrides: Partial<VideoPlaybackReport> = {}): VideoPlaybackReport {
  return { feedId: "feed-1", via: "webrtc", decoded: 1000, dropped: 0, stalls: 0, width: 1920, height: 1080, ...overrides };
}

async function addRelayFeed(name: string): Promise<string> {
  const made = await videoService.addFeed({ name, source: { kind: "external", url: "https://relay.example/whep" } });
  assert.ok(made.ok, "expected the fixture feed to be added");
  return (made as { feed: { id: string } }).feed.id;
}

/** See video-service-playback-health.test.ts's own copy for why this is
 *  iteration-bounded rather than Date.now()-bounded. */
async function settle(iterations = 20): Promise<void> {
  for (let i = 0; i < iterations; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Waits until `done()` holds, or fails after 5 s of wall-clock time. A
 * heartbeat's publish runs fire-and-forget behind real file reads (the relay
 * binary and archive checks in state()), so a fixed number of turns can end
 * before it lands under load, and a frame count read then is short by one.
 * performance.now(), not Date.now(): several tests here fake Date.
 */
async function settleUntil(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!done() && performance.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(done(), `timed out waiting for ${what}`);
}

const pollOnce = () => (videoService as unknown as { pollOnce(): Promise<void> }).pollOnce();

// ── The relay's own status poll must not broadcast on its own ─────────────

test("a healthy screen's own heartbeats, with the relay's status poll running alongside them, broadcast nothing beyond the pair's own first appearance — and never fire the relay status listener for a broadcast that never happened", async (t: TestContext) => {
  const id = await addRelayFeed("Poll-quiet feed");
  const relay = fakeRelay({ status: async () => [] });
  const supervisor = new FakeSupervisor();
  const realInDemand = videoPollDeps.inDemand;
  videoPollDeps.inDemand = () => false; // pollOnce() driven by hand below, on the measured cadence
  const statusCalls: RelayStatus[] = [];
  videoService.setRelayStatusListener((s) => statusCalls.push(s));
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  try {
    videoService.attachRelay(relay, supervisor, DEFAULT_VIDEO_PORTS);
    await settle();

    // Seed the pair once, outside the measured window — a pair APPEARING is
    // legitimately one change (playback-health.test.ts covers that), and is
    // not what this test means to prove.
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id })]);
    await settleUntil(() => frames.at(-1)?.screens.some((s) => s.feedId === id) === true, "the pair's first appearance to publish");
    await settle();
    const before = frames.length;
    const beforeStatusCalls = statusCalls.length;

    // The measured shape: the relay polled every 3 s for 90 s, one healthy
    // heartbeat every 9 s — same decoded count every time, never struggling.
    for (let elapsed = 0; elapsed < 90_000; elapsed += 3_000) {
      await pollOnce();
      if (elapsed % 9_000 === 0) videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id })]);
      t.mock.timers.tick(3_000);
      await settle();
    }

    assert.equal(frames.length, before, "a healthy screen's own heartbeats, and the relay poll running alongside them, must broadcast nothing once the pair already exists");
    assert.equal(statusCalls.length, beforeStatusCalls, "the relay status listener must not fire for a video:state broadcast that never happened");
  } finally {
    videoService.setRelayStatusListener(null);
    videoPollDeps.inDemand = realInDemand;
    await videoService.detachRelay();
    await videoService.removeFeed(id);
  }
});

test("twelve struggling heartbeats that each publish call the relay status listener once, while the relay status never changes", async (t: TestContext) => {
  const id = await addRelayFeed("Listener-quiet feed");
  const statusCalls: RelayStatus[] = [];
  videoService.setRelayStatusListener((s) => statusCalls.push(s));
  captureConsole(t, "log"); // crosses into struggling on purpose; not asserting on the line
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  try {
    const before = frames.length;
    // Each heartbeat drops a larger share than the window so far, so every
    // one moves the episode and publishes.
    for (let i = 0; i < 12; i++) {
      videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 1000, dropped: 60 + 40 * i })]);
      await settleUntil(() => frames.length === before + i + 1, `heartbeat ${i + 1}'s publish`);
      t.mock.timers.tick(1_000);
    }
    await settle();
    assert.equal(frames.length, before + 12, "sanity: every heartbeat published");
    assert.equal(new Set(statusCalls.map((s) => JSON.stringify(s))).size, 1, "sanity: one distinct relay status throughout");
    assert.equal(statusCalls.length, 1, "the listener hears a relay status once, not once per video:state publish");
  } finally {
    videoService.setRelayStatusListener(null);
    await videoService.removeFeed(id);
  }
});

test("a struggling pair publishes when its episode moves, and not when only its live window does", async (t: TestContext) => {
  const id = await addRelayFeed("Episode-gated feed");
  captureConsole(t, "log"); // crosses into struggling on purpose; not asserting on the line
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  try {
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 1000, dropped: 200 })]); // 20%: the episode
    await settleUntil(() => frames.at(-1)?.screens.some((s) => s.feedId === id && s.struggling) === true, "the struggle to publish");
    await settle();

    const before = frames.length;
    t.mock.timers.tick(1_000);
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 1000, dropped: 20 })]); // window 11%: milder
    await settle();
    assert.equal(frames.length, before, "a live window that moved while the episode held must not publish");

    t.mock.timers.tick(1_000);
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 1000, dropped: 900 })]); // window 37%: worse
    await settleUntil(() => frames.length >= before + 1, "the moved episode to publish");
    await settle();
    assert.equal(frames.length, before + 1, "an episode that moved publishes once");
    const health = (await videoService.state()).screens.find((s) => s.feedId === id);
    assert.deepEqual(health?.episode, { droppedInWindow: 1120, decodedInWindow: 3000, stallsInWindow: 0, width: 1920, height: 1080 });
  } finally {
    await videoService.removeFeed(id);
  }
});

// ── The one-shot expiry timer, for a pair nothing heartbeats again ─────────

test("a struggling pair that stops reporting entirely is published as gone once WINDOW_MS has passed, with no further heartbeat", async (t: TestContext) => {
  const id = await addRelayFeed("Goes-dark feed");
  const lines = captureConsole(t, "log");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  try {
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 1000, dropped: 51 })]);
    await settle();
    assert.equal((await videoService.state()).screens.some((s) => s.feedId === id), true, "sanity: the pair is recorded");
    const before = frames.length;

    // No further heartbeat at all — only the expiry timer can notice this.
    t.mock.timers.tick(WINDOW_MS);
    await settleUntil(() => frames.length > before, "the timer's publish");

    assert.ok(frames.length > before, "the timer firing must publish — a client with the page open must be told the pair is gone");
    assert.equal((await videoService.state()).screens.some((s) => s.feedId === id), false, "the pair itself must be gone once nothing has heartbeated it for a full WINDOW_MS");
    assert.ok(lines.some((l) => l.includes("Goes-dark feed")), "sanity: the struggling line itself did fire earlier");
  } finally {
    await videoService.removeFeed(id);
  }
});

test("a struggling pair's sticky flag clears at exactly CLEAR_AFTER_MS with no further heartbeat, driven by the timer, even while the pair itself is still held", async (t: TestContext) => {
  const id = await addRelayFeed("Clears-quietly feed");
  const lines = captureConsole(t, "log");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  try {
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 1000, dropped: 51 })]);
    await settle();

    // ONE clean keep-alive, refreshing reportedAt without re-arming
    // lastBadAt — this is what keeps the PAIR ITSELF held (its own
    // WINDOW_MS-from-reportedAt expiry lands at t0+30s+WINDOW_MS, well past
    // the CLEAR_AFTER_MS-from-the-bad-sample boundary this test means to
    // isolate) so the timer's CLEAR_AFTER_MS branch, not its WINDOW_MS one,
    // is what is actually being proven here.
    t.mock.timers.tick(30_000);
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 10_000, dropped: 0 })]);
    await settle();

    // No further heartbeat. 30 s more (60 s total since the bad sample, 30 s
    // since the keep-alive) is CLEAR_AFTER_MS since the bad sample, well
    // short of another WINDOW_MS since the keep-alive.
    t.mock.timers.tick(CLEAR_AFTER_MS - 30_000);
    await settle();

    const health = (await videoService.state()).screens.find((s) => s.feedId === id);
    assert.ok(health, "the pair must still be held — only CLEAR_AFTER_MS, not WINDOW_MS, has passed since its last report");
    assert.equal(health!.struggling, false, "the sticky flag must have cleared, driven by the timer alone");
    assert.ok(lines.some((l) => l.includes("Clears-quietly feed") && l.includes("smoothly again")), "the recovery must be logged, not only published silently");
  } finally {
    await videoService.removeFeed(id);
  }
});

// ── A flag the expiry timer clears starts the next episode fresh ───────────

test("after the expiry timer clears a stall episode, the next struggle logs and publishes its own drops, not the old stalls", async (t: TestContext) => {
  const id = await addRelayFeed("Fresh-episode feed");
  const lines = captureConsole(t, "log");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  try {
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 300, dropped: 0, stalls: 5 })]);
    await settle();
    for (let i = 1; i <= 5; i++) {
      t.mock.timers.tick(10_000);
      videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 400, dropped: 0, stalls: 0 })]);
      await settle();
    }
    // 60 s after the stalls, with no heartbeat: the timer clears the flag.
    t.mock.timers.tick(10_000);
    await settle();
    assert.ok(lines.some((l) => l.includes("Fresh-episode feed") && l.includes("smoothly again")), "sanity: the timer cleared the flag");

    t.mock.timers.tick(500);
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 300, dropped: 150, stalls: 0, width: 1920, height: 1080 })]);
    await settle();

    const struggling = lines.filter((l) => l.includes("Fresh-episode feed") && l.includes("is struggling"));
    assert.deepEqual(struggling.slice(1), [
      `[video] ${OUTPUT_NAME} is struggling with Fresh-episode feed: dropped 150 frames for 2300 decoded, 0 stalls in the last minute`,
    ]);
    const health = (await videoService.state()).screens.find((s) => s.feedId === id);
    assert.deepEqual(health?.episode, { droppedInWindow: 150, decodedInWindow: 2300, stallsInWindow: 0, width: 1920, height: 1080 });
  } finally {
    await videoService.removeFeed(id);
  }
});

test("a clean heartbeat after the expiry timer has already published the clear publishes nothing", async (t: TestContext) => {
  const id = await addRelayFeed("Already-cleared feed");
  captureConsole(t, "log"); // crosses into struggling on purpose; not asserting on the line
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  try {
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 300, dropped: 0, stalls: 5 })]);
    await settle();
    t.mock.timers.tick(30_000);
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 400, dropped: 0, stalls: 0 })]);
    await settle();
    t.mock.timers.tick(CLEAR_AFTER_MS - 30_000);
    await settleUntil(() => frames.at(-1)?.screens.find((s) => s.feedId === id)?.struggling === false, "the timer's clear to publish");
    await settle();

    const before = frames.length;
    t.mock.timers.tick(10_000);
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 400, dropped: 0, stalls: 0 })]);
    await settle();
    assert.equal(frames.length, before, "the clear is already published; a clean heartbeat after it has nothing new to say");
  } finally {
    await videoService.removeFeed(id);
  }
});

// ── lastLoggedStruggling must not outlive the pair it names ────────────────

test("a pair that leaves while struggling and comes back later gets a FRESH struggling line, not silence from a stale prior announcement", async (t: TestContext) => {
  const id = await addRelayFeed("Comes-back-struggling feed");
  const lines = captureConsole(t, "log");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  try {
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 1000, dropped: 51 })]);
    await settle();
    // Let it age fully out — no heartbeat for a full WINDOW_MS.
    t.mock.timers.tick(WINDOW_MS);
    await settle();
    assert.equal((await videoService.state()).screens.some((s) => s.feedId === id), false, "sanity: the pair is genuinely gone");

    t.mock.timers.tick(60_000); // well clear of any lingering window math
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 1000, dropped: 51 })]);
    await settle();

    const own = lines.filter((l) => l.includes("Comes-back-struggling feed") && l.includes("is struggling"));
    assert.equal(own.length, 2, "both the original struggle and the one after coming back must each get their own line");
  } finally {
    await videoService.removeFeed(id);
  }
});

test("a pair that leaves while struggling and comes back CLEAN logs no spurious \"smoothly again\" for a struggle nothing in this episode ever announced", async (t: TestContext) => {
  const id = await addRelayFeed("Comes-back-clean feed");
  const lines = captureConsole(t, "log");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  try {
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 1000, dropped: 51 })]);
    await settle();
    t.mock.timers.tick(WINDOW_MS);
    await settle();
    assert.equal((await videoService.state()).screens.some((s) => s.feedId === id), false, "sanity: the pair is genuinely gone");

    t.mock.timers.tick(60_000);
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 1000, dropped: 0 })]);
    await settle();

    assert.equal(
      lines.some((l) => l.includes("Comes-back-clean feed") && l.includes("smoothly again")),
      false,
      "nothing in THIS episode was ever announced as struggling, so there is nothing to announce recovering from",
    );
  } finally {
    await videoService.removeFeed(id);
  }
});

// ── removeFeed()'s own lastLoggedStruggling cleanup ─────────────────────────

test("removeFeed's own lastLoggedStruggling cleanup: without it, a re-added feed's first genuine struggle is silently swallowed by the deleted one's stale announcement", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const made = await videoService.addFeed({ name: "Reused name", source: { kind: "external", url: "https://relay.example/reused" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  const lines = captureConsole(t, "log");
  try {
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 1000, dropped: 51 })]);
    await settle();
    assert.ok(lines.some((l) => l.includes("Reused name") && l.includes("is struggling")), "sanity: the original struggle was announced");

    await videoService.removeFeed(id);
    const again = await videoService.addFeed({ name: "Reused name", source: { kind: "external", url: "https://relay.example/reused2" } });
    assert.ok(again.ok);
    const sameId = (again as { feed: { id: string } }).feed.id;
    assert.equal(sameId, id, "sanity: the re-added feed must mint the identical id for this guard to mean anything");

    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: sameId, decoded: 1000, dropped: 51 })]);
    await settle();

    const own = lines.filter((l) => l.includes("Reused name") && l.includes("is struggling"));
    assert.equal(own.length, 2, "the re-added feed's OWN first struggle must be announced, not silently matched against the deleted one's stale `true`");
  } finally {
    await videoService.removeFeed(id);
  }
});

// ── A heartbeat must not re-seed a pair the feed STORE has already lost ────

test("a heartbeat naming a feed the feed STORE has already dropped is not recorded, even before video-service's own publish() has caught up", async () => {
  const id = await addRelayFeed("Racing feed");
  // Removes the feed from the STORE directly, bypassing removeFeed()
  // entirely — this reproduces exactly the moment removeFeed() itself
  // passes through mid-flight (the store write has landed; nothing has
  // called publish() yet) without depending on hitting a specific tick of a
  // real async race, which real removeFeed() resolves in ~2 ms end to end
  // on a local disk — too fast to reliably land a heartbeat inside any one
  // phase of it from outside.
  const { videoFeedsStore } = await import("./feed-store.js");
  await videoFeedsStore.update((current) => ({ ...current, feeds: current.feeds.filter((f) => f.id !== id) }));
  assert.equal((await videoService.state()).feeds.some((f) => f.id === id), false, "sanity: a fresh state() read already sees the store's current list");

  videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 500, dropped: 0 })]);
  await settle();

  const screens = (await videoService.state()).screens;
  assert.equal(screens.some((s) => s.feedId === id), false, "a heartbeat naming a feed the store no longer holds must not be recorded, whatever video-service's own published snapshot still says");
});

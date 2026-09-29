// video-service-playback-health.test.ts — the wiring between a presence
// heartbeat's `video` field and VideoState.screens: which reports get
// recorded, when the service actually publishes, and the flip-only
// `[video]` log lines.
//
// Not covered here: the HTTP route itself (remote-server.ts's presence POST
// handler) — see remote-server-presence-route.test.ts for the route, and
// remote-server-presence.test.ts for the body-handling function it calls
// into. The two checks below (an unknown outputId, and
// parseVideoReports's whole-array refusal) are exercised directly against
// the real videoService singleton, the same way every other
// video-service.test.ts guard is.

import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";

import { captureConsole } from "../fixtures/capture-console.js";
import { addRelayFeed, report, settle, settleUntil } from "../fixtures/video-playback.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-playback-health-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { videoService } = await import("./video-service.js");
const { stageController } = await import("../stage-controller.js");
const { addBroadcastListener } = await import("../broadcaster.js");
const { CLEAR_AFTER_MS, WINDOW_MS } = await import("./playback-health.js");

type VideoState = import("../../types/video.js").VideoState;

// The one output stageController starts with, before any load() — see its
// own constructor default. Read rather than hard-coded: PRIMARY_DISPLAY_ID
// is not exported, and re-deriving its literal value here would be a second
// copy that could silently drift from the real one.
const OUTPUT_ID = stageController.getOutputs()[0]!.id;
const OUTPUT_NAME = stageController.getOutputs()[0]!.name;

const frames: VideoState[] = [];
addBroadcastListener((channel, payload) => {
  if (channel === "video:state") frames.push(payload as VideoState);
});

test("recordPlaybackReports drops a report for an unknown feed id on its own, without refusing the rest of the heartbeat", async () => {
  const id = await addRelayFeed("Known feed");
  try {
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 500, dropped: 0 }), report({ feedId: "no-such-feed", decoded: 999, dropped: 999 })]);
    await settle();
    const screens = (await videoService.state()).screens;
    assert.deepEqual(screens.map((s) => s.feedId), [id], "only the known feed id may be recorded");
  } finally {
    await videoService.removeFeed(id);
  }
});

test("recordPlaybackReports records nothing for an outputId that names no real output", async () => {
  const id = await addRelayFeed("Orphan-output feed");
  try {
    videoService.recordPlaybackReports("no-such-output", [report({ feedId: id })]);
    await settle();
    const screens = (await videoService.state()).screens;
    assert.equal(screens.some((s) => s.feedId === id), false, "an unknown outputId must not seed a screen entry");
  } finally {
    await videoService.removeFeed(id);
  }
});

test("recordPlaybackReports publishes only when playbackHealth.record() reports a change", async (t: TestContext) => {
  const id = await addRelayFeed("Publish-gated feed");
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  captureConsole(t, "log"); // this test crosses into struggling on purpose; not asserting on the line
  try {
    const before = frames.length;
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 1000, dropped: 51 })]);
    await settleUntil(() => frames.length >= before + 1, "the struggle to publish");
    await settle();
    assert.equal(frames.length, before + 1, "crossing into struggling must publish once");

    // A second, all-zero heartbeat for the same still-struggling pair: no
    // new fact for a client to learn, so no second publish.
    t.mock.timers.tick(1);
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 0, dropped: 0, stalls: 0 })]);
    await settle();
    assert.equal(frames.length, before + 1, "a report that changes nothing struggling reads must not publish again");
  } finally {
    await videoService.removeFeed(id);
  }
});

test("a report that cannot be recorded logs once per outage naming the screen, and once when it records again", async (t: TestContext) => {
  const id = await addRelayFeed("Unrecordable feed");
  const warnings = captureConsole(t, "warn");
  const lines = captureConsole(t, "log");
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const health = (videoService as unknown as { playbackHealth: { record: (...args: unknown[]) => boolean } }).playbackHealth;
  const realRecord = health.record;
  health.record = () => {
    throw new Error("disk on fire");
  };
  try {
    for (let i = 0; i < 3; i++) {
      assert.doesNotThrow(() => videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id })]), "a failed record must not fail the heartbeat");
      await settle();
      t.mock.timers.tick(10_000);
    }
    assert.deepEqual(warnings.filter((l) => l.includes("playback report")), [
      `[video] could not record ${OUTPUT_NAME}'s playback report: disk on fire`,
    ]);

    health.record = realRecord;
    // A success is news once it has held for the settle window.
    for (let i = 0; i < 14; i++) {
      videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id })]);
      await settle();
      t.mock.timers.tick(10_000);
    }
    assert.deepEqual(lines.filter((l) => l.includes("playback reports is working again")), [
      `[video] recording ${OUTPUT_NAME}'s playback reports is working again after 3 failed attempts (2 min)`,
    ]);
  } finally {
    health.record = realRecord;
    await videoService.removeFeed(id);
  }
});

test("removeFeed forgets that feed's playback health — a struggling feed deleted and re-added under the same name does not inherit the old one's struggling read", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  captureConsole(t, "log"); // this test crosses into struggling on purpose; not asserting on the line
  const made = await videoService.addFeed({ name: "Repeat name", source: { kind: "external", url: "https://relay.example/repeat" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  try {
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 1000, dropped: 51 })]);
    await settle();
    assert.equal((await videoService.state()).screens.some((s) => s.feedId === id), true, "sanity: the pair is recorded before removal");

    await videoService.removeFeed(id);
    // feedIdFor() is deterministic from the name, so re-adding "Repeat name"
    // mints the SAME id the deleted feed had.
    const again = await videoService.addFeed({ name: "Repeat name", source: { kind: "external", url: "https://relay.example/repeat2" } });
    assert.ok(again.ok);
    const sameId = (again as { feed: { id: string } }).feed.id;
    assert.equal(sameId, id, "sanity: the re-added feed must mint the identical id for this guard to mean anything");

    const screens = (await videoService.state()).screens;
    assert.equal(screens.some((s) => s.feedId === sameId), false, "a just re-added feed must not carry the deleted feed's struggling read");
  } finally {
    await videoService.removeFeed(id);
  }
});

test("logs the struggling and smoothly-again flips, and only the flips — never a repeat while the state holds", async (t: TestContext) => {
  const id = await addRelayFeed("Narthex wall");
  const lines = captureConsole(t, "log");
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  try {
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 1000, dropped: 51, stalls: 0 })]);
    await settle();

    // Still struggling — must not repeat the "struggling" line.
    t.mock.timers.tick(1);
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 1000, dropped: 60, stalls: 0 })]);
    await settle();

    // Six more clean heartbeats at the real 10 s cadence (VIDEO_HEARTBEAT_MS
    // in playback-reports.ts) — each refreshes the pair's own `reportedAt`,
    // so it never ages out of the WINDOW_MS sweep between calls, the way a
    // single 60 s jump would (that would age the pair itself out and have it
    // reappear fresh, masking the sticky flag's own clear-boundary logic
    // behind a completely different "pair left, pair appeared" path — which
    // is why this is heartbeats, not one big tick). Each one reports a large
    // decoded count so the window's own fraction dilutes under 5% on the
    // FIRST clean heartbeat, not gradually over several — otherwise the
    // still-over-5% window re-arms the sticky clock at ITS OWN `now` for as
    // many heartbeats as dilution takes, and the boundary this test means to
    // land on (60 s after the LAST bad sample, tick 1) moves out from under
    // it. The sixth heartbeat lands exactly 60 s after that bad sample: the
    // first past CLEAR_AFTER_MS, and the one that must clear it.
    for (let i = 0; i < 6; i++) {
      t.mock.timers.tick(10_000);
      videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 10_000, dropped: 0, stalls: 0 })]);
      await settle();
    }

    // Still smooth — must not repeat the "smoothly again" line.
    t.mock.timers.tick(10_000);
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 10_000, dropped: 0, stalls: 0 })]);
    await settle();

    const own = lines.filter((l) => l.includes("Narthex wall"));
    assert.deepEqual(own, [
      `[video] ${OUTPUT_NAME} is struggling with Narthex wall: dropped 51 frames for 1000 decoded, 0 stalls in the last minute`,
      `[video] ${OUTPUT_NAME} is playing Narthex wall smoothly again`,
    ]);
  } finally {
    await videoService.removeFeed(id);
  }
});

test("a heartbeat whose own record() call clears the sticky flag in its sweep and then re-flags it from the same bad sample logs the clear and the new episode's struggling line, in that order", async (t: TestContext) => {
  const id = await addRelayFeed("Chapel screen");
  try {
    // The pair's first-ever struggle, at t=0 — its own "is struggling" line
    // is setup for this test, not part of the sequence under test, so
    // console capture starts only once it has already logged and settled.
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 1000, dropped: 51, stalls: 0 })], 0);
    await settle();

    const lines = captureConsole(t, "log");
    // A second heartbeat landing exactly CLEAR_AFTER_MS after the first bad
    // sample, a few ms ahead of where the expiry timer would otherwise have
    // swept it on its own — record()'s own sweep(), which runs before this
    // heartbeat's reports are folded in, reads that as no longer struggling
    // (isStrugglingAt is strictly `<`) and clears the sticky flag AND the
    // episode. This same heartbeat's own sample is bad too, so the
    // merged-report loop right after immediately re-arms it as a fresh
    // episode — all inside this one record() call, with no heartbeat or
    // timer landing in between to have logged the clear on its own.
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 1000, dropped: 51, stalls: 0 })], CLEAR_AFTER_MS);
    await settle();

    assert.deepEqual(lines, [
      `[video] ${OUTPUT_NAME} is playing Chapel screen smoothly again`,
      `[video] ${OUTPUT_NAME} is struggling with Chapel screen: dropped 51 frames for 1000 decoded, 0 stalls in the last minute`,
    ]);
  } finally {
    await videoService.removeFeed(id);
  }
});

test("removeFeed and a departed pair's own cleanup both forget the episode-id bookkeeping, not only lastLoggedStruggling", async (t: TestContext) => {
  const removed = await addRelayFeed("Removed screen");
  const departed = await addRelayFeed("Departed screen");
  captureConsole(t, "log"); // both feeds cross into struggling on purpose; not asserting on the lines
  const episodeIds = (videoService as unknown as { lastLoggedEpisodeId: Map<string, number | null> }).lastLoggedEpisodeId;
  try {
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: removed, decoded: 1000, dropped: 51, stalls: 0 })], 0);
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: departed, decoded: 1000, dropped: 51, stalls: 0 })], 0);
    await settle();
    assert.equal(episodeIds.has(`${OUTPUT_ID}\u0000${removed}`), true, "sanity: removeFeed's own pair logged a struggling line first");
    assert.equal(episodeIds.has(`${OUTPUT_ID}\u0000${departed}`), true, "sanity: the departed pair's own logged a struggling line first");

    await videoService.removeFeed(removed);
    assert.equal(episodeIds.has(`${OUTPUT_ID}\u0000${removed}`), false, "removeFeed must forget the removed feed's episode id, not only lastLoggedStruggling");

    // The departed pair ages out of playbackHealth entirely with no
    // removeFeed of its own — a heartbeat for a THIRD, unrelated feed at
    // WINDOW_MS later runs a sweep() over every held pair, which drops it,
    // and logPlaybackFlips() then prunes anything `after` no longer names.
    const other = await addRelayFeed("Unrelated screen");
    try {
      videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: other, decoded: 1000, dropped: 0, stalls: 0 })], WINDOW_MS);
      await settle();
      assert.equal(episodeIds.has(`${OUTPUT_ID}\u0000${departed}`), false, "a pair that ages out of playbackHealth on its own must also forget its episode id");
    } finally {
      await videoService.removeFeed(other);
    }
  } finally {
    await videoService.removeFeed(removed);
    await videoService.removeFeed(departed);
  }
});

test("a screen name and a feed name carrying a control character are scrubbed before they reach the log", async (t: TestContext) => {
  const raw = "Lobby\ncam";
  const made = await videoService.addFeed({ name: raw, source: { kind: "external", url: "https://relay.example/whep2" } });
  assert.ok(made.ok);
  const id = (made as { feed: { id: string } }).feed.id;
  const lines = captureConsole(t, "log");
  try {
    videoService.recordPlaybackReports(OUTPUT_ID, [report({ feedId: id, decoded: 1000, dropped: 51 })]);
    await settle();
    const struggling = lines.find((l) => l.includes("is struggling with"));
    assert.ok(struggling, "expected a struggling line");
    assert.equal(struggling!.includes("\n"), false, "a raw newline from the feed name must never reach a log line");
  } finally {
    await videoService.removeFeed(id);
  }
});

// The relay's own status poll racing a heartbeat's own flip used to be
// tested here directly (a pollOnce() call updated `this.snapshot.screens`
// out from under the next heartbeat's own before/after diff). `state()` no
// longer reads a fresh playbackHealth.snapshot() at all — only a heartbeat's
// own change or the expiry timer ever touch `cachedScreens` now, so a bare
// pollOnce() cannot affect `screens` or a log line either way. See
// video-service-screens-cache.test.ts for what replaced this: the poll must
// not broadcast or fire the relay status listener on its own, which is the
// bug this used to be papering over one symptom of.

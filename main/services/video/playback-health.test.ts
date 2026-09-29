// playback-health.test.ts — the rolling one-minute window that decides
// whether a screen is struggling with a feed, and the presence heartbeat's
// own refusal rules for `body.video`.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  CLEAR_AFTER_MS,
  DROPPED_FRACTION,
  MAX_REPORTS,
  parseVideoReports,
  PlaybackHealth,
  STALLS_IN_WINDOW,
  WINDOW_MS,
} from "./playback-health.js";
import type { VideoPlaybackReport } from "../../types/video.js";

/** A single report, everything defaulted to "nothing wrong" — every test
 *  overrides only what it is testing. */
function report(overrides: Partial<VideoPlaybackReport> = {}): VideoPlaybackReport {
  return { feedId: "feed-1", via: "webrtc", decoded: 100, dropped: 0, stalls: 0, width: 1920, height: 1080, ...overrides };
}

test("the constants this window is built from", () => {
  assert.equal(WINDOW_MS, 60_000);
  assert.equal(DROPPED_FRACTION, 0.05);
  assert.equal(STALLS_IN_WINDOW, 3);
  assert.equal(CLEAR_AFTER_MS, 60_000);
});

test("dropped fraction: exactly 5% is not struggling, just over 5% is", () => {
  const now = 1_000_000;

  const clean = new PlaybackHealth();
  clean.record("out1", [report({ decoded: 1000, dropped: 50 })], now);
  assert.equal(clean.snapshot(now)[0]?.struggling, false, "50 of 1000 dropped is exactly 5%, not MORE than 5%");

  const bad = new PlaybackHealth();
  bad.record("out1", [report({ decoded: 1000, dropped: 51 })], now);
  assert.equal(bad.snapshot(now)[0]?.struggling, true, "51 of 1000 dropped is 5.1%, over the line");
});

test("stalls: 2 in the window is not struggling, 3 is, whatever the dropped fraction says", () => {
  const now = 1_000_000;

  const clean = new PlaybackHealth();
  clean.record("out1", [report({ decoded: 1000, dropped: 0, stalls: 2 })], now);
  assert.equal(clean.snapshot(now)[0]?.struggling, false);

  const bad = new PlaybackHealth();
  bad.record("out1", [report({ decoded: 1000, dropped: 0, stalls: 3 })], now);
  assert.equal(bad.snapshot(now)[0]?.struggling, true);
});

test("once struggling, a clean report 30 s later keeps it struggling — even one with a large decoded count that would otherwise dilute the fraction back under threshold", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  h.record("out1", [report({ decoded: 1000, dropped: 51 })], t0);
  assert.equal(h.snapshot(t0)[0]?.struggling, true, "sanity: the bad sample itself reads struggling");

  const t1 = t0 + 30_000;
  h.record("out1", [report({ decoded: 5000, dropped: 0, stalls: 0 })], t1);
  assert.equal(h.snapshot(t1)[0]?.struggling, true, "a clean report 30 s after the bad one must not clear it yet");
});

test("clean reports until 60 s after the last bad sample clear it", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  h.record("out1", [report({ decoded: 1000, dropped: 51 })], t0);

  // Same boundary convention as a sample leaving the window itself
  // (WINDOW_MS old is gone, WINDOW_MS - 1 is not): CLEAR_AFTER_MS since the
  // last bad sample is the clear, not one tick short of it.
  const justUnder = t0 + CLEAR_AFTER_MS - 1;
  h.record("out1", [report({ decoded: 100, dropped: 0 })], justUnder);
  assert.equal(h.snapshot(justUnder)[0]?.struggling, true, "one ms short of 60 s must still be struggling");

  const atClear = t0 + CLEAR_AFTER_MS;
  h.record("out1", [report({ decoded: 100, dropped: 0 })], atClear);
  assert.equal(h.snapshot(atClear)[0]?.struggling, false, "60 s since the last bad sample, with nothing bad since, clears it");
});

test("samples older than 60 s leave the window's own totals, whether or not the flag has cleared", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  h.record("out1", [report({ decoded: 500, dropped: 10, stalls: 1 })], t0);
  assert.equal(h.snapshot(t0)[0]?.decodedInWindow, 500);

  // A keep-alive heartbeat well inside the window, refreshing `reportedAt`
  // so the PAIR ITSELF is not swept away by t0+WINDOW_MS — sweep()
  // (run at the top of every record()) removes a pair whose own reportedAt
  // is WINDOW_MS old, and a record() call exactly then would otherwise
  // delete the whole pair and recreate it fresh with only the new sample,
  // which reads decodedInWindow=20 for a reason that has nothing to do with
  // SAMPLE-level pruning — the thing this test means to prove. The
  // keep-alive is what isolates "one old sample left the window's own sum"
  // from "the pair itself aged out and came back new".
  h.record("out1", [report({ decoded: 20, dropped: 0, stalls: 0 })], t0 + 30_000);

  const entry = h.snapshot(t0 + WINDOW_MS)[0]!;
  assert.equal(entry.decodedInWindow, 20, "the t0 sample must have aged out of the window's own sum; only the keep-alive's own 20 remains");
  assert.equal(entry.droppedInWindow, 0);
  assert.equal(entry.stallsInWindow, 0);
});

test("the sticky clock re-arms only on a sample that is ITSELF bad — a stall at t0 then clean heartbeats clears exactly 60 s after the stall, not later", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  h.record("out1", [report({ decoded: 300, dropped: 0, stalls: 3 })], t0);
  assert.equal(h.snapshot(t0)[0]?.struggling, true, "sanity: 3 stalls struggles on their own");

  // Clean heartbeats every 10 s. The stall sample stays INSIDE the 60 s
  // window (and so isBadWindow() keeps reading true off it) for several of
  // these — re-arming on that alone, rather than on the NEW sample itself
  // being bad, is exactly the bug: it would push the clear boundary out
  // past 60 s after the stall for as long as the stall sample is still
  // inside the window at all.
  for (let i = 1; i <= 5; i++) {
    h.record("out1", [report({ decoded: 300, dropped: 0, stalls: 0 })], t0 + i * 10_000);
  }
  assert.equal(h.snapshot(t0 + 50_000)[0]?.struggling, true, "sanity: still inside 60 s of the stall");

  h.record("out1", [report({ decoded: 300, dropped: 0, stalls: 0 })], t0 + CLEAR_AFTER_MS);
  assert.equal(h.snapshot(t0 + CLEAR_AFTER_MS)[0]?.struggling, false, "exactly 60 s after the stall, with only clean heartbeats since, clears it");
});

test("the sticky clock re-arms only on a sample that is ITSELF bad — a dropping sample followed by clean ones clears 60 s after the LAST dropping one, not later", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  // Six heartbeats that are each, on their own, over the line (30 of 300 is
  // 10%), 10 s apart — each one is itself bad, so each correctly re-arms.
  let now = t0;
  for (let i = 0; i < 6; i++) {
    h.record("out1", [report({ decoded: 300, dropped: 30 })], now);
    now += 10_000;
  }
  const lastDroppingAt = t0 + 5 * 10_000; // the sixth (and last) dropping sample
  assert.equal(h.snapshot(now)[0]?.struggling, true, "sanity: still struggling right after the last dropping sample");

  // From here on, every heartbeat is clean. It must clear exactly 60 s
  // after the LAST dropping sample, not 60 s after the first (which the old
  // "re-arm on cumulative badness" rule stretched out to, since the window
  // stayed over 5% for a while as more of the six dropping samples were
  // still inside it) and not later either.
  for (let t = now; t <= lastDroppingAt + CLEAR_AFTER_MS; t += 10_000) {
    h.record("out1", [report({ decoded: 300, dropped: 0 })], t);
  }
  assert.equal(h.snapshot(lastDroppingAt + CLEAR_AFTER_MS)[0]?.struggling, false, "60 s after the LAST dropping sample, with nothing bad since, clears it");
});

// ── episode: the worst window since the flag turned on ─────────────────────

test("episode: seeded the moment struggling turns true, from that flip's own window", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  h.record("out1", [report({ decoded: 1000, dropped: 51, stalls: 0 })], t0);
  const entry = h.snapshot(t0)[0]!;
  assert.equal(entry.struggling, true, "sanity: the flip itself");
  assert.deepEqual(entry.episode, { droppedInWindow: 51, decodedInWindow: 1000, stallsInWindow: 0, width: 1920, height: 1080 });
});

test("episode: a later window that is WORSE than the current peak replaces it — the peak moves", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  h.record("out1", [report({ decoded: 1000, dropped: 200, stalls: 0 })], t0); // 20%, flips
  assert.deepEqual(h.snapshot(t0)[0]!.episode, { droppedInWindow: 200, decodedInWindow: 1000, stallsInWindow: 0, width: 1920, height: 1080 });

  // The cumulative window (both samples still inside it) climbs to 30% —
  // strictly worse than the 20% the peak was seeded with.
  h.record("out1", [report({ decoded: 1000, dropped: 400, stalls: 0 })], t0 + 1000);
  const entry = h.snapshot(t0 + 1000)[0]!;
  assert.equal(entry.droppedInWindow, 600, "sanity: the live window's own cumulative total");
  assert.deepEqual(entry.episode, { droppedInWindow: 600, decodedInWindow: 2000, stallsInWindow: 0, width: 1920, height: 1080 }, "the worse cumulative window becomes the new peak");
});

test("episode: a later window that is MILDER than the current peak leaves it unchanged", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  h.record("out1", [report({ decoded: 1000, dropped: 200, stalls: 0 })], t0); // 20%, flips; peak = 200/1000
  assert.deepEqual(h.snapshot(t0)[0]!.episode, { droppedInWindow: 200, decodedInWindow: 1000, stallsInWindow: 0, width: 1920, height: 1080 });

  // A clean keep-alive dilutes the cumulative window to 200 of 2000 (10%) —
  // still struggling (over 5%), but milder than the peak's own 20%.
  h.record("out1", [report({ decoded: 1000, dropped: 0, stalls: 0 })], t0 + 1000);
  const entry = h.snapshot(t0 + 1000)[0]!;
  assert.equal(entry.struggling, true, "sanity: still struggling, just diluted");
  assert.deepEqual(entry.episode, { droppedInWindow: 200, decodedInWindow: 1000, stallsInWindow: 0, width: 1920, height: 1080 }, "the milder cumulative window must not replace the worse peak already held");
});

test("episode: a struggling pair's peak survives its original bad sample aging out of the live window, holding the worst cumulative window seen while the sticky flag has stayed armed", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  h.record("out1", [report({ decoded: 1000, dropped: 0, stalls: 4 })], t0);
  assert.deepEqual(h.snapshot(t0)[0]!.episode, { droppedInWindow: 0, decodedInWindow: 1000, stallsInWindow: 4, width: 1920, height: 1080 });

  // A second stall 30 s later re-arms the sticky clock (the cumulative
  // window, both samples still inside it, reads 5 stalls) and is itself a
  // WORSE window than the first sample alone — the peak moves to it.
  h.record("out1", [report({ decoded: 1000, dropped: 0, stalls: 1 })], t0 + 30_000);
  assert.deepEqual(
    h.snapshot(t0 + 30_000)[0]!.episode,
    { droppedInWindow: 0, decodedInWindow: 2000, stallsInWindow: 5, width: 1920, height: 1080 },
    "sanity: the worse cumulative window becomes the new peak",
  );

  // By t0+60_000 the FIRST sample has aged out of the live window's own sum
  // (only the +30 s sample's own stall remains, diluted under
  // STALLS_IN_WINDOW), but the sticky flag — armed at t0+30_000 — is still
  // well inside CLEAR_AFTER_MS of ITS OWN arming time.
  h.record("out1", [report({ decoded: 1000, dropped: 0, stalls: 0 })], t0 + 60_000);
  const entry = h.snapshot(t0 + 60_000)[0]!;
  assert.equal(entry.stallsInWindow, 1, "sanity: the live window's own stall count has diluted");
  assert.equal(entry.struggling, true, "sanity: still inside CLEAR_AFTER_MS of the +30 s re-arm");
  assert.deepEqual(
    entry.episode,
    { droppedInWindow: 0, decodedInWindow: 2000, stallsInWindow: 5, width: 1920, height: 1080 },
    "the episode still remembers the worst window this struggle has had, not the diluted live count",
  );
});

test("episode: clears the instant the sticky flag itself clears, with no further record() call touching this pair needed", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  h.record("out1", [report({ decoded: 1000, dropped: 51 })], t0);
  assert.notEqual(h.snapshot(t0)[0]!.episode, null, "sanity: episode is seeded");

  // A keep-alive well inside CLEAR_AFTER_MS, refreshing reportedAt so the
  // PAIR ITSELF is not swept out of snapshot() at the same boundary as the
  // sticky flag's own clear — isolating "the flag cleared" from "the pair
  // aged out entirely", the same way the sticky-clock tests above do.
  h.record("out1", [report({ decoded: 100, dropped: 0 })], t0 + 30_000);
  assert.equal(h.snapshot(t0 + 30_000)[0]!.struggling, true, "sanity: still struggling");

  // No further record() call at all past this point — CLEAR_AFTER_MS since
  // the ORIGINAL bad sample (t0), a bare snapshot() must already read both
  // struggling and episode as cleared, purely off elapsed time.
  const cleared = h.snapshot(t0 + CLEAR_AFTER_MS)[0]!;
  assert.equal(cleared.struggling, false);
  assert.equal(cleared.episode, null);
});

test("episode: a pair that ages out entirely and reappears later starts a brand fresh episode, never the old peak", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  h.record("out1", [report({ decoded: 1000, dropped: 200 })], t0); // struggling, episode seeded
  assert.notEqual(h.snapshot(t0)[0]!.episode, null);

  // Nothing reports at all for a full WINDOW_MS — the pair itself is gone,
  // not merely cleared (see "a pair that stops reporting drops out of
  // snapshot after WINDOW_MS" above).
  assert.equal(h.snapshot(t0 + WINDOW_MS).length, 0, "sanity: the pair is gone entirely");

  // A brand new bad sample for the SAME outputId/feedId, well after the old
  // one aged out — this is a NEW Pair object (the Map entry was deleted), so
  // its own episode must be seeded fresh from THIS sample alone, never
  // carrying the old (200-dropped) peak forward.
  h.record("out1", [report({ decoded: 1000, dropped: 60 })], t0 + WINDOW_MS + 10_000);
  const fresh = h.snapshot(t0 + WINDOW_MS + 10_000)[0]!;
  assert.deepEqual(
    fresh.episode,
    { droppedInWindow: 60, decodedInWindow: 1000, stallsInWindow: 0, width: 1920, height: 1080 },
    "a re-seeded pair's episode must start from ITS OWN first bad sample, not the long-gone one",
  );
});

// A stall-only episode, then clean heartbeats until the sticky flag clears by
// time, then a heartbeat that drops frames at 1080p. The new episode must
// describe those drops: carrying the cleared episode's stalls forward would
// log a stall count that is gone and give network advice for a decode
// problem.
function clearedStallEpisode(h: InstanceType<typeof PlaybackHealth>, t0: number): void {
  h.record("out1", [report({ decoded: 300, dropped: 0, stalls: 5 })], t0);
  for (let i = 1; i <= 5; i++) h.record("out1", [report({ decoded: 400, dropped: 0, stalls: 0 })], t0 + i * 10_000);
}
const NEW_DROPS = { droppedInWindow: 150, decodedInWindow: 2300, stallsInWindow: 0, width: 1920, height: 1080 };

test("episode: a new episode after the expiry timer clears the flag seeds from its own window, not the cleared one", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  clearedStallEpisode(h, t0);
  const cleared = h.tick(t0 + CLEAR_AFTER_MS)[0]!;
  assert.equal(cleared.struggling, false, "sanity: the flag cleared by time");

  h.record("out1", [report({ decoded: 300, dropped: 150, stalls: 0 })], t0 + 60_500);
  const entry = h.snapshot(t0 + 60_500)[0]!;
  assert.equal(entry.struggling, true, "sanity: 150 of 2300 in the window is over 5%");
  assert.deepEqual(entry.episode, NEW_DROPS, "the new episode must hold the new drops, not the cleared episode's 5 stalls");
});

test("episode: a new episode seeds fresh when the flag cleared by time with no expiry timer run in between", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  clearedStallEpisode(h, t0);

  h.record("out1", [report({ decoded: 300, dropped: 150, stalls: 0 })], t0 + 60_500);
  assert.deepEqual(h.snapshot(t0 + 60_500)[0]!.episode, NEW_DROPS, "the new episode must hold the new drops, not the cleared episode's 5 stalls");
});

test("record()'s changed flag: a heartbeat after the expiry timer already cleared the flag is not a flip", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  clearedStallEpisode(h, t0);
  h.tick(t0 + CLEAR_AFTER_MS);
  assert.equal(h.record("out1", [report({ decoded: 400, dropped: 0, stalls: 0 })], t0 + 70_000), false, "the timer already published the clear; a clean heartbeat after it changes nothing");
});

test("a burst of 1000 heartbeats holds a bounded number of samples, merging into the newest rather than dropping — the running totals still sum every one of them", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  for (let i = 0; i < 1000; i++) {
    h.record("out1", [report({ decoded: 1, dropped: 0, stalls: 0 })], t0 + i); // 1 ms apart — all inside one WINDOW_MS span
  }
  const entry = h.snapshot(t0 + 999)[0]!;
  assert.equal(entry.decodedInWindow, 1000, "merging into the newest sample must still SUM every heartbeat's own count, never drop the excess");
});

test("a pair that stops reporting drops out of snapshot after WINDOW_MS", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  h.record("out1", [report()], t0);
  assert.equal(h.snapshot(t0).length, 1);
  assert.equal(h.snapshot(t0 + WINDOW_MS - 1).length, 1, "still inside the window");
  assert.equal(h.snapshot(t0 + WINDOW_MS).length, 0, "a full window with nothing new is gone, not merely quiet");
});

test("record()'s changed flag: another output's pair aging out counts too — a heartbeat's own sweep is not scoped to its own output", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  h.record("out1", [report({ feedId: "quiet" })], t0); // out1 then goes silent forever
  assert.equal(h.record("out2", [report({ feedId: "steady" })], t0 + 1), true, "out2's own pair appearing is a change on its own — not what this proves");

  // out2 keeps heartbeating cleanly (never a change of ITS OWN) for long
  // enough that out1's pair ages out of the window in between.
  assert.equal(h.record("out2", [report({ feedId: "steady" })], t0 + WINDOW_MS), true, "out1's pair aging out must still be reported as a change, even though out2's own heartbeat carries nothing new");
  assert.equal(h.snapshot(t0 + WINDOW_MS).some((s) => s.feedId === "quiet"), false, "out1's pair is actually gone, not merely unreported this call");
});

test("record()'s changed flag: a pair appearing, or a flip, is a change", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  // Negligible first sample: the window sums EVERY sample still inside it,
  // so a second, larger one is what has to cross the threshold here, not
  // get diluted by whatever came before.
  assert.equal(h.record("out1", [report({ decoded: 1, dropped: 0 })], t0), true, "a pair appearing is a change");
  assert.equal(h.record("out1", [report({ decoded: 1000, dropped: 51 })], t0 + 1), true, "crossing into struggling is a flip");
});

test("record()'s changed flag: a healthy pair's own totals climbing alone is NOT a change — only a STRUGGLING pair's episode moving is", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  h.record("out1", [report({ decoded: 500, dropped: 0 })], t0); // pair appears — not asserted here
  // Still healthy: nothing about a healthy pair's own decoded count is shown
  // anywhere a client would need pushed a fresh copy of.
  assert.equal(h.record("out1", [report({ decoded: 500, dropped: 0 })], t0 + 1), false, "a healthy pair's totals moving alone is not a change");

  const s = new PlaybackHealth();
  s.record("out2", [report({ feedId: "f2", decoded: 1000, dropped: 51 })], t0); // struggling — not asserted here
  assert.equal(s.record("out2", [report({ feedId: "f2", decoded: 100, dropped: 10 })], t0 + 1), true, "a struggling pair's episode moving IS a change");
});

test("record()'s changed flag: a struggling pair's live window moving while its episode holds is NOT a change", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  h.record("out1", [report({ decoded: 1000, dropped: 200 })], t0); // 20%: struggling, the episode
  // The window dilutes to 220 of 2000 (11%): still struggling, milder than
  // the episode. The card and the log read the episode, so nothing to push.
  assert.equal(h.record("out1", [report({ decoded: 1000, dropped: 20 })], t0 + 1), false, "a live window that moved while the episode held changes nothing a client reads");
  assert.equal(h.snapshot(t0 + 1)[0]!.droppedInWindow, 220, "sanity: the live window did move");
});

test("record()'s changed flag: an all-zero heartbeat for an already-known pair changes nothing to publish about", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  h.record("out2", [report({ feedId: "f2", decoded: 1000, dropped: 51 })], t0); // struggling — not asserted here
  assert.equal(h.record("out2", [report({ feedId: "f2", decoded: 0, dropped: 0, stalls: 0 })], t0 + 1), false, "an all-zero report changes nothing to publish about");
});

test("two widgets on one screen reporting the same feed id are folded into one pair, its totals summed", () => {
  const h = new PlaybackHealth();
  const now = 1_000_000;
  h.record(
    "out1",
    [report({ feedId: "shared", decoded: 400, dropped: 20 }), report({ feedId: "shared", decoded: 600, dropped: 31 })],
    now,
  );
  const snap = h.snapshot(now);
  assert.equal(snap.length, 1, "one pair, not two");
  assert.equal(snap[0]!.decodedInWindow, 1000);
  assert.equal(snap[0]!.droppedInWindow, 51);
  assert.equal(snap[0]!.struggling, true, "the folded total (51 of 1000) is over the line even though neither report alone was");
});

test("Maps, not property lookups — an outputId or feedId shaped like a prototype key is just another key, not a pollution vector", () => {
  const h = new PlaybackHealth();
  const now = 1_000_000;
  h.record("__proto__", [report({ feedId: "__proto__" })], now);
  h.record("constructor", [report({ feedId: "toString" })], now);
  const snap = h.snapshot(now);
  assert.equal(snap.length, 2, "both pairs recorded as ordinary entries");
  assert.equal(({} as { polluted?: boolean }).polluted, undefined, "no plain object anywhere picked up a stray property");
});

// ── parseVideoReports: body.video's own refusal rules ──────────────────────

test("parseVideoReports accepts a well-formed array", () => {
  const parsed = parseVideoReports([{ feedId: "f1", via: "webrtc", decoded: 10, dropped: 1, stalls: 0, width: 1920, height: 1080 }]);
  assert.deepEqual(parsed, [{ feedId: "f1", via: "webrtc", decoded: 10, dropped: 1, stalls: 0, width: 1920, height: 1080 }]);
});

test("parseVideoReports refuses a non-array body", () => {
  assert.equal(parseVideoReports(undefined), null);
  assert.equal(parseVideoReports(null), null);
  assert.equal(parseVideoReports({}), null);
  assert.equal(parseVideoReports("nope"), null);
});

test("parseVideoReports refuses the WHOLE array on one report with a non-string feedId — the good entry ahead of it does not survive", () => {
  const good = { feedId: "f1", via: "webrtc" as const, decoded: 1, dropped: 0, stalls: 0, width: 1, height: 1 };
  assert.equal(parseVideoReports([good, { ...good, feedId: 42 }]), null);
});

test("parseVideoReports refuses an empty feedId", () => {
  assert.equal(parseVideoReports([{ feedId: "", via: "webrtc", decoded: 1, dropped: 0, stalls: 0, width: 1, height: 1 }]), null);
});

test("parseVideoReports refuses a via outside webrtc/hls", () => {
  assert.equal(parseVideoReports([{ feedId: "f1", via: "rtmp", decoded: 1, dropped: 0, stalls: 0, width: 1, height: 1 }]), null);
});

test("parseVideoReports refuses a negative count", () => {
  const good = { feedId: "f1", via: "webrtc" as const, decoded: 1, dropped: 0, stalls: 0, width: 1, height: 1 };
  assert.equal(parseVideoReports([{ ...good, dropped: -1 }]), null);
});

test("parseVideoReports refuses a non-integer or non-finite count", () => {
  const good = { feedId: "f1", via: "webrtc" as const, decoded: 1, dropped: 0, stalls: 0, width: 1, height: 1 };
  assert.equal(parseVideoReports([{ ...good, decoded: 1.5 }]), null);
  assert.equal(parseVideoReports([{ ...good, stalls: Infinity }]), null);
  assert.equal(parseVideoReports([{ ...good, width: NaN }]), null);
});

test("parseVideoReports refuses more than MAX_REPORTS entries, and accepts exactly MAX_REPORTS", () => {
  const one = { feedId: "f1", via: "webrtc" as const, decoded: 1, dropped: 0, stalls: 0, width: 1, height: 1 };
  assert.equal(parseVideoReports(Array.from({ length: 500 }, () => one)), null, "500 entries must be refused whole");
  assert.equal(parseVideoReports(Array.from({ length: MAX_REPORTS }, () => one))?.length, MAX_REPORTS);
  assert.equal(parseVideoReports(Array.from({ length: MAX_REPORTS + 1 }, () => one)), null);
});

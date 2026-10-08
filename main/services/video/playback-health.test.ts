// playback-health.test.ts — the rolling one-minute window that decides
// whether a screen is struggling with a feed, and the presence heartbeat's
// own refusal rules for `body.video`.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  classifyWindow,
  CLEAR_AFTER_MS,
  DROPPED_FRACTION,
  LAGGING_MS,
  MAX_COUNT_PER_REPORT,
  MAX_DIMENSION,
  MAX_LAG_MS,
  MAX_REPORTS,
  MAX_SAMPLES_PER_PAIR,
  parseVideoReports,
  PlaybackHealth,
  STALLS_IN_WINDOW,
  WINDOW_MS,
  worstLag,
} from "./playback-health.js";
import { report } from "../fixtures/video-playback.js";

test("the constants this window is built from", () => {
  assert.equal(WINDOW_MS, 60_000);
  assert.equal(DROPPED_FRACTION, 0.05);
  assert.equal(STALLS_IN_WINDOW, 3);
  assert.equal(CLEAR_AFTER_MS, 60_000);
  assert.equal(LAGGING_MS, 1_000);
  assert.equal(MAX_LAG_MS, 600_000);
});

test("classifyWindow: which of the two thresholds a window's totals cross", () => {
  assert.deepEqual(classifyWindow({ decoded: 1000, dropped: 50, stalls: 2 }), { droppedBad: false, stallsBad: false }, "exactly 5% and 2 stalls cross neither");
  assert.deepEqual(classifyWindow({ decoded: 1000, dropped: 51, stalls: 2 }), { droppedBad: true, stallsBad: false });
  assert.deepEqual(classifyWindow({ decoded: 1000, dropped: 0, stalls: 3 }), { droppedBad: false, stallsBad: true });
  assert.deepEqual(classifyWindow({ decoded: 1000, dropped: 51, stalls: 3 }), { droppedBad: true, stallsBad: true });
  assert.deepEqual(classifyWindow({ decoded: 0, dropped: 1, stalls: 0 }), { droppedBad: true, stallsBad: false }, "any drop with nothing decoded is over the line");
  assert.deepEqual(classifyWindow({ decoded: 0, dropped: 0, stalls: 0 }), { droppedBad: false, stallsBad: false });
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
  assert.equal(h.samplesHeld("out1", "feed-1"), MAX_SAMPLES_PER_PAIR, "1000 heartbeats inside one window must hold exactly the cap, not one sample each");
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

// ── lagging: the receive-delay figures and their own sticky flag ───────────

const LAG_T0 = 1_000_000;

test("lagging: a window figure of exactly 1000 ms is not lagging, 1001 is — for each figure on its own", () => {
  for (const field of ["jitterBufferMs", "behindNewestMs"] as const) {
    const at = new PlaybackHealth();
    at.record("out1", [report({ [field]: 1000 })], LAG_T0);
    assert.equal(at.snapshot(LAG_T0)[0]?.lagging, false, `${field} of exactly 1000 is not OVER the line`);

    const over = new PlaybackHealth();
    over.record("out1", [report({ [field]: 1001 })], LAG_T0);
    assert.equal(over.snapshot(LAG_T0)[0]?.lagging, true, `${field} of 1001 is`);
  }
});

test("lagging: null figures (HLS, an old page, a browser that cannot measure) are never lagging", () => {
  const h = new PlaybackHealth();
  h.record("out1", [report({ via: "hls", jitterBufferMs: null, behindNewestMs: null }), report({ feedId: "feed-2" })], LAG_T0);
  for (const e of h.snapshot(LAG_T0)) {
    assert.equal(e.lagging, false);
    assert.equal(e.jitterBufferMsInWindow, null);
    assert.equal(e.behindNewestMsInWindow, null);
    assert.equal(e.laggingEpisode, null);
  }
});

test("lagging and struggling are separate flags: a pair can be either, both or neither", () => {
  const h = new PlaybackHealth();
  h.record("out1", [report({ feedId: "neither", jitterBufferMs: 150 })], LAG_T0);
  h.record("out1", [report({ feedId: "lag-only", jitterBufferMs: 2500 })], LAG_T0);
  h.record("out1", [report({ feedId: "struggle-only", dropped: 200 })], LAG_T0);
  h.record("out1", [report({ feedId: "both", dropped: 200, behindNewestMs: 3000 })], LAG_T0);
  const by = new Map(h.snapshot(LAG_T0).map((e) => [e.feedId, e]));
  assert.deepEqual([by.get("neither")!.struggling, by.get("neither")!.lagging], [false, false]);
  assert.deepEqual([by.get("lag-only")!.struggling, by.get("lag-only")!.lagging], [false, true]);
  assert.deepEqual([by.get("struggle-only")!.struggling, by.get("struggle-only")!.lagging], [true, false]);
  assert.deepEqual([by.get("both")!.struggling, by.get("both")!.lagging], [true, true]);
});

test("lagging: the window carries the worst of each figure, ignoring reports that carried none", () => {
  const h = new PlaybackHealth();
  h.record("out1", [report({ jitterBufferMs: 300, behindNewestMs: null })], LAG_T0);
  h.record("out1", [report({ jitterBufferMs: 800, behindNewestMs: 120 })], LAG_T0 + 10_000);
  h.record("out1", [report({ jitterBufferMs: 200, behindNewestMs: null })], LAG_T0 + 20_000);
  const e = h.snapshot(LAG_T0 + 20_000)[0]!;
  assert.equal(e.jitterBufferMsInWindow, 800);
  assert.equal(e.behindNewestMsInWindow, 120);

  // The 800 / 120 report ages out; only the 200 report is left.
  h.record("out1", [report({ jitterBufferMs: 200, behindNewestMs: null })], LAG_T0 + 71_000);
  const later = h.snapshot(LAG_T0 + 71_000)[0]!;
  assert.equal(later.jitterBufferMsInWindow, 200);
  assert.equal(later.behindNewestMsInWindow, null, "no report left in the window carried one");
});

test("lagging: held for 60 s after the last report over the line, cleared exactly at 60 s", () => {
  const h = new PlaybackHealth();
  h.record("out1", [report({ jitterBufferMs: 1500 })], LAG_T0);
  h.record("out1", [report({ jitterBufferMs: 100 })], LAG_T0 + CLEAR_AFTER_MS - 1);
  assert.equal(h.snapshot(LAG_T0 + CLEAR_AFTER_MS - 1)[0]?.lagging, true, "one ms short of 60 s is still lagging");
  h.record("out1", [report({ jitterBufferMs: 100 })], LAG_T0 + CLEAR_AFTER_MS);
  assert.equal(h.snapshot(LAG_T0 + CLEAR_AFTER_MS)[0]?.lagging, false, "60 s since the last report over the line clears it");
});

test("lagging: clean reports do not re-arm the clock while the bad one is still in the window — it clears 60 s after the LAST bad report", () => {
  const h = new PlaybackHealth();
  h.record("out1", [report({ behindNewestMs: 4000 })], LAG_T0);
  for (let t = 10_000; t <= 50_000; t += 10_000) h.record("out1", [report({ behindNewestMs: 100 })], LAG_T0 + t);
  assert.equal(h.snapshot(LAG_T0 + 50_000)[0]?.lagging, true, "sanity: still held inside the 60 s");
  // The window max is still 4000 at 59 s, so a clock re-armed off the
  // window (not the report) would keep this lagging well past 60 s.
  h.record("out1", [report({ behindNewestMs: 100 })], LAG_T0 + 60_000);
  assert.equal(h.snapshot(LAG_T0 + 60_000)[0]?.lagging, false);
});

test("lagging: clears by elapsed time with no further record() — snapshot() and tick() both say so", () => {
  const h = new PlaybackHealth();
  h.record("out1", [report({ jitterBufferMs: 1500 })], LAG_T0);
  // A clean keep-alive so the PAIR is still held at +60 s (a lone pair ages
  // out at exactly the moment its flag clears).
  h.record("out1", [report({ jitterBufferMs: 100 })], LAG_T0 + 30_000);
  assert.equal(h.snapshot(LAG_T0 + CLEAR_AFTER_MS - 1)[0]?.lagging, true);
  const cleared = h.snapshot(LAG_T0 + CLEAR_AFTER_MS)[0]!;
  assert.equal(cleared.lagging, false, "the clear needs no heartbeat to notice it");
  assert.equal(cleared.laggingEpisode, null);
  assert.equal(h.tick(LAG_T0 + CLEAR_AFTER_MS)[0]?.lagging, false);
  assert.equal(h.laggingEpisodeIdFor("out1", "feed-1"), null, "tick() swept the stored episode too");
});

test("lagging: nextExpiryAt names the moment a lagging flag would clear, ahead of the pair ageing out", () => {
  const h = new PlaybackHealth();
  h.record("out1", [report({ jitterBufferMs: 1500 })], LAG_T0);
  h.record("out1", [report({ jitterBufferMs: 100 })], LAG_T0 + 30_000);
  // reportedAt is now LAG_T0 + 30 s, so the pair ages out at +90 s, but the
  // flag clears at +60 s.
  assert.equal(h.nextExpiryAt(LAG_T0 + 30_000), LAG_T0 + CLEAR_AFTER_MS);
});

test("lagging episode: seeded at the flip with the window's worst, rises with a worse figure, ignores a milder one", () => {
  const h = new PlaybackHealth();
  h.record("out1", [report({ jitterBufferMs: 1200, behindNewestMs: 300 })], LAG_T0);
  const first = h.snapshot(LAG_T0)[0]!.laggingEpisode;
  assert.deepEqual(first, { jitterBufferMs: 1200, behindNewestMs: 300 });

  assert.equal(h.record("out1", [report({ jitterBufferMs: 1100, behindNewestMs: 200 })], LAG_T0 + 10_000), false, "a milder report is not a change");
  assert.deepEqual(h.snapshot(LAG_T0 + 10_000)[0]!.laggingEpisode, { jitterBufferMs: 1200, behindNewestMs: 300 });

  assert.equal(h.record("out1", [report({ jitterBufferMs: 900, behindNewestMs: 2600 })], LAG_T0 + 20_000), true, "a worse figure moves the peak, and that is a change");
  assert.deepEqual(h.snapshot(LAG_T0 + 20_000)[0]!.laggingEpisode, { jitterBufferMs: 1200, behindNewestMs: 2600 }, "each figure keeps its own worst");
});

test("lagging episode: a peak creeping inside one displayed tenth of a second is not a change; a whole tenth is", () => {
  const h = new PlaybackHealth();
  assert.equal(h.record("out1", [report({ jitterBufferMs: 1001 })], LAG_T0), true, "the flip");
  assert.equal(h.record("out1", [report({ jitterBufferMs: 1002 })], LAG_T0 + 1_000), false, "1002 reads 1.0 s like 1001");
  assert.equal(h.record("out1", [report({ jitterBufferMs: 1040 })], LAG_T0 + 2_000), false, "1040 still reads 1.0 s");
  assert.equal(h.record("out1", [report({ behindNewestMs: 400, jitterBufferMs: 1040 })], LAG_T0 + 3_000), true, "a figure first appearing is a rise");
  assert.equal(h.record("out1", [report({ jitterBufferMs: 1100, behindNewestMs: 400 })], LAG_T0 + 4_000), true, "1100 reads 1.1 s");
  assert.deepEqual(h.snapshot(LAG_T0 + 4_000)[0]!.laggingEpisode, { jitterBufferMs: 1100, behindNewestMs: 400 });
  assert.equal(h.record("out1", [report({ jitterBufferMs: 1140, behindNewestMs: 440 })], LAG_T0 + 5_000), false, "both still under the next tenth");
});

test("lagging episode: survives the bad report leaving the live window while the flag holds, and starts fresh the next time", () => {
  const h = new PlaybackHealth();
  h.record("out1", [report({ jitterBufferMs: 5000 })], LAG_T0);
  h.record("out1", [report({ jitterBufferMs: 100 })], LAG_T0 + 30_000);
  h.record("out1", [report({ jitterBufferMs: 100 })], LAG_T0 + 59_000);
  const mid = h.snapshot(LAG_T0 + 59_000)[0]!;
  assert.equal(mid.lagging, true);
  assert.equal(mid.laggingEpisode?.jitterBufferMs, 5000);

  // Clears, and a NEW episode after it seeds from its own window only.
  h.record("out1", [report({ jitterBufferMs: 100 })], LAG_T0 + 61_000);
  assert.equal(h.snapshot(LAG_T0 + 61_000)[0]!.laggingEpisode, null);
  h.record("out1", [report({ jitterBufferMs: 1300 })], LAG_T0 + 71_000);
  assert.deepEqual(h.snapshot(LAG_T0 + 71_000)[0]!.laggingEpisode, { jitterBufferMs: 1300, behindNewestMs: null }, "never the old 5000");
});

test("lagging episode identity: a peak rising keeps the id, a clear and re-flag inside one record() call mints a new one", () => {
  const h = new PlaybackHealth();
  h.record("out1", [report({ jitterBufferMs: 1200 })], LAG_T0);
  const id = h.laggingEpisodeIdFor("out1", "feed-1");
  assert.notEqual(id, null);
  h.record("out1", [report({ jitterBufferMs: 3000 })], LAG_T0 + 10_000);
  assert.equal(h.laggingEpisodeIdFor("out1", "feed-1"), id, "same episode, worse peak");

  // 60 s on, the sweep clears the flag and the same report re-arms it.
  h.record("out1", [report({ jitterBufferMs: 1300 })], LAG_T0 + 10_000 + CLEAR_AFTER_MS);
  const next = h.laggingEpisodeIdFor("out1", "feed-1");
  assert.notEqual(next, null);
  assert.notEqual(next, id, "a genuinely new episode");

  const struggle = new PlaybackHealth();
  struggle.record("out1", [report({ dropped: 200, jitterBufferMs: 1200 })], LAG_T0);
  assert.notEqual(struggle.episodeIdFor("out1", "feed-1"), struggle.laggingEpisodeIdFor("out1", "feed-1"), "the two kinds never share an id");
});

test("lagging: record()'s changed flag — a flip is a change, a healthy pair's own figures moving is not", () => {
  const h = new PlaybackHealth();
  assert.equal(h.record("out1", [report({ jitterBufferMs: 100 })], LAG_T0), true, "a pair appearing");
  assert.equal(h.record("out1", [report({ jitterBufferMs: 700 })], LAG_T0 + 10_000), false, "a window figure climbing under the line publishes nothing");
  assert.equal(h.record("out1", [report({ jitterBufferMs: 1500 })], LAG_T0 + 20_000), true, "crossing the line does");
  assert.equal(h.record("out1", [report({ jitterBufferMs: 100 })], LAG_T0 + 30_000), false, "a clean report inside the hold does not");
  assert.equal(h.record("out1", [report({ jitterBufferMs: 100 })], LAG_T0 + 80_000), true, "the flag clearing by time does");
});

test("lagging: two widgets on one feed fold to the worse figure of each, whichever is listed first, never a sum", () => {
  // The FIRST widget carries the larger value of each figure and the second a
  // smaller one or none: a fold that keeps the last report's value (or sums)
  // reads differently from the max on both.
  const h = new PlaybackHealth();
  h.record("out1", [report({ feedId: "shared", jitterBufferMs: 700, behindNewestMs: 800 }), report({ feedId: "shared", jitterBufferMs: 600, behindNewestMs: null })], LAG_T0);
  const e = h.snapshot(LAG_T0)[0]!;
  assert.equal(e.jitterBufferMsInWindow, 700, "700 and 600 are not 1300, and not the last one's 600");
  assert.equal(e.behindNewestMsInWindow, 800, "a later widget with no figure does not erase the first one's");
  assert.equal(e.lagging, false, "a sum over the line would have said lagging");

  const other = new PlaybackHealth();
  other.record("out1", [report({ feedId: "shared", jitterBufferMs: 100, behindNewestMs: 900 }), report({ feedId: "shared", jitterBufferMs: 300, behindNewestMs: 200 })], LAG_T0);
  assert.equal(other.snapshot(LAG_T0)[0]!.behindNewestMsInWindow, 900, "a smaller later figure does not replace the larger earlier one");
  assert.equal(other.snapshot(LAG_T0)[0]!.jitterBufferMsInWindow, 300, "and the larger later one wins where it is the larger");

  const third = new PlaybackHealth();
  third.record("out1", [report({ feedId: "shared", behindNewestMs: null }), report({ feedId: "shared", behindNewestMs: 150 }), report({ feedId: "shared", behindNewestMs: 600 })], LAG_T0);
  assert.equal(third.snapshot(LAG_T0)[0]!.behindNewestMsInWindow, 600, "a figure first seen on a later widget, and a larger one after that, both count");
});

test("lagging: a burst of heartbeats at the sample cap still carries the worst figure, even when it landed in the sample the cap merges into", () => {
  const h = new PlaybackHealth();
  for (let i = 0; i < MAX_SAMPLES_PER_PAIR + 10; i++) {
    // The 900 arrives once the pair is AT the cap, so it merges into the
    // newest held sample, and later (lower) reports merge on top of it.
    const spike = i === MAX_SAMPLES_PER_PAIR + 1;
    h.record("out1", [report({ jitterBufferMs: spike ? 900 : 100, behindNewestMs: spike ? 700 : 50 })], LAG_T0 + i);
  }
  assert.equal(h.samplesHeld("out1", "feed-1"), MAX_SAMPLES_PER_PAIR);
  assert.equal(h.snapshot(LAG_T0 + 100)[0]?.jitterBufferMsInWindow, 900);
  assert.equal(h.snapshot(LAG_T0 + 100)[0]?.behindNewestMsInWindow, 700);
});

test("worstLag: the larger figure and its name, a tie to the jitter buffer, a lone figure as itself", () => {
  assert.deepEqual(worstLag({ jitterBufferMs: 1200, behindNewestMs: 3200 }), { ms: 3200, what: "behind the newest frame" });
  assert.deepEqual(worstLag({ jitterBufferMs: 1500, behindNewestMs: 300 }), { ms: 1500, what: "jitter buffer" });
  assert.deepEqual(worstLag({ jitterBufferMs: 900, behindNewestMs: 900 }), { ms: 900, what: "jitter buffer" });
  assert.deepEqual(worstLag({ jitterBufferMs: null, behindNewestMs: 1100 }), { ms: 1100, what: "behind the newest frame" });
  assert.deepEqual(worstLag({ jitterBufferMs: 0, behindNewestMs: null }), { ms: 0, what: "jitter buffer" }, "a zero reading is a reading");
  assert.deepEqual(worstLag({ jitterBufferMs: null, behindNewestMs: 0 }), { ms: 0, what: "behind the newest frame" }, "a missing figure is never named, even against a zero");
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
  assert.deepEqual(parsed, [{ feedId: "f1", via: "webrtc", decoded: 10, dropped: 1, stalls: 0, width: 1920, height: 1080, jitterBufferMs: null, behindNewestMs: null }]);
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

test("parseVideoReports accepts each count at its limit and refuses it one over", () => {
  const good = { feedId: "f1", via: "webrtc" as const, decoded: 1, dropped: 0, stalls: 0, width: 1, height: 1 };
  const limits: [field: keyof typeof good, max: number][] = [
    ["decoded", MAX_COUNT_PER_REPORT],
    ["dropped", MAX_COUNT_PER_REPORT],
    ["stalls", MAX_COUNT_PER_REPORT],
    ["width", MAX_DIMENSION],
    ["height", MAX_DIMENSION],
  ];
  assert.equal(MAX_COUNT_PER_REPORT, 100_000);
  assert.equal(MAX_DIMENSION, 16_384);
  for (const [field, max] of limits) {
    assert.equal(parseVideoReports([{ ...good, [field]: max }])?.length, 1, `${field} at ${max} must be accepted`);
    assert.equal(parseVideoReports([good, { ...good, [field]: max + 1 }]), null, `${field} at ${max + 1} must refuse the whole array`);
  }
});

test("parseVideoReports refuses a count too large to sum exactly", () => {
  const good = { feedId: "f1", via: "webrtc" as const, decoded: 1, dropped: 0, stalls: 0, width: 1, height: 1 };
  assert.equal(parseVideoReports([{ ...good, decoded: 1e308 }]), null, "1e308 is an integer to Number.isInteger, and two of them sum to Infinity");
  assert.equal(parseVideoReports([{ ...good, dropped: Number.MAX_SAFE_INTEGER + 1 }]), null);
});

test("parseVideoReports refuses more than MAX_REPORTS entries, and accepts exactly MAX_REPORTS", () => {
  const one = { feedId: "f1", via: "webrtc" as const, decoded: 1, dropped: 0, stalls: 0, width: 1, height: 1 };
  assert.equal(parseVideoReports(Array.from({ length: 500 }, () => one)), null, "500 entries must be refused whole");
  assert.equal(parseVideoReports(Array.from({ length: MAX_REPORTS }, () => one))?.length, MAX_REPORTS);
  assert.equal(parseVideoReports(Array.from({ length: MAX_REPORTS + 1 }, () => one)), null);
});

test("parseVideoReports: the receive-delay figures are absent-or-null as null, a number as itself", () => {
  const good = { feedId: "f1", via: "webrtc" as const, decoded: 1, dropped: 0, stalls: 0, width: 1, height: 1 };
  assert.deepEqual(parseVideoReports([good])?.[0], { ...good, jitterBufferMs: null, behindNewestMs: null }, "a page older than the figures");
  assert.deepEqual(parseVideoReports([{ ...good, jitterBufferMs: null, behindNewestMs: null }])?.[0], { ...good, jitterBufferMs: null, behindNewestMs: null });
  assert.deepEqual(parseVideoReports([{ ...good, jitterBufferMs: 123.4, behindNewestMs: 0 }])?.[0], { ...good, jitterBufferMs: 123.4, behindNewestMs: 0 });
});

test("parseVideoReports refuses a receive-delay figure that is negative, not a number, non-finite, or over MAX_LAG_MS", () => {
  const good = { feedId: "f1", via: "webrtc" as const, decoded: 1, dropped: 0, stalls: 0, width: 1, height: 1 };
  for (const field of ["jitterBufferMs", "behindNewestMs"] as const) {
    assert.equal(parseVideoReports([{ ...good, [field]: MAX_LAG_MS }])?.length, 1, `${field} at the cap is accepted`);
    for (const bad of [-1, "800", NaN, Infinity, MAX_LAG_MS + 1, {}, true]) {
      assert.equal(parseVideoReports([good, { ...good, [field]: bad }]), null, `${field}: ${String(bad)} refuses the whole array`);
    }
  }
});

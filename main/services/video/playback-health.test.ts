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
  // so the PAIR ITSELF is not swept away by t0+WINDOW_MS — sweepStale()
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

test("record()'s changed flag: a healthy pair's own totals climbing alone is NOT a change — only a STRUGGLING pair's totals moving is", () => {
  const h = new PlaybackHealth();
  const t0 = 1_000_000;
  h.record("out1", [report({ decoded: 500, dropped: 0 })], t0); // pair appears — not asserted here
  // Still healthy: the brief scopes "totals moved" to a struggling pair
  // specifically, and nothing about a healthy pair's own decoded count is
  // shown anywhere a client would need pushed a fresh copy of.
  assert.equal(h.record("out1", [report({ decoded: 500, dropped: 0 })], t0 + 1), false, "a healthy pair's totals moving alone is not a change");

  const s = new PlaybackHealth();
  s.record("out2", [report({ feedId: "f2", decoded: 1000, dropped: 51 })], t0); // struggling — not asserted here
  assert.equal(s.record("out2", [report({ feedId: "f2", decoded: 100, dropped: 10 })], t0 + 1), true, "a struggling pair's own totals moving IS a change");
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

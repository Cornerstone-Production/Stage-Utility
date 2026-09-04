// A transcript line whose final never arrives must not sit there for ever.
//
// A partial is held per CHANNEL KEY and removed on exactly one event: a final on
// that same key. Rename or re-route a channel in ProdCom mid-service and the key
// changes — the final for the speech already in flight arrives under the NEW key,
// nothing ever deletes the old entry, and because getBuffer() appends partials
// AFTER finals it is pinned to the bottom of the display.
//
// That is not hypothetical. At a kickoff, channels were renamed and re-routed
// mid-service; one grey line sat under everything for the rest of the night,
// dropping back to the bottom as real lines scrolled past, and nothing in the UI
// could clear it. `partials` had no cap, no TTL, and was not cleared on
// reconnect, so the only exit was restarting the server.
//
// This drives the REAL SSE path — raw event text through handleEvent — rather
// than calling ingest() with hand-made objects, because the bug is about which
// key a line lands under, and a test that picked the key itself would assert
// nothing.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addBroadcastListener } from "./broadcaster.js";
import { ProdComService } from "./prodcom-service.js";

/** The service with a clock we control and its event entry point exposed. */
class TestProdCom extends ProdComService {
  public clock = 1_000_000;
  protected override now(): number {
    return this.clock;
  }
  public feed(payload: Record<string, unknown>): void {
    this.handleEvent(`data: ${JSON.stringify(payload)}`);
  }
  public lines(): { text: string; isFinal: boolean }[] {
    return this.getBuffer().map((l) => ({ text: l.text, isFinal: l.isFinal }));
  }
  /** Whether the background sweep is currently armed — see prodcom-service.ts. */
  public get sweepActive(): boolean {
    return this.partialSweepActive;
  }
}

/** Collects every "prodcom:transcript" broadcast fired while a test runs.
 *  There is no removeBroadcastListener — listeners accumulate for the life of
 *  the process, so each spy only pushes into its OWN closure array and is
 *  otherwise inert once its test ends. */
function spyOnTranscriptBroadcasts(): unknown[] {
  const seen: unknown[] = [];
  addBroadcastListener((channel, payload) => {
    if (channel === "prodcom:transcript") seen.push(payload);
  });
  return seen;
}

const partial = (channelId: string, text: string) => ({
  id: `${channelId}-live`, channelId, channelName: channelId, text, inProgress: true,
});
const final = (channelId: string, text: string) => ({
  id: `${channelId}-${text}`, channelId, channelName: channelId, text, inProgress: false,
});

describe("a partial orphaned by a channel rename", () => {
  it("is dropped once it goes stale, instead of sitting at the bottom for ever", () => {
    const svc = new TestProdCom();

    // Somebody is talking on channel "EM".
    svc.feed(partial("EM", "that's good yeah we're good what was that"));
    assert.equal(svc.lines().length, 1, "the partial is showing, as it should be");

    // The operator renames/re-routes the channel in ProdCom. The final for that
    // same speech now arrives under a DIFFERENT key.
    svc.feed(final("EM-2", "that's good yeah we're good what was that"));

    // Before the fix this stayed at 2 for ever: the orphan plus the real line.
    svc.clock += 31_000;
    const after = svc.lines();
    assert.equal(after.length, 1, `the orphaned partial is still here: ${JSON.stringify(after)}`);
    assert.equal(after[0].isFinal, true, "what survives is the finalised line");
  });

  it("but a partial that is still being spoken is never dropped", () => {
    // The TTL must not cut off live speech. Partials update many times a second,
    // so each update refreshes the entry.
    const svc = new TestProdCom();
    svc.feed(partial("EM", "this is"));
    for (let i = 0; i < 5; i++) {
      svc.clock += 20_000; // under the TTL each time
      svc.feed(partial("EM", `this is a long sentence ${i}`));
    }
    assert.equal(svc.lines().length, 1);
    assert.equal(svc.lines()[0].isFinal, false, "still live");
  });

  it("a final on the same channel still clears its partial immediately", () => {
    // The original mechanism has to keep working — the TTL is a backstop, not a
    // replacement for it.
    const svc = new TestProdCom();
    svc.feed(partial("EM", "hello"));
    svc.feed(final("EM", "hello there"));
    const lines = svc.lines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].isFinal, true);
    assert.equal(lines[0].text, "hello there");
  });

  it("clearTranscript empties both halves", () => {
    // What the operator's button calls. Finals AND partials, because a stuck line
    // is a partial and "clear the screen" means the finals.
    const svc = new TestProdCom();
    svc.feed(final("A", "one"));
    svc.feed(final("A", "two"));
    svc.feed(partial("B", "mid sentence"));
    assert.equal(svc.lines().length, 3);

    svc.clearTranscript();
    assert.deepEqual(svc.lines(), [], "the display must go empty");
  });

  it("dropping the stream clears in-flight speech but keeps the record", () => {
    // A reconnect must not blank a display mid-service, but an utterance that was
    // in flight when the socket went will be re-sent or finalised on the other
    // side — keeping it here is how the orphan outlived the connection too.
    const svc = new TestProdCom();
    svc.feed(final("A", "already said"));
    svc.feed(partial("B", "half a sentence"));
    svc.stop();
    const lines = svc.lines();
    assert.equal(lines.length, 1, "the partial went with the stream");
    assert.equal(lines[0].text, "already said", "the finalised line stayed");
  });
});

describe("a partial re-sent without progress", () => {
  it("an identical re-send every 5s for 40s is still dropped once 30s pass since it FIRST arrived", () => {
    const svc = new TestProdCom();
    svc.feed(partial("EM", "same text"));

    // ProdCom (or a keepalive) re-emits the exact same partial every 5s.
    for (let i = 0; i < 5; i++) {
      svc.clock += 5_000; // 5s, 10s, 15s, 20s, 25s since first arrival
      svc.feed(partial("EM", "same text"));
      assert.equal(
        svc.lines().length,
        1,
        `still under the TTL at +${(i + 1) * 5}s despite the re-sends`,
      );
    }

    // Two more identical re-sends push total elapsed past 30s. If a re-send
    // refreshed seenAt (the bug), this would stay at 1 forever.
    svc.clock += 5_000; // 30s since first arrival
    svc.feed(partial("EM", "same text"));
    svc.clock += 5_000; // 35s
    svc.feed(partial("EM", "same text"));
    svc.clock += 5_000; // 40s
    svc.feed(partial("EM", "same text"));

    assert.equal(
      svc.lines().length,
      0,
      "an unchanged re-send must not reset seenAt — the entry should be gone by now",
    );
  });

  it("a partial whose text changes right before the deadline resets the clock", () => {
    const svc = new TestProdCom();
    svc.feed(partial("EM", "this is"));

    svc.clock += 29_000; // 1s shy of the TTL
    svc.feed(partial("EM", "this is a longer")); // progress: text changed

    svc.clock += 29_000; // would be 58s since the ORIGINAL arrival, well past 30s,
    // but only 29s since the change above
    assert.equal(svc.lines().length, 1, "the change reset seenAt, so it is not stale yet");
    assert.equal(svc.lines()[0].isFinal, false);

    svc.clock += 2_000; // now 31s since the change
    assert.equal(svc.lines().length, 0, "30s after the LAST change, it is stale");
  });
});

describe("the background sweep for a stale partial in a quiet room", () => {
  it("clears a stale partial and broadcasts on its own, with no other event", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const svc = new TestProdCom();
    const broadcasts = spyOnTranscriptBroadcasts();

    svc.feed(partial("EM", "hanging mid-sentence"));
    assert.equal(svc.lines().length, 1);
    assert.equal(svc.sweepActive, true, "a partial is held, so the sweep is armed");

    // Nothing else happens: no final, no other channel, no HTTP read of the
    // buffer. Advance both the sweep's real timer and the service's own clock
    // in the 5s steps the sweep runs at, six of them = 30s = the TTL.
    for (let i = 0; i < 6; i++) {
      svc.clock += 5_000;
      t.mock.timers.tick(5_000);
    }

    assert.equal(svc.lines().length, 0, "the stale partial is gone with nothing else touching the buffer");
    assert.ok(
      broadcasts.length > 0,
      "the sweep itself broadcast the buffer once the partial went stale",
    );
  });

  it("is not running when there are no partials to sweep", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const svc = new TestProdCom();
    const broadcasts = spyOnTranscriptBroadcasts();

    assert.equal(svc.sweepActive, false, "nothing to sweep at start-up");
    t.mock.timers.tick(60_000);
    assert.equal(broadcasts.length, 0, "no sweep broadcasts in a quiet room with an empty buffer");

    svc.feed(partial("EM", "hi"));
    assert.equal(svc.sweepActive, true, "arms once a partial exists");

    svc.feed(final("EM", "hi there"));
    assert.equal(svc.sweepActive, false, "disarms again once the partial resolved to a final");

    const before = broadcasts.length;
    t.mock.timers.tick(60_000);
    assert.equal(broadcasts.length, before, "a disarmed sweep does not keep firing");
  });
});

describe("diagnostics for a long-lived partial", () => {
  it("logs 'in progress' exactly once at 60s, even though it keeps getting unchanged re-sends", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const svc = new TestProdCom();
    const logs = t.mock.method(console, "log");

    // A real recogniser's mix: the text changes every 20s (real progress,
    // resets the TTL) with identical keepalive-style re-sends every 5s in
    // between. Genuinely alive the whole time — never stale — but open long
    // enough that the operator needs visibility into it.
    let text = "still talking";
    svc.feed(partial("EM", text));
    for (let i = 0; i < 14; i++) {
      // 14 * 5s = 70s
      svc.clock += 5_000;
      t.mock.timers.tick(5_000);
      if ((i + 1) % 4 === 0) text = `still talking, word ${i}`; // a real change every 20s
      svc.feed(partial("EM", text));
    }

    assert.equal(svc.lines().length, 1, "still alive at 70s — the text changes keep resetting the TTL");

    const longLived = logs.mock.calls
      .map((c) => c.arguments[0])
      .filter((a): a is string => typeof a === "string" && a.includes("in progress for"));
    assert.equal(
      longLived.length,
      1,
      `expected exactly one long-lived log by 70s, got: ${JSON.stringify(longLived)}`,
    );
    assert.match(
      longLived[0],
      /^\[prodcom\] partial on channel EM in progress for 60s — \d+ unchanged re-sends, \d+ text changes, last update \d+s ago, \d+ chars$/,
    );
  });

  it("does not log a partial that never crosses 60s", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const svc = new TestProdCom();
    const logs = t.mock.method(console, "log");

    svc.feed(partial("EM", "brief"));
    svc.clock += 10_000;
    t.mock.timers.tick(10_000);
    svc.feed(final("EM", "brief remark"));

    const longLived = logs.mock.calls
      .map((c) => c.arguments[0])
      .filter((a): a is string => typeof a === "string" && a.includes("in progress for"));
    assert.equal(longLived.length, 0, "resolved well under 60s — nothing to report");
  });
});

describe("clearTranscript logs what it discards", () => {
  it("logs the discarded partial's channel, age and counters before clearing", () => {
    const svc = new TestProdCom();
    const logs = { calls: [] as unknown[][] };
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.calls.push(args);
    };
    try {
      svc.feed(partial("EM", "half a sentence"));
      svc.clock += 12_000; // 12s old when the operator hits clear
      svc.clearTranscript();
    } finally {
      console.log = original;
    }

    const clearLines = logs.calls
      .map((args) => args[0])
      .filter((a): a is string => typeof a === "string" && a.startsWith("[prodcom] transcript cleared by operator"));
    assert.equal(clearLines.length, 1, `expected exactly one operator-clear log, got: ${JSON.stringify(clearLines)}`);
    assert.equal(
      clearLines[0],
      "[prodcom] transcript cleared by operator: 0 finals, 1 partials; " +
        "partial ch=EM age=12s unchanged-resends=0 text-changes=0",
    );
  });

  it("logs nothing extra when there was no partial to discard", () => {
    const svc = new TestProdCom();
    const logs = { calls: [] as unknown[][] };
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.calls.push(args);
    };
    try {
      svc.feed(final("A", "already said"));
      svc.clearTranscript();
    } finally {
      console.log = original;
    }

    const clearLines = logs.calls
      .map((args) => args[0])
      .filter((a): a is string => typeof a === "string" && a.startsWith("[prodcom] transcript cleared by operator"));
    assert.equal(clearLines.length, 0, "no live partial, so no per-partial line");
  });
});

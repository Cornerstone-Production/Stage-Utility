// A display advances at a boundary only while it is connected.
//
// This is the whole of the offline story, and it is deliberately not a timer.
// There is no grace period and no disconnection threshold to tune: the only
// question ever asked is "am I connected RIGHT NOW, at this boundary". An SSE
// blip that resolves before the next boundary therefore changes nothing at all,
// and a Pi taken offsite plays its content continuously whatever its clock
// believes, because it never consults a window again until a server answers.
//
// The failure this replaces: a display that only knew "what to show now" went
// black the moment its window ended, with the server gone and nobody able to
// tell it otherwise.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { SignageHorizon } from "@main/types/signage";
import { bootEntry, pickEntry } from "./signage-hold.js";

const playlist = (id: string) => ({
  id,
  startedAt: 0,
  fit: "contain" as const,
  transition: { kind: "cut" as const, ms: 0 },
  items: [
    {
      url: `/signage-media/${id}.png`,
      mime: "image/png",
      durationMs: 8000,
      fit: "contain" as const,
      transition: { kind: "cut" as const, ms: 0 },
      bytes: 1,
    },
  ],
});

const H: SignageHorizon = [
  { from: 0, until: 10_000, reason: "schedule", reasonLabel: "Weekend", playlist: playlist("weekend") },
  { from: 10_000, until: 20_000, reason: "blank", reasonLabel: "" },
  { from: 20_000, until: 30_000, reason: "schedule", reasonLabel: "Youth", playlist: playlist("youth") },
];

/** What the display draws at `nowMs`, given when (if ever) the stream dropped. */
const draw = (nowMs: number, disconnectedAtMs: number | null = null, horizon: SignageHorizon = H) =>
  pickEntry({ horizon, nowMs, disconnectedAtMs });

describe("a display at a horizon boundary", () => {
  test("advances normally while it is connected", () => {
    assert.equal(draw(5000)?.reasonLabel, "Weekend");
    assert.equal(draw(12_000)?.reason, "blank");
    assert.equal(draw(25_000)?.reasonLabel, "Youth");
  });

  test("HOLDS what it is playing when the stream is down", () => {
    // Dropped at 5s, and the clock has since passed the 10s boundary. It keeps
    // playing Weekend rather than going black.
    assert.equal(
      draw(12_000, 5000)?.reasonLabel,
      "Weekend",
      "a disconnected display blanked at its boundary",
    );
  });

  test("holds across MANY boundaries, not just the first", () => {
    assert.equal(draw(25_000, 5000)?.reasonLabel, "Weekend");
  });

  test("holds past the end of the horizon entirely", () => {
    // A Pi offsite for a week is well past its 24h horizon.
    assert.equal(draw(900_000, 5000)?.reasonLabel, "Weekend");
  });

  test("stays blank if it was ALREADY blank when the server went away", () => {
    // Holding what you are doing is the whole rule. A dark 2am screen must not
    // light itself up because the server rebooted.
    assert.equal(draw(25_000, 15_000)?.reason, "blank");
  });

  test("jumps straight to what is correct now when it reconnects", () => {
    assert.equal(draw(25_000, null)?.reasonLabel, "Youth");
  });

  test("a drop AFTER a boundary holds the entry it had already advanced to", () => {
    // It was connected at 10s, so it advanced then; the drop at 11s freezes it
    // on blank, not back on Weekend.
    assert.equal(draw(25_000, 11_000)?.reason, "blank");
  });

  test("a blip inside one entry changes nothing", () => {
    // The clock freezes somewhere inside the entry it was already showing, so
    // the answer is identical either way. No grace timer needed to achieve that.
    assert.equal(draw(9000, 6000)?.reasonLabel, draw(9000)?.reasonLabel);
  });

  test("a display disconnected before it ever had a horizon shows nothing", () => {
    assert.equal(draw(5000, 1000, []), null);
  });

  test("a clock frozen outside the horizon shows nothing rather than guessing", () => {
    // Dropped before the horizon began. Picking the nearest entry would put
    // content on a wall on the strength of a timestamp nothing vouches for.
    assert.equal(draw(25_000, -5000), null);
  });
});

describe("a display that BOOTS with no server", () => {
  const withDefault: SignageHorizon = [
    { from: 0, until: 10_000, reason: "schedule", reasonLabel: "Weekend", playlist: playlist("weekend") },
    { from: 10_000, until: 20_000, reason: "default", reasonLabel: "Camp loop", playlist: playlist("camp") },
  ];

  test("plays the group default, whatever the clock believes", () => {
    // A Pi has no RTC. It must not consult a window it cannot trust - it plays
    // the thing it was deliberately given.
    assert.equal(bootEntry(withDefault)?.playlist?.id, "camp");
  });

  test("finds it even when the clock lands nowhere near it", () => {
    // bootEntry does not take a time at all, which is the point.
    assert.equal(bootEntry(withDefault)?.reasonLabel, "Camp loop");
  });

  test("prefers a default entry over a scheduled one", () => {
    assert.equal(bootEntry(withDefault)?.reason, "default");
  });

  test("with no default anywhere in the horizon it is black, not a guess", () => {
    // Playing last week's scheduled content on a cold boot is worse than black:
    // it looks correct and is not.
    assert.equal(bootEntry(H), null);
  });

  test("an empty horizon is black", () => {
    assert.equal(bootEntry([]), null);
  });

  test("ignores a default entry that has no playlist", () => {
    const blankDefault: SignageHorizon = [
      { from: 0, until: 10_000, reason: "default", reasonLabel: "", },
    ];
    assert.equal(bootEntry(blankDefault), null);
  });
});

// An encoder that stopped talking is not an encoder that is streaming.
//
// The Resi widget read LIVE at 10pm on a Wednesday with nothing going out. A
// capture off a real account, taken while it was doing exactly that, showed
// why — two encoders, and every field below is the value it actually reported:
//
//   A  status "stopped"  operationalState "stop"  lastUpdate 30s ago
//   B  status "started"  operationalState "stop"  lastUpdate 25h ago
//
// B had finished a stream the previous evening and stopped reporting at
// 02:25:51, minutes before that event's scheduled end. Its `status` had been
// frozen on the last thing it said for twenty-five hours. Resi never clears it,
// so a field meaning "what this encoder was doing when it last spoke" was being
// read as "what it is doing now".
//
// These are the observed values, not values invented to pass. The uuids are
// placeholders: they identify a real customer's hardware and are not read by
// anything under test. Every field that IS read is as captured.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encoderIsLive, type ResiEncoder } from "./resi-service.js";

/** The moment the capture was taken. */
const NOW = Date.parse("2026-08-27T03:26:16.371Z");

/** The two encoders as they reported themselves, uuids redacted. */
const IDLE: ResiEncoder = {
  uuid: "encoder-a",
  status: "stopped",
  operationalState: "stop",
  lastUpdate: "2026-08-27T03:26:16.371Z",
};
const STALE_STARTED: ResiEncoder = {
  uuid: "encoder-b",
  status: "started",
  operationalState: "stop",
  lastUpdate: "2026-08-26T02:25:51.843Z",
};

describe("the encoders as they were when the widget lied", () => {
  it("the idle one is not live", () => {
    assert.equal(encoderIsLive(IDLE, NOW), false);
  });

  it("the one frozen on \"started\" for 25 hours is not live either", () => {
    // THE BUG. Before this, `status === "started"` alone made it live, and the
    // widget said so all night.
    assert.equal(encoderIsLive(STALE_STARTED, NOW), false);
  });

  it("so neither of them reads as streaming", () => {
    assert.equal([IDLE, STALE_STARTED].filter((e) => encoderIsLive(e, NOW)).length, 0);
  });
});

describe("what still counts as live", () => {
  it("started, running, and reporting", () => {
    // The fix must not make the widget useless — this is a real live encoder.
    assert.equal(
      encoderIsLive(
        { uuid: "x", status: "started", operationalState: "start", lastUpdate: "2026-08-27T03:26:00Z" },
        NOW,
      ),
      true,
    );
  });

  it("casing is not allowed to matter", () => {
    // An undocumented API is free to change it, and going dark over a capital
    // letter is the worst failure available here.
    assert.equal(
      encoderIsLive(
        { uuid: "x", status: "STARTED", operationalState: "START", lastUpdate: "2026-08-27T03:26:00Z" },
        NOW,
      ),
      true,
    );
  });

  it("a missing operationalState does not disqualify a fresh encoder", () => {
    // The field is undocumented. Absent is not evidence of stopped.
    assert.equal(
      encoderIsLive({ uuid: "x", status: "started", lastUpdate: "2026-08-27T03:26:00Z" }, NOW),
      true,
    );
  });

  it("a missing lastUpdate does not disqualify one either", () => {
    // Same reasoning: we cannot age a record with no timestamp, so `status`
    // stands. This is the one case the old behaviour was right about.
    assert.equal(encoderIsLive({ uuid: "x", status: "started" }, NOW), true);
  });
});

describe("the two disqualifiers fail independently", () => {
  it("stale but plausible-looking — a box yanked off the network", () => {
    assert.equal(
      encoderIsLive(
        { uuid: "x", status: "started", operationalState: "start", lastUpdate: "2026-08-26T02:25:51Z" },
        NOW,
      ),
      false,
      "25 hours old is not evidence, whatever operationalState claims",
    );
  });

  it("fresh but contradicting itself — a clean stop", () => {
    assert.equal(
      encoderIsLive(
        { uuid: "x", status: "started", operationalState: "stop", lastUpdate: "2026-08-27T03:26:00Z" },
        NOW,
      ),
      false,
      "a record whose own fields disagree is not describing a live stream",
    );
  });
});

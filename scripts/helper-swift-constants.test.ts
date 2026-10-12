// Values the Mac output helper (Swift) copies from the server (TypeScript).
//
// The helper cannot import the server's lists and limits, so it holds a copy of
// each. A copy that drifts is a quiet failure: a mode the server added that the
// helper refuses as unknown, a "late" the log and the server disagree on, a probe
// the server clips differently from the helper. These tests read each Swift value
// from its ASSIGNMENT and compare it with the server's own exported value.
//
// Only a line that starts with the declaration counts, so a comment that quotes
// the value (the files are full of them) cannot satisfy a check.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { MAX_DATAGRAM, MAX_MACS, MAX_MODE_LEN, MAX_MODES, MAX_STR } from "../main/services/kiosk-discovery.js";
import { REPEATED_BAD_PERCENT } from "../main/services/output-health.js";
import { VIDEO_MODES } from "../main/types/output-format.js";

const SWIFT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "helper", "macos", "Sources", "StageUtilityOutputCore");
const read = (file: string) => fs.readFileSync(path.join(SWIFT, file), "utf8");

/** The number assigned by `<indent>public static let <name> = <number>` on its own line. */
function swiftNumber(source: string, name: string): number {
  const found = [...source.matchAll(new RegExp(`^[ \\t]*public static let ${name} = ([0-9.]+)[ \\t]*$`, "gm"))];
  assert.equal(found.length, 1, `exactly one assignment of ${name}, found ${found.length}`);
  return Number(found[0][1]);
}

/** The string literals, in order, of the array assigned by `public static let <name> = [`. */
function swiftStrings(source: string, name: string): string[] {
  const block = source.match(new RegExp(`^[ \\t]*public static let ${name} = \\[[ \\t]*\\n((?:[ \\t]*"[^"\\n]*",?[ \\t]*\\n)*)[ \\t]*\\]`, "m"));
  assert.ok(block, `${name} is assigned an array with one string per line`);
  return [...block[1].matchAll(/"([^"\n]*)"/g)].map((m) => m[1]);
}

describe("the helper's copies of the server's values", () => {
  it("VideoModes.all is exactly VIDEO_MODES, in order", () => {
    assert.deepEqual(swiftStrings(read("CardModes.swift"), "all"), [...VIDEO_MODES]);
  });

  it("LagWatch.badRepeatPercent is REPEATED_BAD_PERCENT", () => {
    assert.equal(swiftNumber(read("CardHealth.swift"), "badRepeatPercent"), REPEATED_BAD_PERCENT);
  });

  const probe = read("Probe.swift");
  for (const [swift, ts, server] of [
    ["maxString", "MAX_STR", MAX_STR],
    ["maxMacs", "MAX_MACS", MAX_MACS],
    ["maxModes", "MAX_MODES", MAX_MODES],
    ["maxModeLength", "MAX_MODE_LEN", MAX_MODE_LEN],
    ["maxDatagram", "MAX_DATAGRAM", MAX_DATAGRAM],
  ] as const) {
    it(`Probe.${swift} is ${ts} in kiosk-discovery.ts`, () => {
      assert.equal(swiftNumber(probe, swift), server);
    });
  }
});

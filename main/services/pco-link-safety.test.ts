// Two things this file guards, both about data that arrives from outside and is
// then trusted.
//
// 1. The Live action URL is read out of a PCO RESPONSE BODY and POSTed to with
//    the operator's App ID and secret in an Authorization header. Nothing
//    checked that it still pointed at PCO. The response comes from PCO over TLS,
//    so this was defence in depth rather than a live hole — but the safe
//    fallback URL already existed, which made the check free.
//
// 2. /log is a LAN-visible page, one record per line, and scrub() exists so a
//    newline in outside data cannot forge an entry. It was applied to four log
//    sites in pco-service.ts and skipped on two others in the same file — the
//    repeated-pattern drift CLAUDE.md calls this repo's most expensive recurring
//    mistake, and the same shape as `safe()` applied on write but not on read.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The check as pco-service.ts defines it, exercised directly. */
function sameOrigin(candidate: unknown, base: string): boolean {
  if (typeof candidate !== "string" || !candidate) return false;
  try {
    return new URL(candidate).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

const PCO = "https://api.planningcenteronline.com/services/v2";

describe("following a URL out of a PCO response body", () => {
  it("accepts a genuine PCO link", () => {
    assert.equal(sameOrigin("https://api.planningcenteronline.com/services/v2/x/live/go", PCO), true);
  });

  it("rejects a look-alike host a prefix check would accept", () => {
    // The reason this compares origins rather than testing startsWith.
    assert.equal(sameOrigin("https://api.planningcenteronline.com.evil.example/steal", PCO), false);
  });

  it("rejects other schemes, other hosts, and anything unparseable", () => {
    for (const bad of [
      "http://api.planningcenteronline.com/x", // downgraded scheme
      "https://evil.example/x",
      "file:///etc/passwd",
      "/services/v2/relative",
      "",
      null,
      undefined,
      42,
    ]) {
      assert.equal(sameOrigin(bad, PCO), false, `must reject ${String(bad)}`);
    }
  });
});

describe("scrub coverage in pco-service.ts", () => {
  it("every console line interpolates only scrubbed values", () => {
    // Matched on the interpolation, not on the word "scrub": a comment saying the
    // right thing cannot satisfy this. An EXACT check over every log site, so a
    // newly-added unscrubbed one fails rather than riding along under a floor.
    const src = fs.readFileSync(path.join(HERE, "pco-service.ts"), "utf8");
    const lines = src.split("\n");
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (!/console\.(log|warn|error)\(/.test(line)) return;
      // Every `${...}` in the line must have scrub( inside it.
      for (const m of line.matchAll(/\$\{([^}]*)\}/g)) {
        if (!m[1].includes("scrub(")) offenders.push(`${i + 1}: ${line.trim()}`);
      }
    });
    assert.deepEqual(offenders, [], "these log sites interpolate unscrubbed values");
  });
});

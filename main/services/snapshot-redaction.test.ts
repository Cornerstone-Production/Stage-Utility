// A config snapshot carries no device secrets.
//
// The snapshot's own header says "Secrets are DELIBERATELY excluded", and the UI
// presents one as safe to keep on a drive or hand to somebody. That held while
// every secret lived in secrets.bin.
//
// Then kiosk-devices.json — classified "config" so a screen's binding survives a
// rebuild, which is right — started carrying each display's token. The file that
// writes it calls that token "the ONLY thing separating a claimed display from
// anything else on the LAN" and ships withoutTokens() to keep it out of HTTP
// listings. The export copied the file verbatim, tokens and all. Anyone holding
// a bundle who could reach the LAN could GET /enroll?device=…&token=….
//
// Emptied rather than deleted: "" is meaningful. authorise() treats an empty
// token as unpinned and pins the first secret the screen presents, so a restored
// binding still works and the display re-pins on its next enrolment.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redactForExport } from "./config-snapshot.js";

const DEVICES = [
  { id: "d1", outputId: "display-1", token: "s3cret-one", hostname: "booth" },
  { id: "d2", outputId: "display-2", token: "s3cret-two", hostname: "lobby" },
];

describe("what leaves the machine in a snapshot", () => {
  it("carries no device token", () => {
    const out = redactForExport("kiosk-devices.json", DEVICES) as typeof DEVICES;
    const leaked = out.filter((d) => d.token !== "");
    assert.deepEqual(leaked, [], `tokens survived the export: ${JSON.stringify(leaked)}`);
  });

  it("keeps the binding, so a restore still works", () => {
    // The whole reason this store is "config". Redacting must not cost the
    // operator the mapping they would be restoring FOR.
    const out = redactForExport("kiosk-devices.json", DEVICES) as typeof DEVICES;
    assert.equal(out.length, 2);
    assert.equal(out[0].id, "d1");
    assert.equal(out[0].outputId, "display-1");
    assert.equal(out[0].hostname, "booth", "non-secret fields are untouched");
  });

  it("empties the token rather than dropping the key", () => {
    // "" is what authorise() reads as unpinned. A MISSING key is undefined, which
    // is not the same thing and would not re-pin.
    const out = redactForExport("kiosk-devices.json", DEVICES) as Record<string, unknown>[];
    assert.ok("token" in out[0], "the key must still be present");
    assert.equal(out[0].token, "");
  });

  it("leaves other stores exactly as they are", () => {
    const settings = { appName: "Stage", token: "not-a-device-token" };
    assert.deepEqual(redactForExport("settings.json", settings), settings);
  });

  it("does not choke on an unexpected shape", () => {
    // A store file is whatever was last written to it, including from an older
    // build. Redaction must never be the thing that breaks an export.
    assert.deepEqual(redactForExport("kiosk-devices.json", null), null);
    assert.deepEqual(redactForExport("kiosk-devices.json", { not: "an array" }), { not: "an array" });
    assert.deepEqual(redactForExport("kiosk-devices.json", [null, 3]), [null, 3]);
  });
});

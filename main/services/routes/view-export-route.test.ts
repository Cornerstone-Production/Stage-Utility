import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { exportFilename } from "./view-routes.js";
import { configExportFilename } from "./system-routes.js";
import { archiveExportFilename } from "./archive-routes.js";
import { setAppTimeZone } from "../app-timezone.js";

// The filename is the part of this route worth pinning in isolation: the body is
// buildViewBundle's, already tested, and the wiring is proven against a real
// server. This is a string built from operator-supplied text and put in a header.
describe("the download filename", () => {
  test("is slugged from the view name and dated", () => {
    assert.equal(
      exportFilename("Left Mic Display", new Date("2026-08-17T12:00:00Z")),
      "stage-utility-view-left-mic-display-2026-08-17.json",
    );
  });

  test("survives a name that is punctuation and spaces", () => {
    // A view named "FOH / Booth (2)" must not produce a path separator, and must
    // not break out of the quoted Content-Disposition value.
    const out = exportFilename("FOH / Booth (2)", new Date("2026-08-17T12:00:00Z"));
    assert.ok(!out.includes("/"), `slug contains a separator: ${out}`);
    assert.ok(!out.includes('"'), `slug contains a quote: ${out}`);
    assert.equal(out, "stage-utility-view-foh-booth-2-2026-08-17.json");
  });

  test("a name with nothing sluggable still yields a filename", () => {
    assert.equal(
      exportFilename("///", new Date("2026-08-17T12:00:00Z")),
      "stage-utility-view-2026-08-17.json",
    );
  });

  test("a very long name is bounded", () => {
    // Some filesystems cap a component at 255 bytes, and the rest of the name
    // carries the date that makes the file identifiable.
    const out = exportFilename("x".repeat(500), new Date("2026-08-17T12:00:00Z"));
    assert.ok(out.length < 120, `filename is ${out.length} chars`);
    assert.ok(out.endsWith("2026-08-17.json"), "the date was truncated away");
  });
});

// Every download is dated in the APP's zone, never the server's clock. Prod runs
// UTC, so a config exported at 22:30 in Chicago on the 4th was named for the 5th
// and read as a file from a day that had not happened yet. patch-export.ts had
// the same line and the same fix first; these are the other three copies, held
// to the same instant so they cannot drift apart again.
describe("download dates follow the app time zone", () => {
  // 04:30Z on the 5th is 23:30 on the 4th in Chicago — the exact report.
  const lateEvening = Date.UTC(2026, 8, 5, 4, 30, 0);

  test("the view, config and archive exports all date the file for the operator's day", (t) => {
    setAppTimeZone("America/Chicago");
    t.after(() => setAppTimeZone(null));
    assert.equal(exportFilename("Left", new Date(lateEvening)), "stage-utility-view-left-2026-09-04.json");
    assert.equal(configExportFilename(lateEvening), "stage-utility-config-2026-09-04.json");
    assert.equal(archiveExportFilename(lateEvening), "stage-archive-2026-09-04.zip");
  });

  test("and still agree with the clock when the zone is UTC", (t) => {
    setAppTimeZone("UTC");
    t.after(() => setAppTimeZone(null));
    assert.equal(configExportFilename(lateEvening), "stage-utility-config-2026-09-05.json");
  });
});

// The kiosk launcher, read as text.
//
// The weaker kind of check, and used here because the alternative is flashing an
// SD card in CI. It is written to be unsatisfiable by prose: each assertion
// matches an actual shell construct with the real variable in it, not a mention
// of the idea.
//
// Two changes are pinned. The launcher used to LOOP on UDP discovery and never
// start a browser until a server answered, so a Pi taken offsite showed nothing
// at all — no cache could help, because nothing was ever loaded. And a service
// worker needs a secure context, which plain HTTP is not, so without the
// Chromium flag a reboot with no server is a dead screen however much was
// cached.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { describe, test } from "node:test";

const SRC = fs.readFileSync("scripts/kiosk/install-linux.sh", "utf8");

/** The launcher heredoc, not the installer around it.
 *
 *  Bounded by the CLOSING delimiter: `indexOf("LAUNCHER")` finds the heredoc's
 *  OPENER, which comes earlier in the file, and slicing to it yields nothing —
 *  a slice that silently matches nothing is a test that silently passes. */
const LAUNCHER = SRC.slice(
  SRC.indexOf("CHROME=chromium-browser"),
  SRC.lastIndexOf("\nLAUNCHER"),
);

describe("the kiosk launcher", () => {
  test("the slice really covers the launcher body", () => {
    // Guards the guard: every assertion below reads this string, and an empty
    // one would make them all vacuous.
    assert.ok(LAUNCHER.includes("exec"), "the launcher slice is empty or mis-bounded");
  });

  test("makes its own origin a secure context, so a service worker can register", () => {
    // Asserted on the flag being APPLIED to the discovered URL, not merely
    // present somewhere in the file.
    assert.match(
      LAUNCHER,
      /--unsafely-treat-insecure-origin-as-secure="\\?\$URL"/,
      "without this the offline worker never registers and a reboot is a dead screen",
    );
  });

  test("and allows a worker on that origin", () => {
    assert.match(LAUNCHER, /--allow-insecure-localhost|--unsafely-treat-insecure-origin/);
  });

  test("remembers the server it found", () => {
    assert.match(SRC, /LAST_SERVER_FILE=/, "nothing records the server address");
    assert.match(
      SRC,
      /printf '%s' "\\?\$URL" > "\\?\$LAST_SERVER_FILE"/,
      "the discovered URL is never written down",
    );
  });

  test("falls back to the last known server rather than blocking forever", () => {
    // The actual read, with the variable, inside the discovery path.
    assert.match(
      SRC,
      /URL="\\?\$\(cat "\\?\$LAST_SERVER_FILE"/,
      "a Pi with no server on the network would never launch a browser",
    );
  });

  test("still prefers a live discovery to the remembered one", () => {
    // The fallback must be reached only after discovery has been tried, or a
    // moved server would never be found again.
    const fallbackAt = SRC.indexOf("LAST_SERVER_FILE\"");
    const discoveryAt = SRC.indexOf("socat");
    assert.ok(discoveryAt > 0 && discoveryAt < fallbackAt, "the fallback runs before discovery");
  });

  test("keeps the explicit server file for the VLAN case", () => {
    // Writing a `server` file beside the device id is the documented escape
    // hatch where broadcast does not cross a VLAN.
    assert.match(SRC, /SERVER_FILE|\/server"/);
  });
});

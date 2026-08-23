// Nothing that arrives in an HTTP request reaches a log line unscrubbed.
//
// `/log` is a LAN-visible page, one record per line. A newline in outside data
// forges an entry that is indistinguishable from one the server wrote —
// precisely when the log matters most, with an operator reading it to work out
// what went wrong mid-service. `scrub()` exists for this and is deliberately
// written in a shape static analysis recognises as a barrier.
//
// It was applied across the route handlers and pco-service and missed entirely
// in stage-controller, where 28 interpolations went straight to the console —
// including `setTimezone`, which CodeQL found as js/log-injection because the
// time zone comes off an HTTP body. The repeated-pattern drift CLAUDE.md calls
// this repo's most expensive recurring mistake.
//
// SCOPE, stated so the gap is deliberate rather than forgotten: this covers the
// files that see HTTP REQUEST data. The wireless drivers log device replies from
// the LAN — around 200 more interpolations — which is a different threat model
// (a mic receiver, not a browser) and a different change. They are not covered
// here and this file does not pretend otherwise.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import { scrub } from "./scrub.js";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The files an HTTP request's own data can reach. */
function requestFacingFiles(): string[] {
  const routes = path.join(HERE, "routes");
  const inRoutes = readdirSync(routes)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => path.join(routes, f));
  return [path.join(HERE, "stage-controller.ts"), path.join(HERE, "pco-service.ts"), ...inRoutes];
}

/** `${…}` inside a console call, without scrub() around it. */
function unscrubbed(file: string): string[] {
  const out: string[] = [];
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (!/console\.(log|warn|error|debug)\(/.test(line)) return;
      for (const m of line.matchAll(/\$\{([^}]*)\}/g)) {
        if (!m[1].includes("scrub(")) out.push(`${path.basename(file)}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    });
  return out;
}

describe("log injection at the request boundary", () => {
  const files = requestFacingFiles();

  it("the scan reads a real set of files", () => {
    // Guards the walk. An empty list would make every assertion below vacuous —
    // how a route-coverage scan in this repo once went green while missing the
    // route it was written for.
    assert.ok(files.length > 8, `only found ${files.length} request-facing files`);
    assert.ok(
      files.some((f) => f.endsWith("stage-controller.ts")),
      "stage-controller.ts is the file this test was written for and it is not in the list",
    );
  });

  it("every interpolation in every one of them is scrubbed", () => {
    const offenders = files.flatMap(unscrubbed);
    assert.deepEqual(
      offenders,
      [],
      `these log outside data unscrubbed — a newline in any of them forges a log line:\n  ${offenders.join("\n  ")}`,
    );
  });

  it("scrub really does neutralise a forged line", () => {
    // The barrier itself, not just its presence. Asserting only that scrub() is
    // CALLED would pass on a scrub() that returned its input unchanged.
    const forged = "Europe/London\n[stage-controller] plan switched to 12345";
    const safe = scrub(forged);
    assert.doesNotMatch(safe, /\n/, "a newline survived scrub");
    assert.match(safe, /\\n/, "the newline should be escaped and visible, not silently dropped");
  });
});

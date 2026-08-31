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
// WHAT THIS FILE USED TO MISS, because the same drift happened to the guard:
//
//   - it read one LINE at a time, so a call wrapped as `console.log(` on one
//     line and the `${…}` on the next matched neither test. Run over
//     stage-controller.ts it reported 0 offenders against 22 real ones,
//     including the plan title on the auto-select line.
//   - integration-manager.ts, which folds a config object straight off an HTTP
//     body and warns with the rejected KEY, was not in the list at all.
//   - the list was held to `length > 8` while holding 24, so fifteen could
//     vanish in silence — the floor-with-slack CLAUDE.md names.
//   - `console.info` was absent, though log-buffer.ts captures it.
//   - only interpolations were checked, so moving the value into an ARGUMENT
//     stepped around the rule. routes/context.ts carried a comment saying
//     exactly that.
//
// The scan itself now lives in console-scan.ts, shared with
// pco-link-safety.test.ts, because these two had already drifted apart once.
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

import { describeOffender, logOffenders } from "./console-scan.js";
import { scrub, scrubError } from "./scrub.js";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The files an HTTP request's own data can reach, by basename.
 *
 * Written out rather than counted, because a count says only how many there are
 * and this list's failure mode is one going missing. A new request-facing file
 * fails here until somebody adds it, which is the moment to ask whether its log
 * lines are scrubbed.
 */
const REQUEST_FACING = [
  "archive-routes.ts",
  "automation-engine.ts",
  "automation-routes.ts",
  "branding-routes.ts",
  "calendar-routes.ts",
  "context.ts",
  "display-settings-routes.ts",
  "history-routes.ts",
  "integration-manager.ts",
  "integration-routes.ts",
  "kiosk-device-routes.ts",
  "log-paths.ts",
  "log-routes.ts",
  "operator-paths.ts",
  "pco-service.ts",
  "preset-routes.ts",
  "proxy-routes.ts",
  "rosstalk-routes.ts",
  "route-harness.ts",
  "scriptview-routes.ts",
  "stage-controller.ts",
  "state-routes.ts",
  "status-routes.ts",
  "system-routes.ts",
  "view-routes.ts",
];

/** The files an HTTP request's own data can reach, as paths. */
function requestFacingFiles(): string[] {
  const routes = path.join(HERE, "routes");
  const inRoutes = readdirSync(routes)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => path.join(routes, f));
  return [
    path.join(HERE, "stage-controller.ts"),
    path.join(HERE, "pco-service.ts"),
    // Rule names are typed into an HTTP body and action detail carries whatever a
    // provider or device said back, so the engine is request-facing in exactly the
    // sense this scan means. It logged nothing at all until a failed rule started
    // being surfaced on /log, which is when it acquired the exposure.
    path.join(HERE, "automation-engine.ts"),
    // POST /api/integrations/:id/config checks only that `config` is an object,
    // then foldConfigEntries warns with the rejected KEY. That key is an
    // attacker's string, verbatim, and this file was missing from the list.
    path.join(HERE, "integration-manager.ts"),
    ...inRoutes,
  ];
}

describe("log injection at the request boundary", () => {
  const files = requestFacingFiles();

  it("the scan reads exactly the set of files it is meant to", () => {
    // Guards the walk. An empty or shrunken list would make the assertion below
    // vacuous — how a route-coverage scan in this repo once went green while
    // missing the route it was written for. EXACT, not a floor: this list was
    // held to `> 8` while holding 24.
    assert.deepEqual(
      files.map((f) => path.basename(f)).sort(),
      [...REQUEST_FACING].sort(),
      "the request-facing set has changed; add the new file to REQUEST_FACING deliberately, " +
        "having first checked that its log lines are scrubbed",
    );
  });

  it("every value reaching a log line in every one of them is scrubbed", () => {
    const offenders = files.flatMap((f) =>
      logOffenders(readFileSync(f, "utf8")).map((o) => describeOffender(path.basename(f), o)),
    );
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

  it("scrubError keeps the stack and still neutralises the line", () => {
    // The reason the argument rule could be applied to `console.error("…:", err)`
    // without losing what an operator reads at 9am on a Sunday: log-buffer
    // renders a raw Error as `err.stack`, every line of it its own record, and
    // scrub() alone would answer that by throwing the stack away.
    const err = new Error("upstream said\n[stage-controller] plan switched to 12345");
    const safe = scrubError(err);
    assert.doesNotMatch(safe, /\n/, "a newline survived scrubError");
    assert.match(safe, /upstream said/, "the message should still be readable");
    assert.ok(safe.includes("log-injection.test.ts"), `the stack did not survive: ${safe}`);
  });
});

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

import { consoleCalls, describeOffender, formatStringOffenders, logOffenders } from "./console-scan.js";
import { scrub, scrubError } from "./scrub.js";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The files an HTTP request's own data can reach, by path under main/services.
 *
 * Paths, not basenames: the walk below and this list now name a file the same
 * way, so `routes/context.ts` cannot be confused with a `context.ts` beside it
 * and a nested file reads as nested.
 *
 * Written out rather than counted, because a count says only how many there are
 * and this list's failure mode is one going missing. A new request-facing file
 * fails here until somebody adds it, which is the moment to ask whether its log
 * lines are scrubbed.
 */
const REQUEST_FACING = [
  // Its title-fallback warning names a plan item TITLE read back out of the raw
  // archive, and POST /api/history/rebuild is what runs it.
  "archive/rebuild.ts",
  "automation-engine.ts",
  // Its suppression line names the STORED rule that owns a built-in's cue name
  // — both the rule's name and the cue name are typed into an HTTP body.
  "builtin-cues.ts",
  "checklist-ticks-store.ts",
  "companion-reconcile.ts",
  // Its lines name a cue pair's base — a rule param typed into an HTTP body —
  // and the Companion variable names and VALUES it read back off a connection
  // whose label came out of Companion's own export.
  "companion-state-probe.ts",
  // Its read failure line carries whatever cue-states could not read, which
  // reaches Companion over HTTP with a variable name typed into a rule.
  "cue-live.ts",
  "cue-manifest.ts",
  // Logs the Companion variable name a cue is bound to, which arrives as a rule
  // param over HTTP.
  "cue-states.ts",
  "cue-tokens.ts",
  "event-poll.ts",
  // Its rebuild lines name a serviceKey, which arrives verbatim in an HTTP
  // body, and rebuildTimelineRecord reaches it with plan item titles.
  "history-edit.ts",
  // Its orphaned-edit warning names a serviceKey and the item ids inside it.
  "history-item-times.ts",
  // Its one line names a milestone LABEL, typed into an HTTP body by the
  // operator (POST /api/history/milestones).
  "history-milestones-store.ts",
  // Its one warning names a cue pair's base, which comes from a cue name typed
  // into an HTTP body.
  "home-assistant-yaml.ts",
  "integration-manager.ts",
  "pco-service.ts",
  "plan-export.ts",
  "routes/archive-routes.ts",
  "routes/automation-routes.ts",
  "routes/branding-routes.ts",
  "routes/calendar-routes.ts",
  "routes/context.ts",
  "routes/cue-routes.ts",
  "routes/display-settings-routes.ts",
  "routes/history-routes.ts",
  "routes/integration-routes.ts",
  "routes/kiosk-device-routes.ts",
  "routes/log-paths.ts",
  "routes/log-routes.ts",
  "routes/operator-paths.ts",
  "routes/plan-routes.ts",
  "routes/preset-routes.ts",
  "routes/proxy-routes.ts",
  "routes/rosstalk-routes.ts",
  "routes/route-harness.ts",
  "routes/scriptview-routes.ts",
  "routes/state-routes.ts",
  "routes/status-routes.ts",
  "routes/system-routes.ts",
  "routes/view-routes.ts",
  // Both recorders name a Planning Center PLAN ITEM TITLE on their re-run and
  // carry-over lines. A title is typed into Planning Center and arrives here in
  // an HTTP response body — outside data by every measure this file uses, and
  // the same exposure pco-service.ts is scanned for.
  "service-timeline-recorder.ts",
  "spl-recorder.ts",
  "stage-controller.ts",
  "view-import.ts",
  // The channel title on a successful Connect comes back from Google, not the
  // operator, but it is still external data reaching a log line.
  "youtube-connect.ts",
];

/**
 * Every non-test `.ts` under main/services that actually makes a console call,
 * relative to this directory.
 *
 * Matched with the shared scan rather than on the word "console", so a file that
 * only talks about logging in a comment is not counted as logging.
 *
 * This exists because the list above described what the walk FOUND, not what
 * exists. `routes/` is walked, so a new route forces a decision; everything
 * outside it was four hardcoded paths, and a new service that logs wire data was
 * simply never looked at — with the exact-list assertion still green, because
 * the list and the walk agreed with each other about a set that was too small.
 * That is the failure mode this whole file is about, one level up.
 */
function loggingServices(dir = HERE, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...loggingServices(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      if (consoleCalls(readFileSync(path.join(dir, entry.name), "utf8")).length > 0) out.push(rel);
    }
  }
  return out.sort();
}

/** Held to the same rule by a different guard. */
const ELSEWHERE = "held to this rule by pco-link-safety.test.ts, which scans both PCO clients";

/** The scope this file's header already states, applied consistently. */
const DEVICE =
  "logs what a device, an appliance or a provider said back — the threat model the " +
  "wireless drivers are already excluded for at the top of this file, and a different change";

/**
 * The honest label. Being here is a decision RECORDED, not a clean bill of
 * health: keyed-record-store.ts logs a record's file name, and for some stores
 * that name comes from a key the operator typed. Moving one of these into the
 * scanned set is the cheap follow-up, and the exclusion is written down so
 * somebody can.
 */
const UNAUDITED =
  "logs its own operation and its own failures; not audited line by line — listed so " +
  "the set is closed, NOT certified clean";

/** Files that log and are deliberately NOT scanned, each with its reason. */
const NOT_SCANNED = new Map<string, string>([
  ["app-paths.ts", UNAUDITED],
  ["app-root.ts", UNAUDITED],
  ["archive/archive-bundle.ts", UNAUDITED],
  ["archive/csv-appender.ts", UNAUDITED],
  // Its one line reports a failed save of automation-log.json itself — a
  // filesystem error (ENOSPC, EACCES) — never an entry's ruleName/detail/caller,
  // which is the operator-typed content an HTTP body can reach. Audited, not
  // just excused: there is nothing here for a request to put a newline into.
  [
    "automation-log.ts",
    "logs its own save failures only (a filesystem error), never an entry's content; audited",
  ],
  ["backup-scheduler.ts", UNAUDITED],
  ["baptism-timer-service.ts", UNAUDITED],
  ["bar-config-store.ts", UNAUDITED],
  ["branding-image-store.ts", UNAUDITED],
  ["broadcaster.ts", UNAUDITED],
  ["cache-maintenance.ts", UNAUDITED],
  ["calendar-broadcaster.ts", UNAUDITED],
  ["companion-api.ts", DEVICE],
  ["config-snapshot.ts", UNAUDITED],
  ["data-store.ts", UNAUDITED],
  ["device-manager.ts", DEVICE],
  ["encryption.ts", UNAUDITED],
  ["keyed-record-store.ts", UNAUDITED],
  ["kiosk-responder.ts", DEVICE],
  ["layout-image-store.ts", UNAUDITED],
  ["layout-library.ts", UNAUDITED],
  ["live-poller.ts", DEVICE],
  ["obs-protocol.ts", DEVICE],
  ["obs-service.ts", DEVICE],
  ["osc-manager.ts", DEVICE],
  ["pco-attachment-cache.ts", UNAUDITED],
  ["pco-calendar-service.ts", ELSEWHERE],
  ["photo-cache.ts", UNAUDITED],
  ["prodcom-service.ts", DEVICE],
  ["propresenter-service.ts", DEVICE],
  ["pvp-service.ts", DEVICE],
  ["reaper-service.ts", DEVICE],
  ["reconcile-records.ts", UNAUDITED],
  ["remote-server.ts", DEVICE],
  ["resi-service.ts", DEVICE],
  ["rosstalk-manager.ts", DEVICE],
  ["scores-service.ts", DEVICE],
  ["scriptview-layouts-store.ts", UNAUDITED],
  ["secrets.ts", UNAUDITED],
  ["sensource-service.ts", DEVICE],
  ["service-recorder.ts", UNAUDITED],
  ["slots-store.ts", UNAUDITED],
  ["smaart-service.ts", DEVICE],
  ["stream-start-store.ts", UNAUDITED],
  ["tsl-service.ts", DEVICE],
  ["update/relaunch.ts", UNAUDITED],
  ["updater.ts", UNAUDITED],
  ["wireless-manager.ts", DEVICE],
  ["youtube-service.ts", DEVICE],
]);

/** The files an HTTP request's own data can reach, as paths. */
function requestFacingFiles(): string[] {
  const routes = path.join(HERE, "routes");
  const inRoutes = readdirSync(routes)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => path.join(routes, f));
  // Sorted alphabetically by filename, one entry per line, each comment
  // directly above the file it explains, so two branches adding different
  // files touch different lines and merge cleanly.
  const files = [
    // Rule names are typed into an HTTP body and action detail carries whatever a
    // provider or device said back, so the engine is request-facing in exactly the
    // sense this scan means. It logged nothing at all until a failed rule started
    // being surfaced on /log, which is when it acquired the exposure.
    path.join(HERE, "automation-engine.ts"),
    // Same exposure as cue-tokens: the built-in it declines to offer is named
    // beside the stored rule that owns the name, and a rule name and a cue name
    // both arrive in an HTTP body.
    path.join(HERE, "builtin-cues.ts"),
    // The plan id and the checklist row label both arrive in an HTTP body. It
    // reached beta AFTER this scan's coverage half was written, and the coverage
    // half caught it on its first run against a tree that had it — which is the
    // whole reason that half exists.
    path.join(HERE, "checklist-ticks-store.ts"),
    // Every value on its lines is either a cue name — typed into an HTTP body
    // — or a Companion page name out of the export. Both reach `/log`.
    path.join(HERE, "companion-reconcile.ts"),
    // The learned variable name and the two values on its lines are read off
    // Companion over HTTP, and the pair's base is a cue name typed into an HTTP
    // body. See companion-state-probe.ts.
    path.join(HERE, "companion-state-probe.ts"),
    // Its read failure line carries whatever cue-states could not read, which
    // reaches Companion over HTTP with a variable name typed into a rule.
    path.join(HERE, "cue-live.ts"),
    // Scanned rather than excluded even though its one line carries a COUNT and
    // nothing else: the file is reached by `GET /api/cues/manifest`, and the
    // next line added to it will be under the scan rather than outside it.
    path.join(HERE, "cue-manifest.ts"),
    // Its lines name the Companion custom variable a cue pair is bound to and
    // the pair's base — a rule param typed into an HTTP body — and the value
    // Companion sent back.
    path.join(HERE, "cue-states.ts"),
    // A cue token's LABEL is typed into an HTTP body ("Home Assistant") and is
    // logged when the token is minted.
    path.join(HERE, "cue-tokens.ts"),
    // Its two lines name a poll client's `cid`, which is whatever string a
    // caller put on the /api/events/poll query string — an attacker's value,
    // verbatim, reaching /log.
    path.join(HERE, "event-poll.ts"),
    // Every rebuild/merge line names a serviceKey, which arrives verbatim in an
    // HTTP body — POST /api/history/rebuild and /api/history/merge both take it
    // from the caller — and the rebuild it drives reaches plan item titles.
    path.join(HERE, "history-edit.ts"),
    // Its one line — a pair whose two halves press the same Companion button
    // with no state variable bound — names the pair's base, which is a cue name
    // typed into an HTTP body.
    // Its orphaned-edit warning names a serviceKey and the item ids inside it.
    // Both come from Planning Center over HTTP, and the itemId can also arrive
    // directly in a POST /api/history/item-times body.
    path.join(HERE, "history-item-times.ts"),
    // The milestone label on its one line is typed into an HTTP body by the
    // operator (POST /api/history/milestones), so a newline in one would forge
    // a `/log` entry. It is scrubbed at the logger.
    path.join(HERE, "history-milestones-store.ts"),
    path.join(HERE, "home-assistant-yaml.ts"),
    // POST /api/integrations/:id/config checks only that `config` is an object,
    // then foldConfigEntries warns with the rejected KEY. That key is an
    // attacker's string, verbatim, and this file was missing from the list.
    path.join(HERE, "integration-manager.ts"),
    path.join(HERE, "pco-service.ts"),
    // A plan export's log line names the service type, which comes from Planning
    // Center over HTTP; the query that asks for it is an HTTP request.
    path.join(HERE, "plan-export.ts"),
    // The same exposure as the two recorders, from the other end: its
    // title-fallback warning names a Planning Center plan item TITLE, read back
    // out of the raw archive, and POST /api/history/rebuild is what runs it.
    path.join(HERE, "archive/rebuild.ts"),
    // Both recorders log a Planning Center plan item TITLE — on the re-run line
    // and, for the timeline, on the carried-over-item line. A title is typed
    // into Planning Center and reaches this process in an HTTP response body.
    path.join(HERE, "service-timeline-recorder.ts"),
    path.join(HERE, "spl-recorder.ts"),
    path.join(HERE, "stage-controller.ts"),
    // Every value on its three log lines comes out of an UPLOADED FILE — the
    // service type name and id, a patch sheet's name, a variant's name. It
    // logged nothing at all before the plan import, which is when it acquired
    // the exposure.
    path.join(HERE, "view-import.ts"),
    // The channel title on a successful Connect is read back from Google over
    // HTTP, not typed by the operator, but it is still external data reaching
    // a log line the same way a device's reply would.
    path.join(HERE, "youtube-connect.ts"),
  ];
  return [...files, ...inRoutes];
}

/** The hand-written part of {@link requestFacingFiles}, for the sortedness check below. */
const REQUEST_FACING_LITERAL = requestFacingFiles().filter((f) => !f.includes(`${path.sep}routes${path.sep}`));

describe("log injection at the request boundary", () => {
  const files = requestFacingFiles();

  it("the scan reads exactly the set of files it is meant to", () => {
    // Guards the walk. An empty or shrunken list would make the assertion below
    // vacuous — how a route-coverage scan in this repo once went green while
    // missing the route it was written for. EXACT, not a floor: this list was
    // held to `> 8` while holding 24.
    assert.deepEqual(
      files.map((f) => path.relative(HERE, f)).sort(),
      [...REQUEST_FACING].sort(),
      "the request-facing set has changed; add the new file to REQUEST_FACING deliberately, " +
        "having first checked that its log lines are scrubbed",
    );
  });

  it("REQUEST_FACING and the hand-written half of requestFacingFiles() stay sorted", () => {
    // Both lists are read and merged by branch-adding, not by whole-file
    // rewrite: two branches each adding a different file touch different
    // lines and merge cleanly only if the list stays alphabetical.
    assert.deepEqual(
      REQUEST_FACING,
      [...REQUEST_FACING].sort(),
      "keep this list sorted so two branches adding entries merge cleanly",
    );
    const literalBasenames = REQUEST_FACING_LITERAL.map((f) => path.basename(f));
    assert.deepEqual(
      literalBasenames,
      [...literalBasenames].sort(),
      "keep this list sorted so two branches adding entries merge cleanly",
    );
  });

  it("and every service that logs at all is either scanned or excluded on purpose", () => {
    // The boundary itself, DERIVED rather than declared. The list above is only
    // as good as the walk that feeds it: `routes/` is read off disk, so a new
    // route forces a decision, but everything outside it was four hardcoded
    // paths — and a new service logging wire data was never looked at while this
    // suite stayed green, because the list and the walk agreed with each other
    // about a set that was too small.
    //
    // It has already happened: checklist-ticks-store.ts arrived logging a plan
    // id and a row label that both come off the wire, CodeQL found an unscrubbed
    // interpolation in it, and nothing here would ever have opened the file.
    //
    // Both directions are asserted, so neither half can drift. Nothing that logs
    // may be unaccounted for; and no exclusion may name a file that has stopped
    // logging or stopped existing — which is also what catches a walk that
    // silently returns nothing, since every exclusion would then be stale.
    const logging = loggingServices();
    const scanned = new Set(files.map((f) => path.relative(HERE, f)));

    const unaccounted = logging.filter((f) => !scanned.has(f) && !NOT_SCANNED.has(f));
    assert.deepEqual(
      unaccounted,
      [],
      "these files under main/services log and nothing has decided whether an HTTP request " +
        "can reach what they log. Add each to requestFacingFiles() or to NOT_SCANNED with a " +
        `reason:\n  ${unaccounted.join("\n  ")}`,
    );

    const stale = [...NOT_SCANNED.keys()].filter((f) => !logging.includes(f)).sort();
    assert.deepEqual(
      stale,
      [],
      `these exclusions name a file that no longer logs, or no longer exists:\n  ${stale.join("\n  ")}`,
    );
  });

  it("NOT_SCANNED stays sorted", () => {
    const keys = [...NOT_SCANNED.keys()];
    assert.deepEqual(
      keys,
      [...keys].sort(),
      "keep this list sorted so two branches adding entries merge cleanly",
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

/**
 * The sites that build a format string out of a value and are allowed to,
 * because the value is the app's own.
 *
 * `console.log(fmt, …rest)` reads `fmt` as a format string, so a `%s` in it
 * consumes one of the arguments that follow. The rule therefore covers EVERY
 * service that logs, not just the request-facing ones — unlike the scrub rules
 * it needs no judgement about a value's provenance to CHECK, only to excuse.
 *
 * Each entry names the interpolated value and why it cannot carry a `%`. A
 * constant, a fixed union member, a number and an errno code are all things the
 * app produced; none is a string somebody typed. Anything that is not on that
 * list belongs in an argument.
 */
const FORMAT_STRING_ALLOWED = new Map<string, string>([
  ["app-paths.ts", "two paths built from constants"],
  ["branding-image-store.ts", "`key`, iterated out of the constant BRANDING_IMAGE_KEYS"],
  ["broadcaster.ts", "`channel`, a member of the fixed channel union"],
  ["config-snapshot.ts", "`what`, an internal label for the thing being quieted"],
  ["data-store.ts", "`this.filename`, the store's own constant"],
  ["live-poller.ts", "`who`, the internal name of the caller that ticked"],
  ["osc-manager.ts", "a port number"],
  ["secrets.ts", "a Node errno code"],
  ["service-recorder.ts", "`this.label`, the recorder's own constant"],
]);

describe("a value never becomes the format string", () => {
  it("in any service that logs, not only the request-facing ones", () => {
    // The third rule, swept wider than the other two.
    //
    // `console.error(`[x] row ${scrub(label)} failed:`, scrubError(err))` passes
    // both scrub rules and still loses the error, because a checklist row
    // reading "Batteries 100% charged" puts a `%s` in the format string and the
    // `%s` eats the argument after it. The operator is told that something
    // failed and not told why. scrub() cannot help: `%` is an ordinary
    // character and comes through it untouched. The value is safe; the POSITION
    // is not.
    //
    // Keyed by FILE, not by line: a line number breaks on any edit above it,
    // and the fact under test is which files still do this. A second site in an
    // allowed file also fails, because the same key then appears twice on one
    // side of the comparison and once on the other.
    const sites = loggingServices().flatMap((rel) =>
      formatStringOffenders(readFileSync(path.join(HERE, rel), "utf8")).map(
        (o) => `${rel}  ${o.line}  ${o.text}`,
      ),
    );
    const files = sites.map((s) => s.split("  ")[0]).sort();
    assert.deepEqual(
      files,
      [...FORMAT_STRING_ALLOWED.keys()].sort(),
      "a console call interpolates into its format string with further arguments after it. " +
        "Move the value into an argument and leave the format string a literal, or add it to " +
        `FORMAT_STRING_ALLOWED with the reason its value cannot carry a '%':\n  ${sites.join("\n  ")}`,
    );
  });
});


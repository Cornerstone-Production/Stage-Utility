// Every integration must be reachable from a rule.
//
// Entries are hand-written per integration, which is deliberate — each reads in
// its own words. The cost is drift: a new integration would otherwise have no
// automation until somebody remembered. This turns that from "noticed months
// later" into "fails on the pull request", and names the id that is missing.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";

import { AUTOMATION_CONDITIONS } from "./automation-conditions.js";
import { AUTOMATION_TRIGGERS, CALL_CHANNEL, INTEGRATIONS } from "./automation-triggers.js";
import { INTEGRATION_IDS } from "./integration-ids.js";

/**
 * Channels something actually broadcasts, READ OFF THE SOURCE.
 *
 * This was a hand-maintained literal set, and the test below that asks whether
 * anything publishes the call channel was green with a real
 * `broadcast("cue:call", …)` added to stage-controller — the set simply did not
 * know. It is now scanned: every `broadcast("<channel>"` and
 * `sseWrite(res, "<channel>"` under main/services, walked recursively, tests
 * excluded.
 *
 * A source scan is the weaker kind of guard (a comment can satisfy one), so two
 * things keep this one honest: the pattern matches a CALL with its opening paren
 * and a string literal, which prose does not contain, and SCAN_SANITY below
 * fails if the walk or the pattern ever stops finding the channels we know are
 * there.
 *
 * The integration channels (`obs:status`, `reaper:status`, `resi:status`,
 * `youtube:status`, `spl:metrics`, `people:count`) are passed to the
 * IntegrationBase constructor and published from there, so no literal reaches
 * either call. They are added explicitly, and are the only hand-written entries
 * left.
 */
const INTEGRATION_BASE_CHANNELS = [
  "obs:status",
  "people:count",
  "reaper:status",
  "resi:status",
  "spl:metrics",
  "youtube:status",
];

/** Every .ts under a directory except tests, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function scanBroadcastChannels(): Set<string> {
  const found = new Set<string>(INTEGRATION_BASE_CHANNELS);
  const patterns = [
    /\bbroadcast\(\s*"([^"]+)"/g,
    /\bsseWrite\(\s*res\s*,\s*"([^"]+)"/g,
  ];
  for (const file of sourceFiles(path.join(import.meta.dirname, "..", "services"))) {
    const text = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const m of text.matchAll(pattern)) found.add(m[1]!);
    }
  }
  return found;
}

const BROADCAST_CHANNELS = scanBroadcastChannels();

/** Channels the scan MUST find. If it stops finding these, the walk or the
 *  pattern is broken and every assertion below is passing on an empty set. */
const SCAN_SANITY = ["pco:live", "stage:state-changed", "slots:devices", "prodcom:transcript"];

describe("automation coverage", () => {
  test("every integration appears in at least one trigger or condition", () => {
    const ids = [...Object.keys(AUTOMATION_TRIGGERS), ...Object.keys(AUTOMATION_CONDITIONS)];
    const missing = INTEGRATION_IDS.filter((id) => !ids.some((k) => k.startsWith(`${id}.`)));
    assert.deepEqual(
      missing,
      [],
      `No automation entries for: ${missing.join(", ")}. ` +
        "Add a trigger or condition for each, or this integration cannot be automated.",
    );
  });

  test("the trigger registry's integration list matches the shipped one", () => {
    // INTEGRATIONS carries the labels rules are written against; INTEGRATION_IDS
    // is what the manager ships. If they drift, an integration silently loses its
    // connect/disconnect pair or gains one for something that does not exist.
    assert.deepEqual(
      INTEGRATIONS.map((i) => i.id).sort(),
      [...INTEGRATION_IDS].sort(),
    );
  });

  test("every integration has a label, so no rule reads as a raw id", () => {
    for (const i of INTEGRATIONS) {
      assert.ok(i.label.trim().length > 0, `${i.id} has no label`);
      assert.notEqual(i.label, i.id, `${i.id} needs a human label, not its id`);
    }
  });

  test("every registered trigger names a channel that something broadcasts", () => {
    // A typo'd channel is a trigger that can never fire, and nothing else
    // would ever say so.
    //
    // CALL_CHANNEL is the one exemption, and the assertion below is what keeps
    // the exemption honest: a called cue is SUPPOSED to have no producer.
    for (const t of Object.values(AUTOMATION_TRIGGERS)) {
      if (t.channel === CALL_CHANNEL) continue;
      assert.ok(
        BROADCAST_CHANNELS.has(t.channel),
        `${t.id} watches unknown channel "${t.channel}"`,
      );
    }
  });

  test("the scan actually reads the source", () => {
    // Without this the two tests below pass on an empty set, which is how a
    // source-reading guard goes quietly vacuous.
    for (const channel of SCAN_SANITY) {
      assert.ok(
        BROADCAST_CHANNELS.has(channel),
        `the broadcast scan found no "${channel}" — the walk or the pattern is broken`,
      );
    }
    assert.ok(BROADCAST_CHANNELS.size >= 20, `only ${BROADCAST_CHANNELS.size} channels scanned`);
  });

  test("nothing broadcasts the call channel", () => {
    assert.equal(
      BROADCAST_CHANNELS.has(CALL_CHANNEL),
      false,
      `${CALL_CHANNEL} is broadcast somewhere under main/services now — a called ` +
        "cue could fire itself. Either stop broadcasting it, or give call.by-name a " +
        "channel nothing publishes.",
    );
  });

  test("exactly one trigger is call-only", () => {
    // An EXACT count, not a floor. A second trigger on this channel is a second
    // thing the engine's skip has to cover, and the skip is written once.
    const callOnly = Object.values(AUTOMATION_TRIGGERS).filter((t) => t.channel === CALL_CHANNEL);
    assert.deepEqual(callOnly.map((t) => t.id), ["call.by-name"]);
  });

  test("no two entries share an id", () => {
    for (const [key, t] of Object.entries(AUTOMATION_TRIGGERS)) {
      assert.equal(key, t.id, `trigger registered as "${key}" but declares id "${t.id}"`);
    }
    for (const [key, c] of Object.entries(AUTOMATION_CONDITIONS)) {
      assert.equal(key, c.id, `condition registered as "${key}" but declares id "${c.id}"`);
    }
  });
});

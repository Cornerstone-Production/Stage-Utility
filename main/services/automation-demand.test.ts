// Automation rules must fire on an unattended box.
//
// Several integrations skip broadcasting when nothing is watching — sensible,
// until a consumer appears that the SSE subscriber check cannot see. The
// automation engine is exactly that: it listens on the broadcast bus in-process.
//
// smaart-service gated its push on `hasSubscribers`, so on a Sunday with no
// browser rendering an SPL meter — the normal state for an appliance — the
// engine's snapshot for "spl:metrics" was never seeded and spl.crossed-above
// never fired. The operator saw an enabled rule that had simply never run, and
// no error anywhere.
//
// Drives the real engine and the real publish path.

import assert from "node:assert/strict";
import { describe, it, before, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-automation-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { automationEngine } = await import("./automation-engine.js");
const { automationStore } = await import("./automation-store.js");
const { smaartService } = await import("./smaart-service.js");
const { addBroadcastListener, setSubscriberCheck } = await import("./broadcaster.js");

// The unattended box: no browser subscribed to anything. Without this the
// broadcaster assumes "watched" (its documented default before the transport
// registers), which is the opposite of the state this bug lived in.
setSubscriberCheck(() => false);

/** An SPL threshold rule, the shape an operator builds in the Automation tab. */
const SPL_RULE = {
  name: "SPL over 100",
  enabled: true,
  trigger: { id: "spl.crossed-above", params: { meter: "FOH::Main", threshold: 100 } },
  conditions: [],
  actions: [],
} as unknown as Parameters<typeof automationEngine.addRule>[0];

describe("automation demand on gated channels", () => {
  before(async () => {
    await automationEngine.init();
  });

  beforeEach(async () => {
    await automationStore.saveRules([]);
    await automationEngine.init();
  });

  it("an enabled SPL rule makes the engine want spl:metrics", async () => {
    assert.equal(automationEngine.wantsChannel("spl:metrics"), false, "no rules, no demand");
    await automationEngine.addRule(SPL_RULE);
    assert.equal(automationEngine.wantsChannel("spl:metrics"), true);
  });

  it("a disabled rule creates no demand", async () => {
    await automationEngine.addRule({ ...SPL_RULE, enabled: false });
    assert.equal(automationEngine.wantsChannel("spl:metrics"), false);
  });

  it("smaart broadcasts with NO browser attached when a rule wants the channel", async () => {
    await automationEngine.addRule(SPL_RULE);

    let sawSpl = false;
    addBroadcastListener((channel) => {
      if (channel === "spl:metrics") sawSpl = true;
    });

    // The real publish path, with no SSE subscribers — which is the whole point:
    // before this, hasSubscribers was false here and the push was skipped.
    (smaartService as unknown as { publish: (s: unknown, i: boolean) => void }).publish(
      { meters: {}, connected: true },
      true,
    );

    assert.ok(sawSpl, "a rule reading spl:metrics must keep the channel flowing without a browser");
  });

  it("without any rule, an unwatched channel still stays quiet", async () => {
    let sawSpl = false;
    addBroadcastListener((channel) => {
      if (channel === "spl:metrics") sawSpl = true;
    });

    (smaartService as unknown as { publish: (s: unknown, i: boolean) => void }).publish(
      { meters: {}, connected: true },
      true,
    );

    // The efficiency this gate exists for must survive the fix: 4 Hz to nobody
    // is still wasted work.
    assert.equal(sawSpl, false, "no consumer, no push");
  });
});

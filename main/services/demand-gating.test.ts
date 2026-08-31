// A producer that skips work "when nobody is watching" has to count the
// consumers it cannot see.
//
// `channelHasSubscribers` answers one question: is a BROWSER subscribed to this
// SSE channel. The automation engine is not a browser — it listens on the
// broadcast bus inside this process — so every gate written against the
// subscriber check alone silently disabled the rules reading that channel. It
// shipped that way three times: smaart-service skipped the push (spl.crossed-above
// never fired), stage-controller skipped the whole device re-resolve
// (wireless.battery-below and wireless.rf-below never fired), and prodcom-service
// skipped the transcript push (prodcom.phrase-said never fired). Each looked
// perfect to an operator with the panel open, and did nothing on the unattended
// appliance those rules exist for.
//
// One table per gate shape rather than a file per service, because a copy per
// service is a chance to forget the next one.
//
// Every case drives the real thing: a real HTTP server the pollers really poll,
// the real connect() and its real cadence decision, the real SSE frame handler,
// the real device-status path — all with the subscriber check pinned to "nobody
// is watching", which is the state the bug lived in.

import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { DeviceStatus } from "../types/devices.js";
import type { Rule } from "../types/automation.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-demand-gate-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { automationEngine } = await import("./automation-engine.js");
const { automationStore } = await import("./automation-store.js");
const { AUTOMATION_TRIGGERS } = await import("./automation-triggers.js");
const { AUTOMATION_CONDITIONS } = await import("./automation-conditions.js");
const { reaperService } = await import("./reaper-service.js");
const { propresenterService } = await import("./propresenter-service.js");
const { prodcomService } = await import("./prodcom-service.js");
const { stageController } = await import("./stage-controller.js");
const { addBroadcastListener, channelDemandSourceCount, setSubscriberCheck } =
  await import("./broadcaster.js");

// THE unattended box. Without this the broadcaster fails open — its documented
// behaviour before the transport registers a check — which is the opposite of
// the state every one of these bugs lived in.
setSubscriberCheck(() => false);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Rules are what create in-process demand, so each case installs its own. */
async function setRules(rules: Partial<Rule>[]): Promise<void> {
  await automationStore.saveRules(
    rules.map((r, i) => ({
      id: `demand-test-${i}`,
      name: `demand test ${i}`,
      enabled: true,
      conditions: [],
      action: { id: "noop", params: {} },
      cooldownSec: 0,
      oncePerService: false,
      ...r,
    })) as Rule[],
  );
  await automationEngine.init();
}

// ── The gear the pollers poll ────────────────────────────────────────────────
//
// A real server on a real socket. Answers REAPER's /_/TRANSPORT and everything
// ProPresenter asks for, so connect() takes its SUCCESS path — which is the only
// path that reaches the cadence decision under test.
let gear: http.Server;
let gearPort = 0;

before(async () => {
  gear = http.createServer((req, res) => {
    if ((req.url ?? "").startsWith("/_/TRANSPORT")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("TRANSPORT\t5\t12.5\t0\t0:12\t1.1\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => gear.listen(0, "127.0.0.1", resolve));
  const addr = gear.address();
  gearPort = typeof addr === "object" && addr ? addr.port : 0;
  await automationEngine.init();
});

after(async () => {
  reaperService.stop();
  propresenterService.stop();
  await new Promise<void>((resolve) => gear.close(() => resolve()));
});

// ── Gate 1: the polling cadence ──────────────────────────────────────────────
//
// Both of these choose their next delay at the end of a successful poll. Asserted
// as "with a consumer it must be FASTER than with none" rather than against the
// constants, so the check keeps its meaning when somebody retunes a cadence — and
// so that a gate reading only the subscriber check collapses the two to the same
// number, which is exactly the bug.

interface Poller {
  running: boolean;
  scheduleIn(ms: number): void;
  connect(): Promise<void>;
  configure(host: string, port: number): void;
  stop(): void;
}

/**
 * Drive one real poll and report the delay it scheduled next.
 *
 * scheduleIn is replaced for the call so the timer is never armed (a live 1s poll
 * against the stub would run for the rest of the file), but the expression that
 * CHOOSES the delay — the gate under test — runs for real.
 */
async function scheduledDelayMs(svc: Poller): Promise<number> {
  const original = svc.scheduleIn.bind(svc);
  let scheduled: number | null = null;
  svc.scheduleIn = (ms: number) => {
    scheduled = ms;
  };
  try {
    svc.running = true;
    await svc.connect();
  } finally {
    svc.scheduleIn = original;
  }
  if (scheduled === null) assert.fail("the poll scheduled nothing at all — it never reached the gate");
  return scheduled;
}

/** ProPresenter has no in-process consumer today. This stands in for the one the
 *  next feature adds; the gate has to be right BEFORE that consumer exists. */
let ppWanted = false;
propresenterService.addDemandSource(() => ppWanted);

const POLLERS: {
  label: string;
  service: Poller;
  demand: (on: boolean) => Promise<void>;
}[] = [
  {
    label: "REAPER",
    service: reaperService as unknown as Poller,
    // A real rule carrying the real condition. reaper.is-recording is PULLED from
    // reaperService.getLatest() when a rule fires, so an idling poll hands the
    // qualifier a stale answer and nothing anywhere says so.
    demand: (on) =>
      setRules(
        on
          ? [{
              trigger: { id: "service.started", params: {} },
              conditions: [{ id: "reaper.is-recording", params: {} }],
            }]
          : [],
      ),
  },
  {
    label: "ProPresenter",
    service: propresenterService as unknown as Poller,
    demand: async (on) => {
      ppWanted = on;
    },
  },
];

describe("a poll keeps its fast cadence for a consumer no browser check can see", () => {
  for (const { label, service, demand } of POLLERS) {
    it(`${label} polls faster with a consumer than with nobody at all`, async () => {
      service.configure("127.0.0.1", gearPort);

      await demand(false);
      const idle = await scheduledDelayMs(service);

      await demand(true);
      const active = await scheduledDelayMs(service);

      await demand(false);
      service.stop();

      assert.ok(
        active < idle,
        `${label} scheduled ${active}ms with a consumer and ${idle}ms with none — ` +
          "the gate is asking whether a BROWSER is attached, so an in-process " +
          "consumer reads a snapshot at the idle cadence for ever",
      );
    });
  }
});

// ── Gate 2: broadcasting at all ──────────────────────────────────────────────
//
// The dangerous kind. A skipped broadcast is not a slower rule, it is a rule that
// cannot fire: the engine never even seeds a baseline for the channel.

/** One pack, low enough to be worth a rule. */
const DEVICE: DeviceStatus = {
  channelId: "demand-test-1",
  name: "Pastor",
  deviceType: "receiver",
  online: true,
  rfBars: 4,
  rfLevelDbm: -60,
  battery: 15,
  batteryMinutes: 40,
  charging: false,
  frequencyLabel: "512.000",
  audioLevel: null,
  cycles: null,
  health: null,
  tempC: null,
  updatedAt: new Date().toISOString(),
};

const BROADCASTERS: {
  label: string;
  channel: string;
  trigger: Rule["trigger"];
  drive: () => Promise<void>;
}[] = [
  {
    label: "ProdCom transcript",
    channel: "prodcom:transcript",
    trigger: { id: "prodcom.phrase-said", params: { phrase: "amen" } },
    // The real SSE frame handler, fed the shape ProdCom puts on the wire.
    drive: async () => {
      (
        prodcomService as unknown as { handleEvent(raw: string): void }
      ).handleEvent(
        'data: {"id":"line-1","text":"and all the people said amen","channelId":"1",' +
          '"channelName":"Prod","inProgress":false}',
      );
    },
  },
  {
    label: "wireless device status",
    channel: "slots:devices",
    trigger: { id: "wireless.battery-below", params: { threshold: 20 } },
    drive: async () => {
      // The broadcast dedupes on a signature of the payload, so a second identical
      // push is dropped whatever the gate said. Clearing it keeps the two phases
      // independent of each other and of their order.
      (stageController as unknown as { lastDeviceSig: string | null }).lastDeviceSig = null;
      stageController.applyDeviceStatus("demand-test-1", DEVICE);
      await sleep(250); // the coalescing flush timer
    },
  },
];

describe("a channel an automation rule reads is broadcast with no browser attached", () => {
  for (const { label, channel, trigger, drive } of BROADCASTERS) {
    it(`${label} stays silent with no consumer, and flows for a rule`, async () => {
      let seen = 0;
      addBroadcastListener((c) => {
        if (c === channel) seen++;
      });

      // The efficiency the gate exists for has to survive the fix.
      await setRules([]);
      await drive();
      assert.equal(seen, 0, `${label} pushed to nobody at all`);

      await setRules([{ trigger }]);
      await drive();
      assert.ok(
        seen > 0,
        `${label} was skipped with an enabled rule reading "${channel}". ` +
          "The engine never sees a first snapshot, so the rule cannot fire — " +
          "and the operator sees an enabled rule that has simply never run",
      );

      await setRules([]);
    });
  }
});

// ── The registrations themselves ─────────────────────────────────────────────
//
// A gate asking `inDemand` with nothing ever registering demand is the same bug
// wearing a different hat, and it fails silently in exactly the same way.

describe("demand is registered for everything automation reads", () => {
  beforeEach(async () => {
    await setRules([]);
  });

  it("every channel a trigger reads has a consumer registered", () => {
    const channels = [...new Set(Object.values(AUTOMATION_TRIGGERS).map((t) => t.channel))].sort();
    const unregistered = channels.filter((c) => channelDemandSourceCount(c) === 0);
    assert.deepEqual(
      unregistered,
      [],
      `No in-process demand registered for: ${unregistered.join(", ")}. ` +
        "A producer gating on that channel will go quiet on an unattended box and " +
        "every rule reading it stops firing, with no error anywhere.",
    );
  });

  it("every channel a condition reads has a consumer registered", () => {
    // The counterpart to the trigger check above, and the one that was missing.
    // Conditions are PULLED at fire time, so they never reach the bus and the
    // trigger loop cannot see them: a rule triggering on PCO and merely ASKING
    // about a ProVideoPlayer layer reads a snapshot at the idle cadence, with
    // nothing anywhere saying so.
    //
    // Derived from AUTOMATION_CONDITIONS, the same registry the engine
    // registers from, so a condition added tomorrow is covered the moment it is
    // written. It replaces a hand-maintained table in automation-engine.ts that
    // no test read at all — deleting five of its ten entries left 1725 tests
    // green.
    const channels = [
      ...new Set(
        Object.values(AUTOMATION_CONDITIONS)
          .map((c) => c.channel)
          .filter((c): c is string => c !== null),
      ),
    ].sort();
    assert.ok(channels.length > 0, "no condition names a channel — the registry moved");
    const unregistered = channels.filter((c) => channelDemandSourceCount(c) === 0);
    assert.deepEqual(
      unregistered,
      [],
      `No in-process demand registered for: ${unregistered.join(", ")}. ` +
        "A qualifier on that channel answers from whatever the idle cadence last " +
        "left behind, and the rule it gates is wrong with no error anywhere.",
    );
  });

  it("reaper:status has one, which no trigger channel would have given it", () => {
    // reaper:status carries no trigger — its automation surface is the
    // reaper.is-recording CONDITION, which is pulled rather than broadcast. An
    // exact count, so dropping the condition registration shows up here rather
    // than as a qualifier quietly answering from a five-second-old snapshot.
    assert.equal(channelDemandSourceCount("reaper:status"), 1);
  });
});

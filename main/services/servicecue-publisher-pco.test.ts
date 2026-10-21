// The publisher against the REAL Planning Center gate.
//
// servicecue-publisher.test.ts holds the schedule with a fixture behind it. What it
// cannot show is that the app's own source is wired to the gate the live poller
// shares: that a round which finds Planning Center's headroom tight really sends
// Planning Center no request, and that the reads it does make are the ones the
// in-building routes make. This runs pcoService's own cache and gate (fetch is the
// only stub, answering in-process), the real stage controller's read paths, and the
// real publisher with the app's source.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { captureConsole } from "./fixtures/capture-console.js";
import { FakeReceiver } from "./fixtures/publish-receiver.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-publish-pco-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { pcoService } = await import("./pco-service.js");
const { serviceCueConfigStore } = await import("./servicecue-config-store.js");
const { ServiceCuePublisher } = await import("./servicecue-publisher.js");
const { appSource } = await import("./servicecue-publisher-instance.js");
const { RATE_COUNT_HEADER, RATE_LIMIT_HEADER, RATE_PERIOD_HEADER } = await import("./pco-rate-limit.js");

type Mutable = { state: Record<string, unknown>; pcoAppId: string | null; pcoSecret: string | null };
const ctl = stageController as unknown as Mutable;

const DAY = 86_400_000;
const realFetch = globalThis.fetch;
let asked: string[] = [];
/** What the stub says PCO has used of its limit, in the three headers. */
let used = 5;
/** What the stub answers every Planning Center request with: 401 is credentials it refuses. */
let pcoStatus = 200;

function stubPco(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://api.planningcenteronline.com")) return realFetch(input as string, init);
    asked.push(url);
    if (pcoStatus !== 200) return new Response(JSON.stringify({ errors: [{ title: "Unauthorized" }] }), { status: pcoStatus, headers: { "Content-Type": "application/json" } });
    const u = new URL(url);
    const p = u.pathname.replace("/services/v2", "") || "/";
    const json = (data: unknown, included: unknown[] = []) => ({ data, included });
    let body: { data: unknown; included: unknown[] };
    if (p === "/") body = json({ id: "1", type: "Organization", attributes: { time_zone: "America/Chicago" } });
    else if (p === "/service_types") body = json([{ id: "100", type: "ServiceType", attributes: { name: "Weekend" } }]);
    else if (/\/plans$/.test(p)) {
      body =
        u.searchParams.get("filter") === "past"
          ? json([])
          : json(
              [1, 2].map((i) => ({
                id: `100${i}`,
                type: "Plan",
                attributes: { title: `Plan ${i}`, sort_date: new Date(Date.now() + i * 3 * DAY).toISOString(), dates: "soon" },
              })),
            );
    } else if (/\/item_note_categories$/.test(p)) body = json([{ id: "1", type: "ItemNoteCategory", attributes: { name: "Audio", sequence: 0 } }]);
    else if (/\/plan_times$/.test(p)) body = json([{ id: "t", type: "PlanTime", attributes: { time_type: "service", starts_at: new Date(Date.now() + DAY).toISOString() } }]);
    else if (/\/items$/.test(p)) body = json([{ id: "i1", type: "Item", attributes: { title: "Song", item_type: "song", length: 200, sequence: 1 } }]);
    else body = json([]);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        [RATE_LIMIT_HEADER]: "100",
        [RATE_PERIOD_HEADER]: "20",
        [RATE_COUNT_HEADER]: String(used),
      },
    });
  }) as typeof fetch;
}

let page: FakeReceiver;
let pub: InstanceType<typeof ServiceCuePublisher>;

before(async () => {
  page = await FakeReceiver.start();
});

beforeEach(async () => {
  pcoService.clearCache();
  pcoService.resetRateLimit();
  used = 5;
  pcoStatus = 200;
  asked = [];
  page.requests.length = 0;
  stubPco();
  ctl.pcoAppId = "app";
  ctl.pcoSecret = "secret";
  ctl.state = { ...ctl.state, pcoConfigured: true, serviceTypeId: "100", planId: "1001" };
  await serviceCueConfigStore.save({ serviceTypeIds: ["100"] });
  pub = new ServiceCuePublisher({
    source: appSource,
    loadSettings: async () => ({ enabled: true, url: page.origin }),
    loadToken: async () => "tok-pco-test-".padEnd(40, "0"),
    version: () => "t",
    timings: { cycleMs: 60_000, firstCycleMs: 60_000, heartbeatMs: 60_000, staggerMs: 0, frameMs: 20 },
    listen: () => {},
  });
});

after(async () => {
  pub?.stop();
  globalThis.fetch = realFetch;
  await page.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("the publisher and the Planning Center gate", () => {
  it("reads through the app's own cache, and sends what the routes answer", async () => {
    await pub.start();
    await pub.runCycle();
    await pub.trickle();
    assert.ok(asked.length > 0, "nothing was read from Planning Center");
    assert.deepEqual(
      page.putKeys().filter((k) => k.startsWith("rundown-") || k === "service-types" || k === "plans-upcoming"),
      ["plans-upcoming", "rundown-100", "rundown-100-1001", "rundown-100-1002", "service-types"],
    );
    // The same plan list the switcher is offered, read once and cached: a second cycle asks for nothing.
    const first = asked.length;
    await pub.runCycle();
    assert.equal(asked.length, first, "an unchanged install went back to Planning Center inside its own cache lifetime");
  });

  it("tells the page the zone the app's clocks run in, which is not the state's own null", async () => {
    // The wiring, not the rule: appSource.timeZone is what the page's clocks end up reading. The state
    // holds the operator's setting, null while the app follows the host, and the page needs a zone.
    const { appTimeZone, hostTimeZone, setAppTimeZone } = await import("./app-timezone.js");
    ctl.state = { ...ctl.state, timezone: null };
    try {
      setAppTimeZone(null);
      await pub.start();
      await pub.runCycle();
      const followed = JSON.parse(page.docs.get("state")!) as { timezone: unknown };
      assert.equal(followed.timezone, hostTimeZone(), "the page was told null while the app follows the host's clock");
      assert.equal(followed.timezone, appTimeZone());

      setAppTimeZone("Pacific/Auckland");
      await pub.runCycle();
      assert.equal((JSON.parse(page.docs.get("state")!) as { timezone: unknown }).timezone, "Pacific/Auckland");
    } finally {
      setAppTimeZone(null);
    }
  });

  it("sends Planning Center nothing at all while its headroom is tight, and picks up when it clears", async (t) => {
    const lines = captureConsole(t, "log", "warn", "error");
    // One answer that says 90 of 100 used is what tightens the gate: the live poller's own read does it.
    used = 90;
    await pcoService.listServiceTypes("app", "secret");
    assert.equal(pcoService.rateLimitTight(), true, "the stub did not tighten the gate");
    assert.equal(appSource.pcoTight(), true, "the publisher's source is not reading the gate the live poller uses");
    pcoService.clearCache();
    asked = [];

    await pub.start();
    await pub.runCycle();
    await pub.runCycle();
    await pub.trickle();
    assert.deepEqual(asked, [], `a tight gate was spent on: ${JSON.stringify(asked)}`);
    assert.ok(page.docs.has("state"), "the documents that need no Planning Center still go");
    assert.equal(lines.filter((l) => /^\[publish\].*headroom is tight/.test(l)).length, 1);

    // Headroom back: a response that says so is what clears it.
    used = 10;
    await pcoService.listServiceTypes("app", "secret"); // cache cleared above, so this asks, and the answer says 10 of 100
    assert.equal(pcoService.rateLimitTight(), false);
    asked = [];
    await pub.runCycle();
    assert.ok(asked.length > 0, "the refresh did not resume");
    assert.equal(lines.filter((l) => /^\[publish\].*headroom has recovered/.test(l)).length, 1);
  });

  it("says Planning Center can't be read, apart from the page, while its credentials are refused, and stops once they work", async (t) => {
    const lines = captureConsole(t, "log", "warn", "error");
    pcoStatus = 401;
    await pub.start();
    await pub.runCycle();
    await pub.trickle();
    const failing = pub.status();
    assert.equal(failing.state, "publishing", "the page is reached: Planning Center failing is not a page problem");
    assert.equal(failing.lastError, null);
    assert.deepEqual(failing.sourceProblem, { message: "PCO auth failed — check App ID/Secret in Integrations settings" });
    assert.equal(failing.counts.types, 0);
    assert.ok(page.docs.has("servicecue-layouts"), "the layouts still go out");

    pcoStatus = 200;
    pcoService.clearCache();
    pub.nudge();
    await pub.runCycle();
    await pub.trickle();
    assert.equal(pub.status().sourceProblem, null);
    assert.equal(lines.filter((l) => /^\[publish\] Planning Center can be read again$/.test(l)).length, 1);
  });
});

// The publisher, end to end against a real receiver: what a cycle sends, when Planning Center is read, the manifest,
// the images, what the page forgetting looks like, the heartbeat, and starting and stopping.
//
// The live channels are in servicecue-publisher-live.test.ts and everything that goes wrong in
// servicecue-publisher-failures.test.ts. Lists that must stay exact are literal, sorted, one entry to a line, so two
// branches adding a document touch different lines and a count cannot hide an add plus a remove.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FIXED_DOC_KEYS } from "../types/servicecue-publish.js";
import { FakeReceiver, waitFor } from "./fixtures/publish-receiver.js";
import { fixtureSource, fixtureState, PLANS } from "./fixtures/publish-source.js";
import { framesOf, harness, installPublisherHooks, lastPut, logs, MANUAL, publishAll, sleep, TOKEN } from "./fixtures/publisher-harness.js";
import { backoffMs, ServiceCuePublisher } from "./servicecue-publisher.js";

installPublisherHooks();

// What one full pass of the fixture install puts, and what the page ends up keeping.
const PUT = [
  "plans-upcoming",
  "rundown-100",
  "rundown-100-1001",
  "rundown-100-1002",
  "rundown-200",
  "rundown-200-2001",
  "service-types",
  "servicecue-config",
  "servicecue-layouts",
  "servicecue-roles",
];
const KEPT = [
  "pco-live",
  "plans-upcoming",
  "rundown-100",
  "rundown-100-1001",
  "rundown-100-1002",
  "rundown-200",
  "rundown-200-2001",
  "service-types",
  "servicecue-config",
  "servicecue-layouts",
  "servicecue-roles",
  "spl-current",
  "state",
];

describe("what a cycle sends", () => {
  it("is exactly these documents, never a type or plan off the landing page, and the manifest names what the page keeps", async () => {
    const h = await harness();
    await publishAll(h);
    // The three the page keeps from frames (the state, the live position, the SPL recording) are frames, not documents.
    assert.deepEqual(h.page.putKeys(), PUT);
    assert.deepEqual(h.page.manifests().at(-1), { docs: KEPT, assets: ["0123456789abcdef.png"] });
    assert.deepEqual([...h.page.docs.keys()].sort(), KEPT, "what the page holds is not what the manifest names");
    // Service type 300 and its plan are not on the landing page: not one byte of them.
    for (const r of h.page.requests) assert.equal(/\b300\b|3001|Hidden/.test(`${r.path}${r.body}`), false, `${r.method} ${r.path} carries the type that is not on the landing page`);
    assert.deepEqual(JSON.parse(lastPut(h, "plans-upcoming")!).plans.map((p: { planId: string }) => p.planId), ["1001", "1002", "2001"]);
    assert.equal(JSON.parse(lastPut(h, "plans-upcoming")!).cacheAgeMs, 0, "the cache age would change the document on every read");
    assert.deepEqual(JSON.parse(lastPut(h, "service-types")!).map((t: { id: string }) => t.id), ["100", "200"]);
  });

  it("names every fixed document of the contract in the manifest, so one added to it is not deleted for being forgotten here", async () => {
    const h = await harness();
    await publishAll(h);
    const kept = h.page.manifests().at(-1)!.docs;
    for (const key of FIXED_DOC_KEYS) assert.ok(kept.includes(key), `${key} is a fixed document and the manifest does not name it`);
  });

  it("sends the documents as the in-building routes answer them", async () => {
    const h = await harness();
    await publishAll(h);
    const body = (key: string) => JSON.parse(lastPut(h, key)!);
    assert.deepEqual(body("servicecue-layouts"), h.source.data.layouts);
    assert.deepEqual(body("servicecue-config"), { serviceTypeIds: ["100", "200"] });
    assert.equal(body("rundown-100").planId, "1001");
    assert.equal(body("rundown-100-1002").planId, "1002");
    assert.equal(body("rundown-100-1002").isDefaultPlan, false);
  });

  it("sends a document again only when its text changed, and the edited one alone", async () => {
    const h = await harness();
    await publishAll(h);
    const before = h.page.requests.length;
    await h.pub.runCycle();
    assert.deepEqual(h.page.requests.slice(before).map((r) => `${r.method} ${r.path}`), [], "an unchanged install sent something");

    h.source.data.layouts = [...h.source.data.layouts, { id: "svl3", name: "Lighting", order: 2, columnRoles: [] }];
    await h.pub.runCycle();
    assert.deepEqual(h.page.requests.slice(before).map((r) => `${r.method} ${r.path}`), ["PUT /_publish/v1/doc/servicecue-layouts"], "an edit to the layouts should send the layouts and nothing else");
  });

  it("sends a document once when the cycle and a broadcast want it at the same moment", async () => {
    // Both look and see the page does not have it yet. The look is taken when the request's turn comes, so the second finds the
    // first already sent; taken when it is queued, both go.
    const h = await harness();
    // A slow page, so the cycle is still working through its documents when the broadcast arrives.
    h.page.respond = (req) => (req.path.includes("/doc/") || req.path.endsWith("/frame") ? h.page.worker(req, { delayMs: 40 }) : h.page.worker(req));
    await h.pub.start();
    const cycle = h.pub.runCycle();
    await waitFor(() => h.page.putKeys().includes("servicecue-roles"), "the cycle to reach the frames", 5000);
    h.emit("stage:state-changed");
    await h.pub.flush();
    await cycle;
    for (const channel of ["pco:live", "spl:history", "stage:state-changed"]) assert.equal(framesOf(h, channel).length, 1, `${channel} was sent more than once`);
  });
});

describe("when Planning Center is read", () => {
  it("reads the current plans every cycle and the other plans once, until they are due", async () => {
    const h = await harness();
    h.source.data.plans = [...PLANS, ...["1003", "1004"].map((id) => ({ ...PLANS[1]!, planId: id }))];
    await publishAll(h);
    const calls = () => h.source.calls.rundown.map((c) => `${c.typeId}/${c.planId ?? "-"}`).sort();
    assert.deepEqual(calls(), ["100/-", "100/1002", "100/1003", "100/1004", "200/-"], "one read per type for the plan it opens on, one per other plan, none for a type off the landing page");
    await h.pub.runCycle();
    await h.pub.trickle();
    assert.deepEqual(calls(), ["100/-", "100/-", "100/1002", "100/1003", "100/1004", "200/-", "200/-"], "the second cycle read the current plans again and the others not at all");
  });

  it("reads the other plans one at a time, with a gap between", async () => {
    const h = await harness({ staggerMs: 40 });
    h.source.data.rundownMs = 10;
    h.source.data.plans = [PLANS[0]!, ...["1002", "1003", "1004", "1005", "1006"].map((id) => ({ ...PLANS[1]!, planId: id }))];
    await h.pub.start();
    await h.pub.runCycle();
    await h.pub.trickle();
    const reads = h.source.calls.rundown.filter((c) => c.planId !== null);
    assert.equal(reads.length, 5);
    assert.equal(h.source.calls.peakInFlight, 1, "two Planning Center reads were in flight at once");
    for (let i = 1; i < reads.length; i++) assert.ok(reads[i]!.at - reads[i - 1]!.at >= 40, `reads ${i - 1} and ${i} were ${(reads[i]!.at - reads[i - 1]!.at).toFixed(0)} ms apart, under the 40 ms gap`);
  });

  it("reads the plan list every cycle inside a service window, and between windows only when the hour is up or something was edited", async () => {
    const h = await harness({ dormantRefreshMs: 400 });
    await h.pub.start();
    await h.pub.runCycle();
    const reads = () => h.source.calls.upcoming;
    assert.equal(reads(), 1);
    await h.pub.runCycle();
    assert.equal(reads(), 2, "inside a window every cycle reads the list");

    h.source.data.dormant = true;
    await h.pub.runCycle();
    await h.pub.runCycle();
    assert.equal(reads(), 2, "between windows the list was read before the hour was up");
    h.pub.nudge();
    await h.pub.runCycle();
    assert.equal(reads(), 3, "an edit to the landing page did not bring the read forward");
    await sleep(450);
    await h.pub.runCycle();
    assert.equal(reads(), 4, "between windows the list was not read when the hour was up");
  });

  it("reads each of the other plans every quarter hour inside a window and every few hours between", async () => {
    for (const [dormant, soon, later] of [[false, "slowEveryMs", "dormantSlowEveryMs"], [true, "dormantSlowEveryMs", "slowEveryMs"]] as const) {
      const h = await harness({ [soon]: 120, [later]: 3_600_000 });
      h.source.data.dormant = dormant;
      await h.pub.start();
      await h.pub.runCycle();
      await h.pub.trickle();
      const reads = () => h.source.calls.rundown.filter((c) => c.planId === "1002").length;
      assert.equal(reads(), 1);
      await h.pub.trickle();
      assert.equal(reads(), 1, `dormant ${dormant}: read again before it was due`);
      await sleep(150);
      await h.pub.trickle();
      assert.equal(reads(), 2, `dormant ${dormant}: not read when it was due`);
    }
  });

  it("tries a plan whose read failed again later, not on the next cycle", async (t) => {
    const lines = logs(t);
    const h = await harness({ failRetryMs: 60_000 });
    h.source.data.failPlan = "1002";
    await h.pub.start();
    await h.pub.runCycle();
    await h.pub.trickle();
    assert.equal(h.page.putKeys().includes("rundown-100-1002"), false, "a plan that could not be read was sent anyway");
    assert.equal(lines.filter((l) => /could not read the rundown for plan 1002/.test(l)).length, 1);
    await h.pub.runCycle();
    await h.pub.trickle();
    assert.equal(h.source.calls.rundown.filter((c) => c.planId === "1002").length, 1, "a failing plan was read again straight away");
  });

  it("keeps the last copy when a read fails, and still names it in the manifest", async (t) => {
    logs(t);
    const h = await harness();
    await publishAll(h);
    const was = h.source.rundown;
    h.source.rundown = async (typeId, planId) => {
      if (planId === null && typeId === "200") throw new Error("Planning Center returned 502");
      return was(typeId, planId);
    };
    const before = h.page.puts().length;
    await h.pub.runCycle();
    assert.equal(h.page.puts().length, before);
    assert.ok(h.page.docs.has("rundown-200"), "the page deleted the rundown it was holding");
    assert.ok(h.page.manifests().at(-1)!.docs.includes("rundown-200"));
  });

  it("is not read at all while the gate's headroom is tight, and the hold is said once at each end", async (t) => {
    const lines = logs(t);
    const h = await harness();
    h.source.data.tight = true;
    await h.pub.start();
    for (let i = 0; i < 3; i++) await h.pub.runCycle();
    await h.pub.trickle();
    assert.deepEqual([h.source.calls.serviceTypes, h.source.calls.upcoming, h.source.calls.rundown.length], [0, 0, 0], "Planning Center was read through a tight gate");
    assert.ok(h.page.putKeys().includes("servicecue-config"), "the local documents still go");
    assert.equal(lines.filter((l) => /headroom is tight/.test(l)).length, 1, JSON.stringify(lines));
    h.source.data.tight = false;
    await h.pub.runCycle();
    assert.ok(h.source.calls.rundown.length > 0, "the refresh did not resume");
    assert.equal(lines.filter((l) => /headroom has recovered/.test(l)).length, 1);
  });

  it("stops in the middle of a round when the gate tightens, in the cycle and in the trickle", async () => {
    // The cycle: the first read is what tips it.
    const a = await harness();
    const was = a.source.rundown;
    a.source.rundown = async (typeId, planId) => {
      a.source.data.tight = true;
      return was(typeId, planId);
    };
    await a.pub.start();
    await a.pub.runCycle();
    assert.equal(a.source.calls.rundown.length, 1, "the second type was read through a gate that had just tightened");

    // The trickle: the second read tips it.
    const b = await harness();
    b.source.data.plans = [PLANS[0]!, ...["1002", "1003", "1004", "1005"].map((id) => ({ ...PLANS[1]!, planId: id }))];
    await b.pub.start();
    await b.pub.runCycle();
    b.source.calls.rundown.length = 0;
    const read = b.source.rundown;
    let reads = 0;
    b.source.rundown = async (typeId, planId) => {
      if (++reads === 2) b.source.data.tight = true;
      return read(typeId, planId);
    };
    await b.pub.trickle();
    assert.equal(reads, 2, "the round read on after the gate had tightened");
  });

  it("reads nothing, and publishes the rest, when Planning Center is not connected", async () => {
    const h = await harness();
    h.source.data.state = fixtureState({ pcoConfigured: false });
    await publishAll(h);
    assert.deepEqual([h.source.calls.serviceTypes, h.source.calls.upcoming, h.source.calls.rundown.length], [0, 0, 0]);
    assert.deepEqual(h.page.putKeys(), ["servicecue-config", "servicecue-layouts", "servicecue-roles"]);
    // Nothing to wait for, so the manifest goes at once, without the two documents that need Planning Center.
    assert.deepEqual(h.page.manifests().at(-1)!.docs, ["pco-live", "servicecue-config", "servicecue-layouts", "servicecue-roles", "spl-current", "state"]);
  });

  it("says the plan list is unavailable instead of sending the app's complaint, and keeps the last list", async (t) => {
    const lines = logs(t);
    const h = await harness();
    h.source.data.unavailable = "PCO API error 500: internal detail";
    await h.pub.start();
    await h.pub.runCycle();
    await h.pub.runCycle();
    assert.equal(h.page.putKeys().includes("plans-upcoming"), false);
    assert.equal(lines.filter((l) => /could not read the plan list: PCO API error 500: internal detail; the page keeps its last copy/.test(l)).length, 1, JSON.stringify(lines));
    for (const r of h.page.requests) assert.equal(r.body.includes("internal detail"), false);
  });

  it("says on the card why Planning Center can't be read, and says nothing once it is not connected at all", async () => {
    const h = await harness();
    h.source.data.unavailable = "PCO API error 500: internal detail";
    await h.pub.start();
    await h.pub.runCycle();
    assert.equal(h.pub.status().state, "publishing");
    assert.deepEqual(h.pub.status().sourceProblem, { message: "PCO API error 500: internal detail" });
    // Disconnected is a choice, not a failure: nothing is read, so nothing failed.
    h.source.data.state = fixtureState({ pcoConfigured: false });
    await h.pub.runCycle();
    assert.equal(h.pub.status().sourceProblem, null);
  });

  it("says Planning Center can be read again once nothing the page still wants is failing, though a plan that failed has left it", async (t) => {
    const lines = logs(t);
    const h = await harness();
    h.source.data.failPlan = "1002";
    await h.pub.start();
    await h.pub.runCycle();
    await h.pub.trickle();
    assert.deepEqual(h.pub.status().sourceProblem, { message: "Planning Center returned 503" });
    h.source.data.unavailable = "PCO API error 500";
    h.pub.nudge();
    await h.pub.runCycle();
    // The plan's type comes off the landing page while the plan list is failing, and then the list is read again.
    h.source.data.landing = ["200"];
    h.source.data.unavailable = null;
    h.pub.nudge();
    await h.pub.runCycle();
    assert.equal(h.pub.status().sourceProblem, null);
    assert.equal(lines.filter((l) => l === "[publish] Planning Center can be read again").length, 1, JSON.stringify(lines));
    // Back on the landing page, the plan is not shown failing before it has been read again.
    h.source.data.landing = ["100", "200"];
    h.source.data.failPlan = null;
    // Its read is held open, so what the status says is what was known before it.
    const read = h.source.rundown;
    h.source.rundown = (typeId, planId) => (planId === "1002" ? new Promise(() => {}) : read(typeId, planId));
    h.pub.nudge();
    await h.pub.runCycle();
    assert.equal(h.pub.status().sourceProblem, null);
  });

  it("brings an edit to the layouts or the landing page to the page before the next minute", async () => {
    // The cycle is a minute apart; the nudge an edit sends is what makes it a moment.
    const h = await harness({ firstCycleMs: 5, cycleMs: 60_000, nudgeMs: 20 });
    await h.pub.start();
    await waitFor(() => h.page.manifests().length === 1, "the first cycle", 3000);
    h.source.data.layouts = [...h.source.data.layouts, { id: "svl3", name: "Lighting", order: 2, columnRoles: [] }];
    h.pub.nudge();
    await waitFor(() => JSON.parse(lastPut(h, "servicecue-layouts")!).length === 3, "the edited layouts, long before the next cycle", 3000);
    h.source.data.landing = ["100"];
    h.pub.nudge();
    await waitFor(() => !h.page.docs.has("rundown-200"), "the type taken off the landing page to leave it", 3000);
  });
});

describe("the manifest", () => {
  it("drops what the page should no longer keep, and says what the page removed", async (t) => {
    const lines = logs(t);
    const h = await harness();
    await publishAll(h);
    h.source.data.landing = ["100"];
    await h.pub.runCycle();
    const docs = h.page.manifests().at(-1)!.docs;
    assert.equal(docs.some((k) => k.startsWith("rundown-200")), false, "a type taken off the landing page stayed in the manifest");
    // The count is the page's own answer, so it is evidence of what it deleted and not of what was asked.
    assert.ok(lines.some((l) => /the page removed 2 documents and 0 images that are no longer wanted/.test(l)), JSON.stringify(lines));
    assert.deepEqual([...h.page.docs.keys()].filter((k) => k.startsWith("rundown-200")), []);
    await h.pub.runCycle();
    assert.equal(lines.filter((l) => /the page removed/.test(l)).length, 1, "a manifest that removes nothing said so");
  });

  it("is sent when what it names changes, and not otherwise", async () => {
    const h = await harness();
    await publishAll(h);
    await h.pub.runCycle();
    await h.pub.runCycle();
    assert.equal(h.page.manifests().length, 1, "an unchanged manifest was sent again");
    h.source.data.landing = ["100"];
    await h.pub.runCycle();
    assert.equal(h.page.manifests().length, 2);
    h.source.data.landing = ["100", "200"];
    const before = h.page.puts().length;
    await h.pub.runCycle();
    assert.equal(h.page.manifests().length, 3);
    assert.ok(h.page.puts().slice(before).some((p) => p.key === "rundown-200"), "the page deleted it and was never told it was wanted again");
  });

  it("names only plans of types still on the landing page, though the page was given more", async () => {
    // Plans are kept for a type whose read failed; a type taken off the landing page is not one of those.
    const h = await harness();
    await publishAll(h);
    h.source.data.landing = ["200"];
    h.source.data.incomplete = ["100"];
    await h.pub.runCycle();
    const docs = h.page.manifests().at(-1)!.docs;
    assert.deepEqual(docs.filter((k) => k.startsWith("rundown-")), ["rundown-200", "rundown-200-2001"]);
  });

  it("is not sent until the plan list and the landing page have been read, so a restart in an outage cannot take the plans off the page", async (t) => {
    logs(t);
    // The page holds a plan from before this server restarted, and Planning Center cannot be reached.
    const h = await harness();
    h.page.docs.set("rundown-100-1002", '{"held":"from before the restart"}');
    h.source.data.tight = true;
    await h.pub.start();
    await h.pub.runCycle();
    await h.pub.runCycle();
    assert.equal(h.page.manifests().length, 0, "a manifest was sent from a plan list that was never read");
    assert.ok(h.page.docs.has("rundown-100-1002"), "the page lost a plan to a restart during an outage");
    h.source.data.tight = false;
    await h.pub.runCycle();
    assert.ok(h.page.manifests()[0]!.docs.includes("rundown-100-1002"));

    // Nor from a plan list the app itself could not refresh, nor without the landing page settings.
    const a = await harness();
    a.page.docs.set("rundown-200-2001", "{}");
    a.source.data.unavailable = "PCO API error 500";
    await a.pub.start();
    await a.pub.runCycle();
    assert.equal(a.page.manifests().length, 0);
    const b = await harness();
    b.page.docs.set("rundown-200", "{}");
    b.source.config = async () => {
      throw new Error("EIO");
    };
    await b.pub.start();
    await b.pub.runCycle();
    assert.equal(b.page.manifests().length, 0);
    assert.ok(b.page.docs.has("rundown-200"));
  });

  it("keeps the plans of a type the plan list could not read in full, and drops one that stays missing from three complete lists or whose date has passed", async () => {
    const h = await harness();
    await publishAll(h);
    const without = (typeId: string) => PLANS.filter((p) => p.serviceTypeId !== typeId);
    const rundowns = () => h.page.manifests().at(-1)!.docs.filter((k) => k.startsWith("rundown-200"));
    // Type 200's read fails: its plan is missing from the list, and the list says why.
    h.source.data.plans = without("200");
    h.source.data.incomplete = ["200"];
    for (let i = 0; i < 4; i++) await h.pub.runCycle();
    assert.deepEqual(rundowns(), ["rundown-200", "rundown-200-2001"], "a plan was dropped for a type that could not be read");
    // Complete lists without it: kept for two, gone at the third.
    h.source.data.incomplete = [];
    await h.pub.runCycle();
    await h.pub.runCycle();
    assert.deepEqual(rundowns(), ["rundown-200", "rundown-200-2001"], "a plan was dropped before three complete lists");
    await h.pub.runCycle();
    assert.deepEqual(rundowns(), ["rundown-200"], "a plan stayed after three complete lists without it");
    assert.equal(h.page.docs.has("rundown-200-2001"), false, "the page still holds a plan that was dropped");
  });

  it("is not sent after a restart while a type's plan list is only partly read, since this run cannot name the plans the page holds for it", async (t) => {
    const lines = logs(t);
    const h = await harness();
    h.page.docs.set("rundown-200-2001", '{"held":"from before the restart"}');
    h.source.data.plans = PLANS.filter((p) => p.serviceTypeId !== "200");
    h.source.data.incomplete = ["200"];
    await h.pub.start();
    for (let i = 0; i < 3; i++) await h.pub.runCycle();
    assert.equal(h.page.manifests().length, 0, "a manifest naming no plan of type 200 was sent");
    assert.ok(h.page.docs.has("rundown-200-2001"), "the page lost a plan to a restart during a partial outage");
    assert.equal(lines.filter((l) => /could not be read in full for service type 200/.test(l)).length, 1, JSON.stringify(lines));
    // Once the type is read in full, the plan is known and kept.
    h.source.data.plans = PLANS;
    h.source.data.incomplete = [];
    await h.pub.runCycle();
    assert.ok(h.page.manifests()[0]!.docs.includes("rundown-200-2001"));
  });

  it("names the logo whether or not its file could be read this run, so the page keeps the one it has", async () => {
    const h = await harness();
    h.page.assetNames.add("0123456789abcdef.png");
    await publishAll(h);
    assert.deepEqual(h.page.manifests().at(-1)!.assets, ["0123456789abcdef.png"]);
    assert.deepEqual([...h.page.assetNames], ["0123456789abcdef.png"], "the page lost its logo because this server could not read the file");
  });

  it("says once, until one is taken, that the page refused it", async (t) => {
    const lines = logs(t);
    const h = await harness();
    h.page.respond = (req) => (req.path.endsWith("/manifest") ? { status: 400 } : h.page.worker(req));
    await h.pub.start();
    for (let i = 0; i < 3; i++) await h.pub.runCycle();
    assert.equal(h.page.manifests().length, 3, "a manifest the page has not taken is asked again");
    assert.equal(lines.filter((l) => /refused the list of what to keep/.test(l)).length, 1, `said every time: ${JSON.stringify(lines)}`);
    assert.equal(h.pub.status().state, "publishing", "a manifest the page refuses is not the page being down");
  });
});

describe("the images", () => {
  const PNG = { data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), mime: "image/png" };

  it("sends the logo the state points at, once, under the name the page will ask for, and no other image", async () => {
    const h = await harness();
    h.source.data.images.set("0123456789abcdef.png", PNG);
    h.source.data.images.set("canary-icon.png", { data: new Uint8Array([2]), mime: "image/png" });
    const asked: string[] = [];
    const was = h.source.brandingImage;
    h.source.brandingImage = async (name) => (asked.push(name), was(name));
    await publishAll(h);
    await h.pub.runCycle();
    assert.deepEqual(h.page.assets().map((a) => `${a.name} ${a.mime} ${a.bytes.length}`), ["0123456789abcdef.png image/png 7"]);
    assert.deepEqual([...h.page.assets()[0]!.bytes], [...PNG.data]);
    assert.deepEqual(asked, ["0123456789abcdef.png"], "an image that is not the logo, the custom tab icon, was read from disk");
    assert.equal(JSON.parse(h.page.docs.get("state")!).appLogo, "/branding-images/0123456789abcdef.png");
  });

  it("sends the logo once when a cycle and a state frame both find the page without it", async () => {
    const h = await harness();
    h.source.data.images.set("0123456789abcdef.png", PNG);
    const was = h.source.brandingImage;
    h.source.brandingImage = async (name) => {
      await sleep(40);
      return was(name);
    };
    await h.pub.start();
    h.emit("stage:state-changed");
    await Promise.all([h.pub.runCycle(), h.pub.flush()]);
    assert.equal(h.page.assets().length, 1, "both looked, both saw the page without the logo, and both sent it");
  });

  it("has nothing to send for a logo that is not a stored file", async () => {
    const h = await harness();
    h.source.data.state = fixtureState({ appLogo: "data:image/png;base64,AAAA" });
    await publishAll(h);
    assert.equal(h.page.assets().length, 0);
    assert.deepEqual(h.page.manifests().at(-1)!.assets, []);
  });

  it("sends a new logo before the state that names it, and has the page drop the old one", async (t) => {
    // An image does not ask again after a 404: a viewer told the new logo's name before the page holds the file would see no logo until it reloaded.
    const lines = logs(t);
    const h = await harness();
    h.source.data.images.set("0123456789abcdef.png", PNG);
    h.source.data.images.set("fedcba9876543210.webp", { data: new Uint8Array([2]), mime: "image/webp" });
    await publishAll(h);
    const before = h.page.requests.length;
    h.source.data.state = fixtureState({ appLogo: "/branding-images/fedcba9876543210.webp" });
    h.emit("stage:state-changed");
    await h.pub.flush();
    const sent = h.page.requests.slice(before).map((r) => `${r.method} ${r.path}`);
    assert.deepEqual(sent, ["PUT /_publish/v1/asset/fedcba9876543210.webp", "POST /_publish/v1/frame"], "the state naming the logo went before its file, or the file did not go");
    await h.pub.runCycle();
    assert.deepEqual([...h.page.assetNames], ["fedcba9876543210.webp"]);
    assert.ok(lines.some((l) => /the page removed 0 documents and 1 image that are no longer wanted/.test(l)), JSON.stringify(lines));
  });

  it("does not offer again an image the page refused, or of a type it does not serve, until the logo is another file", async (t) => {
    const lines = logs(t);
    const refused = await harness();
    refused.source.data.images.set("0123456789abcdef.png", PNG);
    refused.page.respond = (req) => (req.path.includes("/asset/") ? { status: 415 } : refused.page.worker(req));
    await publishAll(refused);
    await refused.pub.runCycle();
    await refused.pub.runCycle();
    assert.equal(refused.page.assets().length, 1, "a refused image was offered again");
    assert.equal(lines.filter((l) => /not sent: the logo 0123456789abcdef\.png\b.*refused it \(415\)/.test(l)).length, 1, JSON.stringify(lines));
    assert.equal(refused.pub.status().state, "publishing", "one image the page would not take is not the page being down");

    const bmp = await harness();
    bmp.source.data.images.set("0123456789abcdef.png", { data: new Uint8Array([1]), mime: "image/bmp" });
    await publishAll(bmp);
    await bmp.pub.runCycle();
    assert.equal(bmp.page.assets().length, 0);
    assert.equal(lines.filter((l) => /the logo 0123456789abcdef\.png is image\/bmp, a type the page does not take/.test(l)).length, 1, JSON.stringify(lines));
  });

  it("says once that a logo could not be read, and keeps going", async (t) => {
    const lines = logs(t);
    const h = await harness();
    h.source.brandingImage = async () => {
      throw new Error("EIO: i/o error");
    };
    await publishAll(h);
    await h.pub.runCycle();
    assert.equal(lines.filter((l) => /could not read the logo 0123456789abcdef\.png: EIO/.test(l)).length, 1, JSON.stringify(lines));
    assert.ok(h.page.putKeys().includes("servicecue-config"));
  });
});

describe("the page forgetting what it was sent", () => {
  it("is found out by asking what it holds, and what it lost is sent again, the state, live position and recording by frame", async (t) => {
    const lines = logs(t);
    const h = await harness({ reconcileMs: 0 });
    h.source.data.images.set("0123456789abcdef.png", { data: new Uint8Array([1, 2, 3]), mime: "image/png" });
    await publishAll(h);
    const frames = h.page.frames().length;
    // The page loses its whole store: a redeploy that changed its storage, a manifest sent by hand.
    h.page.docs.clear();
    h.page.assetNames.clear();
    await h.pub.runCycle();
    await h.pub.trickle();
    assert.deepEqual([...h.page.docs.keys()].sort(), KEPT, "the page was left empty");
    assert.deepEqual([...h.page.assetNames], ["0123456789abcdef.png"], "a logo the page lost was not sent again");
    assert.equal(h.page.frames().length, frames + 3, "the three frames were not repeated with their documents");
    assert.ok(lines.some((l) => /the page no longer holds 13 documents and 1 image sent to it; sending again/.test(l)), JSON.stringify(lines));
  });

  it("leaves alone what the page still holds, and asks only now and then", async (t) => {
    const lines = logs(t);
    const h = await harness({ reconcileMs: 400 });
    await publishAll(h);
    const before = h.page.requests.length;
    await h.pub.runCycle();
    await h.pub.runCycle();
    assert.equal(h.page.statusRequests(), 1, "the page was asked what it holds on every cycle");
    assert.equal(h.page.requests.length, before, "documents the page holds were sent again");
    await sleep(450);
    await h.pub.runCycle();
    assert.equal(h.page.statusRequests(), 2);
    assert.equal(h.page.requests.length, before + 1, "asking was more than asking");
    assert.equal(lines.some((l) => /no longer holds/.test(l)), false);
  });

  it("is a failure like any other when the page cannot answer the question, and nothing is sent that round", async (t) => {
    logs(t);
    const h = await harness({ reconcileMs: 0 });
    await publishAll(h);
    h.page.respond = (req) => (req.method === "GET" ? { status: 502 } : h.page.worker(req));
    h.source.data.layouts = [...h.source.data.layouts, { id: "svl5", name: "Not sent", order: 5, columnRoles: [] }];
    await h.pub.runCycle();
    assert.equal(h.pub.status().state, "problem");
    assert.equal(h.page.puts().filter((p) => p.key === "servicecue-layouts").length, 1, "a cycle went on to send to a page that had just not answered");
  });

  it("sends a manifest when the page turns out to hold what is not wanted, though what it names did not change", async () => {
    const h = await harness({ reconcileMs: 0 });
    await publishAll(h);
    assert.equal(h.page.manifests().length, 1);
    h.page.docs.set("rundown-999-9", '{"somebody put this"}');
    await h.pub.runCycle();
    assert.equal(h.page.manifests().length, 2);
    assert.equal(h.page.docs.has("rundown-999-9"), false);
  });
});

describe("the heartbeat", () => {
  it("is the first thing sent after the page is known, before any document, and carries the app's version", async () => {
    const h = await harness();
    await h.pub.start();
    await h.pub.runCycle();
    const paths = h.page.requests.map((r) => `${r.method} ${r.path}`);
    assert.deepEqual(paths.slice(0, 2), ["GET /_publish/v1/status", "POST /_publish/v1/heartbeat"]);
    assert.equal(h.page.heartbeats().length, 1, "more than the one heartbeat of first contact, with the interval a minute away");
    assert.equal(h.page.heartbeats()[0]!.version, "9.9.9");
    assert.ok(Math.abs(h.page.heartbeats()[0]!.at - Date.now()) < 5000);
  });

  it("keeps beating every interval when nothing has changed, and not while the page is being waited on", async (t) => {
    logs(t);
    const h = await harness({ heartbeatMs: 25 });
    await publishAll(h);
    await sleep(40); // let the first contact's frames settle
    const quiet = h.page.requests.length;
    const beats = h.page.heartbeats().length;
    await waitFor(() => h.page.heartbeats().length >= beats + 3, "three more heartbeats with nothing to send", 3000);
    assert.ok(h.page.requests.slice(quiet).every((r) => r.path === "/_publish/v1/heartbeat"), `something other than a heartbeat went while nothing had changed: ${h.page.requests.slice(quiet).map((r) => r.path).join(", ")}`);

    // A page that is failing is not asked every interval: the beat waits out the backoff with everything else.
    const waiting = await harness({ firstCycleMs: 5, heartbeatMs: 10, backoffMinMs: 400, backoffMaxMs: 400 });
    waiting.page.respond = () => ({ status: 502 });
    await waiting.pub.start();
    await waitFor(() => waiting.pub.status().state === "problem", "the failure", 3000);
    const made = waiting.page.requests.length;
    await sleep(250); // twenty-five beats' worth, inside one backoff
    assert.equal(waiting.page.requests.length, made, "the heartbeat timer asked a page that is being waited on");
  });
});

describe("starting and stopping", () => {
  it("stops cleanly: a request in flight is cut and nothing more is sent", async () => {
    const h = await harness({ firstCycleMs: 5, heartbeatMs: 20 });
    h.page.respond = (req) => (req.method === "GET" ? "hang" : { status: 204 });
    await h.pub.start();
    await waitFor(() => h.page.requests.length === 1, "the first request", 3000);
    const started = performance.now();
    h.pub.stop();
    assert.ok(performance.now() - started < 100, "stop() waited on the network");
    // The request the page was sitting on is cut, not left to run out its ten seconds.
    await waitFor(() => h.page.dropped === 1, "the request in flight to be cut", 2000);
    const made = h.page.requests.length;
    await sleep(150);
    assert.equal(h.page.requests.length, made, "something was sent after stop()");
  });

  it("makes no request for a run that was replaced, not even one that would be cut short at once", async () => {
    const h = await harness({ firstCycleMs: 5 });
    h.page.respond = (req) => (req.method === "GET" ? "hang" : { status: 204 });
    await h.pub.start();
    await waitFor(() => h.page.requests.length === 1, "the status request the page sits on", 3000);
    // A frame waiting its turn behind the request that hangs.
    h.emit("stage:state-changed");
    const queued = h.pub.flush();
    await sleep(20);
    assert.equal(h.page.requests.length, 1, "the frame went out ahead of the request it was queued behind");
    const real = globalThis.fetch;
    let handedToTheNetwork = 0;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      handedToTheNetwork++;
      return real(...args);
    }) as typeof fetch;
    try {
      h.pub.stop();
      await queued;
      await sleep(50);
    } finally {
      globalThis.fetch = real;
    }
    assert.equal(handedToTheNetwork, 0, "a request queued for a stopped run was still made");
  });

  it("never throws or waits at start, even when its settings cannot be read, and says so on the card", async (t) => {
    const lines = logs(t);
    const page = await FakeReceiver.start();
    try {
      const pub = new ServiceCuePublisher({
        source: fixtureSource(),
        loadSettings: async () => {
          throw new Error("EACCES: permission denied");
        },
        loadToken: async () => TOKEN,
        version: () => "9.9.9",
        timings: MANUAL,
        listen: () => {},
      });
      await pub.start();
      assert.equal(pub.status().state, "off");
      assert.equal(page.requests.length, 0);
      assert.ok(lines.some((l) => /could not read the publishing settings/.test(l)));
    } finally {
      await page.close();
    }
  });
});

describe("the waits", () => {
  it("double from the first, up to the ceiling, by the number of failures in a row", () => {
    const waits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => backoffMs(n, 5_000, 300_000));
    assert.deepEqual(waits, [5_000, 5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
  });
});

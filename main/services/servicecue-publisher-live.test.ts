// What the publisher says on the three live channels: the public part of the state, the live position, and the SPL
// recording. The live position of a plan that is not the page's to show is the thing this file is for. The app broadcasts the
// live position of whatever plan the machine follows, around the clock: on a weekday that can be a funeral, and its item
// titles and times are in the broadcast. Each channel here is sent only for a plan of a type on the landing page that the page
// is offered, and only the fields the public pages read; everything else is null or absent, shown against a fixture with a
// canary in every field that must not leave.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { broadcast } from "./broadcaster.js";
import { FRAME_CHANNELS, FRAME_DOCS } from "../types/servicecue-publish.js";
import type { PcoLiveDTO } from "../types/live.js";
import { waitFor } from "./fixtures/publish-receiver.js";
import { fixtureState, HIDDEN, LIVE, SPL } from "./fixtures/publish-source.js";
import { framesOf, harness, installPublisherHooks, logs, publishAll, sleep } from "./fixtures/publisher-harness.js";
import { PUBLIC_LIVE_FIELDS } from "./servicecue-publish-docs.js";

installPublisherHooks();

const canaries = (h: Awaited<ReturnType<typeof harness>>) => h.page.requests.filter((r) => /canary/i.test(`${r.path}${r.body}`)).map((r) => `${r.method} ${r.path}`);

describe("the state", () => {
  const ALLOWED = ["accentColor", "appLogo", "appLogoMonochrome", "hourCycle", "pcoConfigured", "timezone"];

  it("is exactly these fields, in the frame and in what the page holds, whatever else the state carries", async () => {
    const h = await harness();
    await publishAll(h);
    assert.deepEqual(Object.keys(framesOf(h, "stage:state-changed")[0]!.data as object).sort(), ALLOWED);
    assert.deepEqual(Object.keys(JSON.parse(h.page.docs.get("state")!)).sort(), ALLOWED);
    h.source.data.state = fixtureState({ accentColor: "#112233", lanUrl: "http://canary-lan.invalid:8788" });
    h.emit("stage:state-changed");
    await h.pub.flush();
    assert.equal(JSON.parse(h.page.docs.get("state")!).accentColor, "#112233");
    assert.deepEqual(canaries(h), [], "a field that is not the page's to see was sent");
  });

  it("is sent when the page's part of it changes, once when the cycle and a broadcast reach it together, and not for a field the page never sees", async () => {
    const h = await harness();
    await publishAll(h);
    assert.equal(framesOf(h, "stage:state-changed").length, 1);
    h.source.data.state = fixtureState({ lanUrl: "http://canary-lan.invalid:9999", views: [] });
    h.emit("stage:state-changed");
    await h.pub.flush();
    assert.equal(framesOf(h, "stage:state-changed").length, 1, "a change to a field the page never sees was sent to it");
    h.source.data.state = fixtureState({ hourCycle: "24h" });
    h.emit("stage:state-changed");
    await h.pub.runCycle();
    await h.pub.flush();
    assert.equal(framesOf(h, "stage:state-changed").length, 2, "the cycle and the broadcast sent the same state twice");
    assert.equal(JSON.parse(h.page.docs.get("state")!).hourCycle, "24h");
  });

  it("carries the zone the app's clocks run in as `timezone`, never the state's null, and follows a change of it alone", async () => {
    // The state holds the OPERATOR'S zone, which is null while the app follows the host's clock. A page that read null would draw every
    // clock in the visitor's zone, the bar that says the church has not been heard from included.
    const cases: [Record<string, unknown>, string][] = [
      [{ timezone: null }, "Pacific/Auckland"],
      [{ timezone: "Canary/Host" }, "America/Denver"],
    ];
    for (const [over, effective] of cases) {
      const h = await harness();
      h.source.data.state = fixtureState(over);
      h.source.data.timeZone = effective;
      await publishAll(h);
      assert.equal(JSON.parse(h.page.docs.get("state")!).timezone, effective, JSON.stringify(over));
      h.source.data.timeZone = "America/Los_Angeles";
      await h.pub.runCycle();
      assert.equal(JSON.parse(h.page.docs.get("state")!).timezone, "America/Los_Angeles");
      assert.equal(framesOf(h, "stage:state-changed").length, 2);
      for (const r of h.page.requests) assert.equal(r.body.includes("Canary/Host"), false);
    }
  });
});

describe("the live position", () => {
  it("is the fields the public pages read and no others, as a frame, and the same as what the page holds", async () => {
    const h = await harness();
    await publishAll(h);
    const frame = framesOf(h, "pco:live").at(-1)!.data as Record<string, unknown>;
    assert.deepEqual(Object.keys(frame).sort(), [...PUBLIC_LIVE_FIELDS]);
    assert.equal(frame.currentItemId, LIVE.currentItemId);
    assert.deepEqual(JSON.parse(h.page.docs.get("pco-live")!), frame);
    assert.deepEqual(canaries(h), [], "a field of the live position the public pages do not read was sent");
  });

  it("is sent only for a plan of a type on the landing page that the page is offered", async () => {
    const cases: [string, string | null, string | null, boolean][] = [
      ["a plan the page offers", "100", "1001", true],
      ["another plan the page offers", "200", "2001", true],
      ["a plan of a type that is not on the landing page, a funeral on a weekday", HIDDEN.typeId, HIDDEN.planId, false],
      ["a plan of a landing page type the page is not offered", "100", "9999", false],
      ["no plan at all", null, null, false],
    ];
    for (const [what, typeId, planId, published] of cases) {
      const h = await harness();
      h.source.data.state = fixtureState({ serviceTypeId: typeId, planId });
      h.source.data.live = published ? LIVE : { ...LIVE, label: "Canary Funeral" };
      await publishAll(h);
      assert.equal(framesOf(h, "pco:live").length, 1, what);
      const doc = JSON.parse(h.page.docs.get("pco-live")!);
      assert.equal(doc === null ? "nothing" : "the position", published ? "the position" : "nothing", `${what}: ${JSON.stringify(doc)}`);
      assert.equal(framesOf(h, "pco:live")[0]!.data === null, !published, what);
      assert.deepEqual(canaries(h), [], `${what}: something of it left`);
    }
  });

  it("follows the plan the machine follows: nothing the moment it moves to a plan that is not the page's, and the position again when it comes back", async () => {
    const h = await harness();
    await publishAll(h);
    assert.notEqual(framesOf(h, "pco:live").at(-1)!.data, null);
    h.source.data.state = fixtureState({ serviceTypeId: HIDDEN.typeId, planId: HIDDEN.planId });
    h.source.data.live = { ...LIVE, label: "Canary Funeral" };
    h.emit("stage:state-changed");
    await h.pub.flush();
    assert.equal(framesOf(h, "pco:live").at(-1)!.data, null, "the live position of a plan that is not the page's stayed up");
    assert.equal(h.page.docs.get("pco-live"), "null");
    h.source.data.state = fixtureState();
    h.source.data.live = LIVE;
    h.emit("stage:state-changed");
    await h.pub.flush();
    assert.equal((framesOf(h, "pco:live").at(-1)!.data as { label: string }).label, "Welcome");
    assert.deepEqual(canaries(h), []);
  });

  it("is null while there is nothing live, and a frame says so rather than leaving the page on the last position", async () => {
    const h = await harness();
    await publishAll(h);
    h.source.data.live = null;
    h.emit("pco:live");
    await h.pub.flush();
    assert.equal(framesOf(h, "pco:live").at(-1)!.data, null);
    assert.equal(h.page.docs.get("pco-live"), "null");
  });

  it("is not sent again for a push that moved only the clock, and is for any change the page reads", async () => {
    const h = await harness();
    await publishAll(h);
    const frames = () => framesOf(h, "pco:live").length;
    const changes: [Partial<PcoLiveDTO>, boolean][] = [
      [{ serverNow: "2099-11-01T15:09:00.000Z" }, false],
      [{ currentItemTitle: "Canary Other Title", itemSchedule: [] }, false],
      [{ currentItemId: "item-2" }, true],
      [{ mode: "preservice" }, true],
    ];
    for (const [over, sent] of changes) {
      const before = frames();
      h.source.data.live = { ...LIVE, ...over };
      h.emit("pco:live");
      await h.pub.flush();
      assert.equal(frames(), before + (sent ? 1 : 0), JSON.stringify(over));
    }
  });

  it("waits until it is known what is public: no live frame before the plan list has been read, though the state does not wait", async () => {
    const h = await harness();
    h.source.data.tight = true; // Planning Center is not read, so the plans on offer are not known
    await h.pub.start();
    await h.pub.runCycle();
    h.emit("pco:live");
    await h.pub.flush();
    assert.deepEqual([framesOf(h, "stage:state-changed").length, framesOf(h, "pco:live").length, framesOf(h, "spl:history").length], [1, 0, 0]);
    h.source.data.tight = false;
    await h.pub.runCycle();
    assert.deepEqual([framesOf(h, "pco:live").length, framesOf(h, "spl:history").length], [1, 1]);
  });
});

describe("the SPL recording", () => {
  it("is each item's id and peak and no other field, as a frame and as what the page holds", async () => {
    const h = await harness();
    await publishAll(h);
    assert.deepEqual(framesOf(h, "spl:history")[0]!.data, { items: [{ itemId: "item-1", maxSpl: 97 }] });
    assert.deepEqual(JSON.parse(h.page.docs.get("spl-current")!), { items: [{ itemId: "item-1", maxSpl: 97 }] });
    assert.deepEqual(canaries(h), []);
  });

  it("is sent only for the current recording of a plan on the landing page that the page is offered", async () => {
    const cases: [string, string | null, string | null, boolean][] = [
      ["a plan the page offers", "100", "1001", true],
      ["another plan the page offers", "100", "1002", true],
      ["a plan of a type that is not on the landing page", HIDDEN.typeId, HIDDEN.planId, false],
      ["a plan of a landing page type the page is not offered", "100", "9999", false],
      ["a recording of no plan", null, null, false],
    ];
    for (const [what, serviceTypeId, planId, published] of cases) {
      const h = await harness();
      h.source.data.spl = { ...SPL, serviceTypeId, planId };
      await publishAll(h);
      assert.equal(framesOf(h, "spl:history")[0]!.data === null, !published, what);
      assert.equal(JSON.parse(h.page.docs.get("spl-current")!) === null, !published, what);
      assert.deepEqual(canaries(h), [], `${what}: something of it left`);
    }
  });

  it("is not made to say anything by a history edit that rebroadcasts a record of the past", async () => {
    // history-edit.ts broadcasts the record it has just rewritten on this same channel. What goes out is the app's current recording,
    // read when the frame is made, so another record's broadcast is a prompt to look again and not a thing to forward.
    const h = await harness();
    await publishAll(h);
    const frames = framesOf(h, "spl:history").length;
    h.emit("spl:history", { ...SPL, serviceKey: "100:1000:canary-past", planTitle: "Canary Past Service", items: [{ ...SPL.items[0]!, itemId: "canary-past-item", maxSpl: 130 }] });
    await h.pub.flush();
    assert.equal(framesOf(h, "spl:history").length, frames, "a record of the past was forwarded as the live one");
    assert.deepEqual(canaries(h), []);
  });

  it("is null when nothing is recording", async () => {
    const h = await harness();
    h.source.data.spl = null;
    await publishAll(h);
    assert.equal(framesOf(h, "spl:history")[0]!.data, null);
    assert.equal(h.page.docs.get("spl-current"), "null");
  });
});

describe("a frame is the document", () => {
  it("is the one thing sent for each of the three, and the page holds what it carried, under the document the contract names", async () => {
    // The page stores a frame's data as the document it belongs to (FRAME_DOCS), so sending the document too is the same text a second time.
    const h = await harness();
    await publishAll(h);
    for (const channel of FRAME_CHANNELS) {
      const doc = FRAME_DOCS.get(channel)!;
      assert.equal(h.page.puts().some((p) => p.key === doc), false, `${doc} was PUT as well as sent as a ${channel} frame`);
      const before = framesOf(h, channel).length;
      h.source.data.state = channel === "stage:state-changed" ? fixtureState({ hourCycle: "24h" }) : h.source.data.state;
      h.source.data.live = channel === "pco:live" ? { ...LIVE, currentItemId: "item-9" } : h.source.data.live;
      h.source.data.spl = channel === "spl:history" ? { ...SPL, items: [{ ...SPL.items[0]!, maxSpl: 101 }] } : h.source.data.spl;
      h.emit(channel);
      await h.pub.flush();
      assert.equal(framesOf(h, channel).length, before + 1, `${channel} is in the contract and was not forwarded`);
      assert.deepEqual(JSON.parse(h.page.docs.get(doc)!), framesOf(h, channel).at(-1)!.data, `${doc} is not what the ${channel} frame carried`);
    }
    assert.deepEqual([...FRAME_DOCS.keys()].sort(), [...FRAME_CHANNELS], "the contract's frame list and its document map disagree");
  });

  it("forwards no channel but the three, and nothing from a broadcaster it did not hear", async () => {
    const h = await harness();
    await publishAll(h);
    const before = h.page.requests.length;
    for (const channel of ["spl:metrics", "propresenter:status", "wireless:channels", "slots:devices", "obs:status", "publish:heartbeat"]) h.emit(channel, { x: 1 });
    await h.pub.flush();
    assert.equal(h.page.requests.length, before);
  });

  it("hears the app's own broadcaster", async () => {
    const h = await harness({}, { real: true });
    await publishAll(h);
    const before = h.page.frames().length;
    h.source.data.live = { ...LIVE, currentItemId: "from-the-real-broadcaster" };
    broadcast("pco:live", h.source.data.live);
    broadcast("spl:metrics", { not: "forwarded" });
    await waitFor(() => h.page.frames().length > before, "the forwarded frame");
    await sleep(100);
    assert.equal((framesOf(h, "pco:live").at(-1)!.data as { currentItemId: string }).currentItemId, "from-the-real-broadcaster");
    assert.equal(h.page.frames().length, before + 1, "a channel that is not forwarded was");
  });

  it("sends the first at once and folds a burst into one more, carrying the last", async () => {
    const h = await harness({ frameMs: 150 });
    await publishAll(h);
    const base = framesOf(h, "pco:live").length;
    const item = (i: number) => {
      h.source.data.live = { ...LIVE, currentItemId: `burst-${i}` };
      h.emit("pco:live");
    };
    const sent = () => framesOf(h, "pco:live").slice(base).map((f) => (f.data as { currentItemId: string }).currentItemId);
    await sleep(200); // past the window the first contact's flush opened
    item(1);
    await waitFor(() => sent().length === 1, "the first frame, at once", 2000);
    for (let i = 2; i <= 6; i++) {
      item(i);
      await sleep(5);
    }
    await waitFor(() => sent().length === 2, "the folded frame", 2000);
    await sleep(300);
    assert.deepEqual(sent(), ["burst-1", "burst-6"], "a burst inside one window is sent as its first value and its last");
  });

  it("says once that the page refused a frame, does not repeat it, and says so again when a later one is refused after one was taken", async (t) => {
    const lines = logs(t);
    const h = await harness();
    h.page.respond = (req) => (req.path.endsWith("/frame") ? { status: 400 } : h.page.worker(req));
    await publishAll(h);
    await h.pub.runCycle();
    await h.pub.runCycle();
    assert.equal(h.pub.status().state, "publishing", "a refused frame was read as a failing page");
    assert.equal(framesOf(h, "stage:state-changed").length, 1, "the state's frame was sent again with the same text");
    assert.equal(lines.filter((l) => /refused a stage:state-changed frame — .*refused it \(400\)/.test(l)).length, 1, JSON.stringify(lines));
    assert.ok(h.page.putKeys().includes("servicecue-config"), "the documents were held back by a frame");

    const live = (i: number) => {
      h.source.data.live = { ...LIVE, currentItemId: `item-${i}` };
      h.emit("pco:live");
      return h.pub.flush();
    };
    for (let i = 0; i < 3; i++) await live(i);
    assert.equal(lines.filter((l) => /refused a pco:live frame/.test(l)).length, 1, JSON.stringify(lines));
    h.page.respond = (req) => h.page.worker(req);
    await live(10);
    h.page.respond = (req) => (req.path.endsWith("/frame") ? { status: 400 } : h.page.worker(req));
    await live(11);
    assert.equal(lines.filter((l) => /refused a pco:live frame/.test(l)).length, 2, JSON.stringify(lines));
  });
});

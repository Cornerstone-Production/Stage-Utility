// A request the page applied whose answer never came back (a dropped connection, a timeout), or came
// back a 5xx from a page that had stored it first.
//
// The page stores what it was sent and the answer is lost on the way back, so the publisher hears a
// failure for something the page now holds. What it remembers as held must not claim the old text, or
// a change back to it is never sent; and what it may have put there, or taken away, must not be
// assumed either way. Each test has the page apply the request (through the Worker's own handler) and
// lose the answer, checks the page did take it, then changes the source and waits for the page to
// hold what the source says.
//
// The page's answer is withheld by the fixture page, not by stubbing fetch, so the client sees the same
// failure it would from a real one: "other side closed" for a drop, its own ceiling for a hang.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rundownKey } from "../types/servicecue-publish.js";
import { applyThenLose, assertTook, waitFor, type Answer, type Lost } from "./fixtures/publish-receiver.js";
import { fixtureState, LAYOUTS, LIVE } from "./fixtures/publish-source.js";
import { harness, installPublisherHooks, logs, publishAll, sleep, type Harness } from "./fixtures/publisher-harness.js";

installPublisherHooks();

const LOSSES: { name: string; answer: Lost | Answer; timings: { requestTimeoutMs?: number } }[] = [
  { name: "the connection drops", answer: "drop", timings: {} },
  { name: "the answer never comes", answer: "hang", timings: { requestTimeoutMs: 400 } },
  { name: "the page fails after storing it", answer: { status: 502 }, timings: {} },
];

/** Once the page holds what it should, a pass that changes nothing sends no list of what to keep: one remembered as unsure for good would go out every pass. */
const quietAfterwards = async (h: Harness) => {
  await waitFor(() => h.pub.status().state === "publishing", "publishing again", 3000);
  await sleep(20);
  const lists = h.page.manifests().length;
  await h.pub.runCycle();
  await h.pub.runCycle();
  assert.equal(h.page.manifests().length, lists, "a list of what to keep went out on a pass that changed nothing");
};

/** The page answers again. Called in the same turn as the change back: the retry after the backoff must find the source already changed, or it sends the right thing for the wrong reason. */
const answering = (h: Harness) => {
  h.page.respond = (req) => h.page.worker(req);
};

const docPath = (key: string) => `/_publish/v1/doc/${key}`;
const doc = (h: Harness, key: string): unknown => {
  const text = h.page.docs.get(key);
  return text === undefined ? undefined : JSON.parse(text);
};

const LOGO = "0123456789abcdef.png";
const OTHER_LOGO = "fedcba9876543210.webp";

for (const loss of LOSSES) {
  describe(`a request the page applied when ${loss.name}`, () => {
    it("a document changed back to what it was before is sent again, and nothing else is", async (t) => {
      const lines = logs(t);
      const h = await harness(loss.timings);
      await publishAll(h);
      const layouts = () => doc(h, "servicecue-layouts") as unknown[];
      const before = layouts();

      applyThenLose(h.page, loss.answer, (req) => req.path === docPath("servicecue-layouts"));
      h.source.data.layouts = [...LAYOUTS, { id: "svl9", name: "Lights", order: 2, columnRoles: [] }];
      await h.pub.runCycle();
      assertTook(layouts().length === 3, "the change");

      answering(h);
      h.source.data.layouts = LAYOUTS;
      await waitFor(() => layouts().length === 2, "the layouts as they are again: the page still holds the change whose answer was lost", 3000);
      assert.deepEqual(layouts(), before);
      // Only the request with no answer was forgotten: what the page answered is not sent again.
      for (const key of ["servicecue-config", "servicecue-roles"]) assert.equal(h.page.puts().filter((p) => p.key === key).length, 1, `${key} was sent again`);
      assert.equal(lines.filter((l) => /^\[publish\] no answer to the document servicecue-layouts, which the page may have taken all the same; it is sent again/.test(l)).length, 1, JSON.stringify(lines));
    });

    it("a rundown read on its own schedule is read and sent again at once, not when it is next due", async (t) => {
      logs(t);
      const h = await harness({ ...loss.timings, slowEveryMs: 20 });
      await publishAll(h);
      const key = rundownKey("100", "1002")!;
      const title = () => (doc(h, key) as { planTitle?: string } | undefined)?.planTitle;
      assert.equal(title(), "Plan 1002");
      await sleep(30);
      // Due now, and due again only in a minute once read.
      h.pub.setTimings({ slowEveryMs: 60_000 });

      const read = h.source.rundown;
      h.source.rundown = async (typeId, planId) => ({ ...(await read(typeId, planId)), ...(planId === "1002" ? { planTitle: "Changed" } : {}) });
      applyThenLose(h.page, loss.answer, (req) => req.path === docPath(key));
      await h.pub.trickle();
      assertTook(title() === "Changed", "the change");

      answering(h);
      h.source.rundown = read;
      await waitFor(() => title() === "Plan 1002", "the rundown as it is again: the page still holds the change whose answer was lost", 3000);
    });

    it("a live frame changed back is sent again, so the page does not go on showing a service that has ended", async (t) => {
      logs(t);
      const h = await harness(loss.timings);
      h.source.data.live = null;
      await publishAll(h);
      const live = () => doc(h, "pco-live") as { currentItemId?: string } | null;
      assert.equal(live(), null);

      applyThenLose(h.page, loss.answer, (req) => req.path === "/_publish/v1/frame" && (JSON.parse(req.body) as { channel: string }).channel === "pco:live");
      h.source.data.live = LIVE;
      h.emit("pco:live");
      await h.pub.flush();
      assertTook(live()?.currentItemId === "item-1", "the frame");

      answering(h);
      h.source.data.live = null;
      await waitFor(() => live() === null, "the live position to clear: the page still shows the one whose answer was lost", 3000);
    });

    it("a list of what to keep is sent again, and what it removed is sent again when it is wanted back", async (t) => {
      logs(t);
      const h = await harness(loss.timings);
      await publishAll(h);
      const key = rundownKey("200")!;
      assert.ok(h.page.docs.has(key));

      applyThenLose(h.page, loss.answer, (req) => req.path === "/_publish/v1/manifest");
      h.source.data.landing = ["100"];
      await h.pub.runCycle();
      assertTook(!h.page.docs.has(key), "the list");

      answering(h);
      h.source.data.landing = ["100", "200"];
      await waitFor(() => h.page.docs.has(key), "the rundown of a type put back on the landing page: the page removed it under a list whose answer was lost", 3000);
    });

    it("a document that is no longer wanted is taken off the page, though its answer was lost before any list named it", async (t) => {
      logs(t);
      const h = await harness(loss.timings);
      h.source.data.landing = ["100"];
      await publishAll(h);
      const key = rundownKey("200")!;
      assert.ok(!h.page.docs.has(key));

      applyThenLose(h.page, loss.answer, (req) => req.path === docPath(key));
      h.source.data.landing = ["100", "200"];
      await h.pub.runCycle();
      assertTook(h.page.docs.has(key), "the rundown");

      answering(h);
      h.source.data.landing = ["100"];
      await waitFor(() => !h.page.docs.has(key), "the rundown of a type taken off the landing page to leave the public page", 3000);
      await quietAfterwards(h);
    });

    it("an image that is no longer wanted is taken off the page, though its answer was lost", async (t) => {
      logs(t);
      const h = await harness(loss.timings);
      h.source.data.images.set(LOGO, { data: new Uint8Array([1]), mime: "image/png" });
      h.source.data.images.set(OTHER_LOGO, { data: new Uint8Array([2]), mime: "image/webp" });
      await publishAll(h);
      assert.deepEqual([...h.page.assetNames], [LOGO]);

      applyThenLose(h.page, loss.answer, (req) => req.path === `/_publish/v1/asset/${OTHER_LOGO}`);
      h.source.data.state = fixtureState({ appLogo: `/branding-images/${OTHER_LOGO}` });
      await h.pub.runCycle();
      assertTook(h.page.assetNames.has(OTHER_LOGO), "the image");

      answering(h);
      h.source.data.state = fixtureState();
      await waitFor(() => !h.page.assetNames.has(OTHER_LOGO), "the logo that was put back to leave the public page", 3000);
      assert.deepEqual([...h.page.assetNames], [LOGO]);
      await quietAfterwards(h);
    });
  });
}

describe("a request that keeps losing its answer", () => {
  it("is said once, not once per retry, though something else gets through between the retries", async (t) => {
    // As in production: the heartbeat that ends each wait goes through, and the wait is longer than an outage takes to settle.
    const lines = logs(t);
    const h = await harness({ outageSettleMs: 30, backoffMinMs: 60, backoffMaxMs: 60 });
    await publishAll(h);
    applyThenLose(h.page, "drop", (req) => req.path === docPath("servicecue-layouts"));
    h.source.data.layouts = [...LAYOUTS, { id: "svl9", name: "Lights", order: 2, columnRoles: [] }];
    await h.pub.runCycle();
    await waitFor(() => h.page.puts().filter((p) => p.key === "servicecue-layouts").length >= 5, "four retries of the document", 5000);
    assert.equal(lines.filter((l) => /^\[publish\] no answer to the document servicecue-layouts/.test(l)).length, 1, JSON.stringify(lines));
  });
});

describe("a document the page took in a pass that stopped before its list of what to keep", () => {
  it("is taken off the page once it is no longer wanted", async (t) => {
    // Not a lost answer: the page answered, and a later request in the same pass failed, so no list named it.
    logs(t);
    const h = await harness();
    h.source.data.landing = ["100"];
    await publishAll(h);
    const key = rundownKey("200")!;
    h.page.respond = (req) => (req.path === docPath(rundownKey("200", "2001")!) ? { status: 429 } : h.page.worker(req));
    h.source.data.landing = ["100", "200"];
    await h.pub.runCycle();
    assert.ok(h.page.docs.has(key), "the page did not take the rundown");
    assert.equal(h.page.manifests().length, 1, "a list of what to keep went in the pass that failed; the test is not testing a pass that stopped");

    answering(h);
    h.source.data.landing = ["100"];
    await waitFor(() => !h.page.docs.has(key), "the rundown of a type taken off the landing page to leave the public page", 3000);
  });
});

describe("a request the page answered", () => {
  it("is not taken as one that may have landed: a refused document is not sent again until it changes", async (t) => {
    logs(t);
    const h = await harness();
    await publishAll(h);
    h.page.respond = (req) => (req.path === docPath("servicecue-layouts") ? { status: 413 } : h.page.worker(req));
    h.source.data.layouts = [...LAYOUTS, { id: "svl9", name: "Lights", order: 2, columnRoles: [] }];
    await h.pub.runCycle();
    const tries = () => h.page.requests.filter((r) => r.path === docPath("servicecue-layouts")).length;
    const after = tries();
    await h.pub.runCycle();
    assert.equal(tries(), after, "a document the page refused was sent again unchanged");
  });

  it("is not taken as one that may have landed when the page is limiting requests (429)", async (t) => {
    const lines = logs(t);
    const h = await harness();
    await publishAll(h);
    const tries = () => h.page.requests.filter((r) => r.path === docPath("servicecue-layouts")).length;
    h.page.respond = (req) => (req.path === docPath("servicecue-layouts") ? { status: 429 } : h.page.worker(req));
    h.source.data.layouts = [...LAYOUTS, { id: "svl9", name: "Lights", order: 2, columnRoles: [] }];
    await h.pub.runCycle();
    const after = tries();
    answering(h);
    h.source.data.layouts = LAYOUTS;
    await waitFor(() => h.pub.status().state === "publishing", "the wait after the 429 to end", 3000);
    // What the page holds is what it held before the 429, and the layouts are that again: nothing to send.
    assert.equal(tries(), after, "a 429 was taken as a request the page may have stored");
    assert.ok(!lines.some((l) => /no answer to/.test(l)), JSON.stringify(lines));
  });
});

// What the publisher does when a request does not go through, and when its settings change under it.
//
// The failure that mattered: a request the page keeps refusing used to loop at the shortest wait for ever. The probe that
// follows a failure is a heartbeat, the heartbeat goes through, and that cleared the backoff and the problem, so the same request
// failed again five seconds later, said so twice, and flipped the card. The problem now ends when the request that failed goes
// through, and the wait grows with that request's failures in a row.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PUBLISH_MAX_BODY_BYTES } from "../types/servicecue-publish.js";
import { FakeReceiver, PAGE_STATUS, waitFor } from "./fixtures/publish-receiver.js";
import { framesOf, harness, installPublisherHooks, logs, publishAll, sleep, TOKEN, type Harness } from "./fixtures/publisher-harness.js";

installPublisherHooks();

/** Every request the page has had for the one document, as when it arrived. */
const attemptsAt = (h: Harness, key: string) => h.page.requests.filter((r) => r.method === "PUT" && r.path === `/_publish/v1/doc/${key}`).map((r) => r.at);

/** The page answers one document with `status`, and everything else as a page does. */
const refusing = (h: Harness, key: string, status: number) => {
  h.page.respond = (req) => (req.path.endsWith(`/doc/${key}`) ? { status } : h.page.worker(req));
};

describe("a request the page keeps failing", () => {
  it("waits longer each time, by that request's failures in a row, and not by the heartbeat that goes through", async (t) => {
    const lines = logs(t);
    const h = await harness({ firstCycleMs: 5, backoffMinMs: 30, backoffMaxMs: 240 });
    refusing(h, "servicecue-layouts", 503);
    const states: string[] = [];
    const sampler = setInterval(() => states.push(h.pub.status().state), 4);
    await h.pub.start();
    await waitFor(() => attemptsAt(h, "servicecue-layouts").length >= 5, "five attempts at the document", 5000);
    clearInterval(sampler);

    const at = attemptsAt(h, "servicecue-layouts");
    const gaps = at.slice(1).map((v, i) => v - at[i]!);
    // 30, 60, 120, 240: each wait at least what it should be (the old behaviour was 30 every time).
    [30, 60, 120, 240].forEach((want, i) => assert.ok(gaps[i]! >= want - 10, `attempt ${i + 2} came ${gaps[i]!.toFixed(0)} ms after the last, before its ${want} ms wait`));
    assert.ok(h.page.heartbeats().length >= 4, "the probes were not heartbeats that went through, which is the case this is about");

    // The card stays on the problem from the first failure to now, instead of flipping to Publishing in between.
    assert.ok(states.includes("problem"));
    assert.ok(states.slice(states.indexOf("problem")).every((s) => s === "problem"), `the card flipped: ${states.join(",")}`);
    // One outage, one line, and no recovery for a page that has not recovered. A 503 to a document the page has been answering is not a missing token.
    assert.equal(lines.filter((l) => /not accepting what is sent/.test(l)).length, 1, JSON.stringify(lines));
    assert.equal(lines.filter((l) => /reaching the page again/.test(l)).length, 0);
    const problem = h.pub.status().lastError;
    assert.equal(problem?.kind, "server");
    assert.doesNotMatch(problem?.message ?? "", /token/);
  });

  it("ends when the request that failed goes through, and the next failure waits the shortest time again", async (t) => {
    const lines = logs(t);
    const h = await harness({ firstCycleMs: 5, backoffMinMs: 30, backoffMaxMs: 240, outageSettleMs: 0, nudgeMs: 5 });
    refusing(h, "servicecue-layouts", 503);
    await h.pub.start();
    await waitFor(() => attemptsAt(h, "servicecue-layouts").length >= 4, "four attempts", 5000);
    assert.equal(h.pub.status().state, "problem");

    h.page.respond = (req) => h.page.worker(req);
    await waitFor(() => h.pub.status().state === "publishing", "the document to go through", 5000);
    assert.equal(h.pub.status().lastError, null);
    assert.equal(lines.filter((l) => /reaching the page again after 4 failed attempts/.test(l)).length, 1, JSON.stringify(lines));

    // A new failure, after a recovery, starts the waits again from the shortest.
    refusing(h, "servicecue-layouts", 503);
    h.source.data.layouts = [...h.source.data.layouts, { id: "svl9", name: "More", order: 5, columnRoles: [] }];
    h.pub.nudge();
    const before = attemptsAt(h, "servicecue-layouts").length;
    await waitFor(() => attemptsAt(h, "servicecue-layouts").length >= before + 2, "two more attempts", 5000);
    const at = attemptsAt(h, "servicecue-layouts");
    assert.ok(at.at(-1)! - at.at(-2)! < 90, `the second wait after a recovery was ${(at.at(-1)! - at.at(-2)!).toFixed(0)} ms: the backoff was not reset`);
  });

  it("is one outage, however often the page comes and goes inside the settle window", async (t) => {
    const flapping = async (outageSettleMs: number | undefined) => {
      const lines = logs(t);
      const h = await harness({ firstCycleMs: 5, nudgeMs: 5, backoffMinMs: 15, backoffMaxMs: 15, ...(outageSettleMs !== undefined ? { outageSettleMs } : {}) });
      let n = 0;
      h.page.respond = (req) => (req.path.endsWith("/doc/servicecue-layouts") && n++ % 2 === 0 ? { status: 503 } : h.page.worker(req));
      await h.pub.start();
      for (let i = 0; i < 6; i++) {
        await waitFor(() => attemptsAt(h, "servicecue-layouts").length > i, `attempt ${i}`, 5000);
        h.source.data.layouts = [...h.source.data.layouts, { id: `svl${i}`, name: `Flap ${i}`, order: i, columnRoles: [] }];
        h.pub.nudge();
        await sleep(40);
      }
      return { failures: lines.filter((l) => /not accepting what is sent/.test(l)).length, recoveries: lines.filter((l) => /reaching the page again/.test(l)).length };
    };
    const settled = await flapping(undefined);
    assert.deepEqual(settled, { failures: 1, recoveries: 0 }, "a page that flaps was a new outage every time it failed");
    // The control: with no settle window every success ends the outage, and the same flapping writes a line each way, each time.
    const unsettled = await flapping(0);
    assert.ok(unsettled.failures >= 2 && unsettled.recoveries >= 2, JSON.stringify(unsettled));
  });
});

describe("what the page answers to the first request", () => {
  it("is a problem the card names, held when waiting cannot fix it and tried again when it can", async (t) => {
    logs(t);
    // [status, what the card is told, whether sending stops until the settings change]
    const table: [number, string, boolean][] = [
      [401, "auth", true],
      [403, "blocked", true],
      [404, "rejected", true],
      [429, "limited", false],
      [502, "server", false],
      [503, "no-token", false],
    ];
    for (const [status, kind, held] of table) {
      const h = await harness({ firstCycleMs: 5, backoffMinMs: 15, backoffMaxMs: 15 });
      h.page.respond = () => ({ status });
      await h.pub.start();
      await waitFor(() => h.pub.status().state === "problem", `a problem for ${status}`, 3000);
      assert.deepEqual([h.pub.status().lastError?.kind, h.pub.status().lastError?.status], [kind, status], `status ${status}`);
      assert.equal(h.page.requests.every((r) => r.path === "/_publish/v1/status" || r.path === "/_publish/v1/heartbeat"), true, "a document went to a page that had not been verified");
      const made = h.page.requests.length;
      await sleep(150);
      if (held) assert.equal(h.page.requests.length, made, `${status}: a page that cannot be waited out was asked again`);
      else assert.ok(h.page.requests.length > made, `${status}: sending did not carry on trying`);
    }
  });

  it("says a 403 is a rule in front of the page and not the token, and a 503 to the first request may be the page having no token", async (t) => {
    logs(t);
    for (const [status, say, not] of [[403, /Cloudflare rule/, /did not accept the publishing token/], [503, /no publishing token set yet \(or one under 32 characters\)/, /Cloudflare rule/]] as const) {
      const h = await harness({ firstCycleMs: 5 });
      h.page.respond = () => ({ status });
      await h.pub.start();
      await waitFor(() => h.pub.status().state === "problem", "the problem", 3000);
      assert.match(h.pub.status().lastError!.message, say);
      assert.doesNotMatch(h.pub.status().lastError!.message, not);
    }
  });

  it("is not trusted when it is not the protocol: an address that answers everything with a 200 is held, and is never Publishing", async (t) => {
    logs(t);
    // A catch-all: a page that is not the ServiceCue page, answering 2xx to the writes and a page of HTML to the status.
    const h = await harness({ firstCycleMs: 5, backoffMinMs: 15, reconcileMs: 0 });
    h.page.respond = (req) => (req.method === "GET" ? { status: 200, body: "<html>welcome</html>" } : { status: 204 });
    await h.pub.start();
    await waitFor(() => h.pub.status().state === "problem", "the problem", 3000);
    assert.equal(h.pub.status().lastError?.kind, "rejected");
    assert.equal(h.page.puts().length + h.page.frames().length, 0, "documents were sent to an address that is not the page");
    const made = h.page.requests.length;
    await sleep(150);
    assert.equal(h.page.requests.length, made, "an address that is not the page was asked again");
    assert.equal(h.pub.status().state, "problem");

    // And one that was the page, and has stopped being it, is held at the next time the page is asked what it holds.
    const g = await harness({ firstCycleMs: 5, reconcileMs: 0 });
    await publishAll(g);
    g.page.respond = (req) => (req.method === "GET" ? { status: 200, body: "<html>welcome</html>" } : g.page.worker(req));
    await g.pub.runCycle();
    assert.equal(g.pub.status().lastError?.kind, "rejected");
    const sent = g.page.requests.length;
    await g.pub.runCycle();
    assert.equal(g.page.requests.length, sent, "an address that stopped being the page was asked again");
  });

  it("is refused when the page speaks another protocol, and when the token is revoked mid-run, and nothing is sent after", async (t) => {
    const lines = logs(t);
    const other = await harness({ firstCycleMs: 5 });
    other.page.respond = (req) => (req.method === "GET" ? { status: 200, body: JSON.stringify({ ...PAGE_STATUS, protocol: 2 }) } : { status: 204 });
    await other.pub.start();
    await waitFor(() => other.pub.status().state === "problem", "the protocol problem", 3000);
    assert.equal(other.pub.status().lastError?.kind, "protocol");
    assert.match(other.pub.status().lastError!.message, /protocol 2/);
    assert.equal(other.page.puts().length, 0, "documents were sent to a page that speaks another protocol");

    const revoked = await harness();
    await publishAll(revoked);
    revoked.page.respond = () => ({ status: 401 });
    revoked.source.data.layouts = [...revoked.source.data.layouts, { id: "svl7", name: "Revoked", order: 9, columnRoles: [] }];
    await revoked.pub.runCycle();
    assert.equal(revoked.pub.status().lastError?.kind, "auth");
    const made = revoked.page.requests.length;
    await revoked.pub.runCycle();
    await sleep(100);
    assert.equal(revoked.page.requests.length, made, "a page that had just refused the token was asked again");
    assert.equal(lines.some((l) => l.includes(TOKEN)), false, "the token reached the log");
    assert.equal(JSON.stringify(revoked.pub.status()).includes(TOKEN), false, "the token reached the status");
  });

  it("holds until the settings change, and a new token starts it again", async (t) => {
    logs(t);
    const h = await harness({ firstCycleMs: 5, backoffMinMs: 10 });
    h.page.respond = () => ({ status: 401 });
    await h.pub.start();
    await waitFor(() => h.pub.status().state === "problem", "the problem", 3000);
    const made = h.page.requests.length;
    await sleep(100);
    assert.equal(h.page.requests.length, made, "the sender asked a page that had refused its token again");

    const fresh = "tok-a-fresh-one-".padEnd(40, "0");
    h.page.respond = (req) => h.page.worker(req);
    h.token.value = fresh;
    await h.pub.apply();
    await h.pub.runCycle();
    assert.equal(h.pub.status().state, "publishing");
    assert.equal(h.page.requests.at(-1)!.headers.authorization, `Bearer ${fresh}`);
  });
});

describe("one document, image or frame the page will not take", () => {
  it("is skipped until it changes, said once, and is not the page being down", async (t) => {
    // 413 for one over its cap, 404 for a key it does not know, 400 for a body it cannot read.
    for (const status of [413, 404, 400]) {
      const lines = logs(t);
      const h = await harness();
      refusing(h, "servicecue-roles", status);
      await h.pub.start();
      await h.pub.runCycle();
      await h.pub.runCycle();
      const tries = () => h.page.puts().filter((p) => p.key === "servicecue-roles").length;
      assert.equal(tries(), 1, `a document refused with ${status} was sent again with the same text`);
      assert.equal(h.pub.status().state, "publishing", `status ${status} on one document was read as a failing page`);
      assert.ok(h.page.putKeys().includes("servicecue-layouts") && h.page.puts().some((p) => p.key === "service-types"), "the other documents were held back");
      assert.equal(lines.filter((l) => new RegExp(`not sent: servicecue-roles\\b.*refused it`).test(l)).length >= 1, true, JSON.stringify(lines));
      assert.equal(lines.filter((l) => /not sent: servicecue-roles/.test(l)).length, 1, "said more than once");
    }
  });

  it("is not sent at all when it is over the page's own cap, and goes when it changes", async (t) => {
    const lines = logs(t);
    const h = await harness();
    h.source.data.layouts = [{ id: "svl1", name: "x".repeat(PUBLISH_MAX_BODY_BYTES), order: 0, columnRoles: [] }];
    await h.pub.start();
    await h.pub.runCycle();
    await h.pub.runCycle();
    assert.equal(h.page.putKeys().includes("servicecue-layouts"), false, "a document over the cap went to the page to be refused");
    assert.equal(lines.filter((l) => /not sent: servicecue-layouts\b.*over the page's limit/.test(l)).length, 1, JSON.stringify(lines.map((l) => l.slice(0, 120))));
    assert.equal(h.pub.status().state, "publishing");
    assert.ok(h.page.putKeys().includes("servicecue-config"), "the rest of the documents were held back by one that is too large");
    h.source.data.layouts = [{ id: "svl1", name: "short", order: 0, columnRoles: [] }];
    await h.pub.runCycle();
    assert.ok(h.page.putKeys().includes("servicecue-layouts"));
  });
});

describe("its settings", () => {
  it("hold it, with what to fix, for an address or a token the rules refuse, and send nothing", async (t) => {
    const lines = logs(t);
    const table: [string, { url?: string; token?: string }, RegExp][] = [
      ["an address that is not https", { url: "http://example.test" }, /https:\/\//],
      ["no token", { token: "   " }, /No publishing token is set/],
      ["a token under 32 characters", { token: "x".repeat(31) }, /at least 32 characters/],
      ["a token with a space in it", { token: `${"x".repeat(20)} ${"y".repeat(20)}` }, /no spaces/],
      ["a token with a character a header cannot carry", { token: `${"x".repeat(20)}—${"y".repeat(20)}` }, /letters, digits and punctuation/],
    ];
    for (const [what, over, message] of table) {
      const h = await harness();
      Object.assign(h.settings, over.url === undefined ? {} : { url: over.url });
      if (over.token !== undefined) h.token.value = over.token;
      await h.pub.start();
      assert.equal(h.pub.status().state, "problem", what);
      assert.equal(h.pub.status().lastError?.kind, "config", what);
      assert.match(h.pub.status().lastError!.message, message, what);
      assert.equal(h.page.requests.length, 0, `${what}: something was sent`);
    }
    assert.ok(lines.every((l) => !l.includes("—" + "y".repeat(20))), "the token reached the log");

    // Exactly 32 is a token.
    const h = await harness();
    h.token.value = "x".repeat(32);
    await h.pub.start();
    await h.pub.runCycle();
    assert.equal(h.pub.status().state, "publishing");
    assert.equal(h.page.requests[0]!.headers.authorization, `Bearer ${"x".repeat(32)}`);
  });

  it("start a new run: the old one cannot send to the new address with the new token, and nothing of it is left on the card", async (t) => {
    logs(t);
    const a = await harness();
    const b = await FakeReceiver.start();
    try {
      // The old page is slow, so its cycle is still working when the settings change.
      a.page.respond = (req) => (req.path.includes("/doc/") ? a.page.worker(req, { delayMs: 60 }) : a.page.worker(req));
      await a.pub.start();
      const cycle = a.pub.runCycle();
      await waitFor(() => a.page.putKeys().length >= 1, "the old cycle to be under way", 3000);
      const newToken = "tok-for-the-other-".padEnd(40, "0");
      a.settings.url = b.origin;
      a.token.value = newToken;
      await a.pub.apply();
      await cycle;
      await a.pub.runCycle();
      await sleep(150);

      assert.equal(a.pub.status().lastSentAt === null || a.pub.status().lastSentAt! > 0, true);
      assert.ok(b.requests.length > 0, "the new page was sent nothing");
      assert.equal(b.requests[0]!.method + " " + b.requests[0]!.path, "GET /_publish/v1/status", "the new page's first request was left over from the old cycle");
      for (const r of b.requests) assert.equal(r.headers.authorization, `Bearer ${newToken}`, `${r.method} ${r.path} to the new page carried the old token`);
      for (const r of a.page.requests.filter((r) => !(r.method === "PUT" && r.path.endsWith("/manifest")))) assert.equal(r.headers.authorization, `Bearer ${TOKEN}`);
    } finally {
      await b.close();
    }
  });

  it("start a new run with nothing of the old one on the card: when it was last sent and how many it holds", async (t) => {
    logs(t);
    const h = await harness();
    await publishAll(h);
    assert.ok(h.pub.status().lastSentAt !== null && h.pub.status().counts.layouts === 2 && h.pub.status().counts.types === 2);
    // The same page, a new token: a new run, which has sent nothing yet.
    const hang = await FakeReceiver.start();
    try {
      hang.respond = () => "hang";
      h.settings.url = hang.origin;
      h.token.value = "tok-for-the-other-".padEnd(40, "0");
      await h.pub.apply();
      assert.deepEqual([h.pub.status().lastSentAt, h.pub.status().counts], [null, { types: 0, plans: 0, layouts: 0 }], "the new run reports what the old one sent");
    } finally {
      h.pub.stop();
      await hang.close();
    }
  });

  it("ask the page being left to forget what it holds, with the token it was sent with, when publishing is switched off or moved to another address", async (t) => {
    logs(t);
    // Switched off.
    const off = await harness();
    await publishAll(off);
    assert.ok(off.page.docs.size > 0);
    off.settings.enabled = false;
    assert.deepEqual(await off.pub.apply({ dropCopy: true }), { dropped: { ok: true } });
    assert.deepEqual(off.page.manifests().at(-1), { docs: [], assets: [] });
    assert.equal(off.page.docs.size, 0, "the page still holds the rundown it was told to forget");
    assert.equal(off.page.requests.at(-1)!.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(off.pub.status().state, "off");

    // Moved to another address: the OLD page is asked, with the OLD token, before the new one is begun.
    const from = await harness();
    const to = await FakeReceiver.start();
    try {
      await publishAll(from);
      from.settings.url = to.origin;
      from.token.value = "tok-for-the-other-".padEnd(40, "0");
      assert.deepEqual(await from.pub.apply(), { dropped: { ok: true } });
      assert.equal(from.page.docs.size, 0, "the page left behind still holds its copy");
      assert.deepEqual(from.page.manifests().at(-1), { docs: [], assets: [] });
      assert.equal(from.page.requests.at(-1)!.headers.authorization, `Bearer ${TOKEN}`, "the old page was asked with the new token, or not asked");
      await from.pub.runCycle();
      assert.ok(to.requests.length > 0 && to.requests.every((r) => r.headers.authorization === `Bearer ${"tok-for-the-other-".padEnd(40, "0")}`));
    } finally {
      from.pub.stop();
      await to.close();
    }

    // The same address with a new token is the same page: nothing to drop.
    const same = await harness();
    await publishAll(same);
    same.token.value = "tok-a-fresh-one-".padEnd(40, "0");
    assert.deepEqual(await same.pub.apply(), {});
    assert.equal(same.page.manifests().length, 1, "the page was told to forget what it was about to be sent again");
  });

  it("say that the page may still hold its copy when there is no connection to it to ask through, or the page cannot be reached", async (t) => {
    logs(t);
    // Switched on with a token the rules refuse: there was never a run, so there is no token for the page.
    const none = await harness();
    none.token.value = "short";
    await none.pub.start();
    none.settings.enabled = false;
    // This process never sent anything, so there is nothing out there for it to drop, and it says nothing of the kind.
    assert.deepEqual(await none.pub.apply({ dropCopy: true }), { dropped: { ok: true } });
    assert.equal(none.page.requests.length, 0);

    // One that did send, and was stopped before it was switched off, has left a copy it can no longer ask about.
    const stopped = await harness();
    await publishAll(stopped);
    stopped.pub.stop();
    stopped.settings.enabled = false;
    const said = await stopped.pub.apply({ dropCopy: true });
    assert.equal(said.dropped?.ok, false);
    assert.match(said.dropped && !said.dropped.ok ? said.dropped.message : "", /may still hold the last rundown/);

    // The page is gone when it is asked.
    const gone = await harness();
    await publishAll(gone);
    await gone.page.close();
    gone.settings.enabled = false;
    const failed = await gone.pub.apply({ dropCopy: true });
    assert.equal(failed.dropped?.ok, false);

    // A plain stop, and switching off without asking, leave the page's copy alone.
    const stop = await harness();
    await publishAll(stop);
    const manifests = stop.page.manifests().length;
    stop.pub.stop();
    stop.settings.enabled = false;
    await stop.pub.apply();
    assert.equal(stop.page.manifests().length, manifests, "a shutdown blanked the public page");
    assert.equal(framesOf(stop, "stage:state-changed").length, 1);
  });
});

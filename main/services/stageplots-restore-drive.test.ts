// A config restore and published stage plots, driven whole: the real configSnapshot.apply over a
// scratch data directory, the publisher, and the Worker's real request handler as the page
// (fixtures/publish-receiver.ts). Each case publishes, restores, "restarts" (a new publisher over
// what the restore wrote) and lets it drain, then holds the one rule: every secret the page still
// serves is on a venue or queued for removal. The merge's rules case by case are in
// stageplots-restore.test.ts.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, mock, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stageplots-restore-drive-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { FakeReceiver } = await import("./fixtures/publish-receiver.js");
const { parsePublishUrl } = await import("./servicecue-publish-rules.js");
const { stageplotsStore, checkStagePlotsDoc } = await import("./stageplots-store.js");
const { StagePlotsPublisher } = await import("./stageplots-publish.js");
const { configSnapshot } = await import("./config-snapshot.js");
const { livePoller } = await import("./live-poller.js");
const { stageController } = await import("./stage-controller.js");
const { stageplotsPublisher: instance } = await import("./stageplots-publish-instance.js");

import type { FakeReceiver as Receiver } from "./fixtures/publish-receiver.js";

const TOKEN = "k".repeat(40);
const OWN = "3f2a9c1e-5b7d-4e21-9a0c-6d8e2f41b7a3";
const OTHER = "7c1e04ab-92f3-4d6a-b1e8-0f5c3a9d2e64";
const hash = (i: number) => i.toString(16).padStart(16, "0");
function webp(): Uint8Array {
  const b = new Uint8Array(2048).fill(7);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WEBP"), 8);
  return b;
}
function venueDoc() {
  return {
    venues: [{ id: "v-1", name: "Main room", kind: "home", notes: "", plotIds: ["p-0"], defaultPlotId: "p-0" }],
    backgrounds: [{ id: "b-0", name: "Plan", original: { hash: hash(1000), mime: "image/png", bytes: 1000 }, source: { hash: hash(1000), ext: "png" }, converted: { hash: hash(1), width: 2400, height: 1600, bytes: 2048 }, cleanup: true, pdfPage: null, pdfPages: null }],
    plots: [{ id: "p-0", venueId: "v-1", name: "Plot 0", backgroundId: "b-0", bgFade: 0.4, items: [], version: 1 }],
    overrides: [],
    pendingRemovals: [],
  };
}
function quiet() {
  const poller = livePoller as unknown as { running: boolean; timer: ReturnType<typeof setTimeout> | null };
  poller.running = false;
  if (poller.timer) clearTimeout(poller.timer);
  poller.timer = null;
  const c = stageController as unknown as Record<string, ReturnType<typeof setInterval> | null>;
  for (const k of ["autoRefreshTimer", "updateCheckTimer"]) {
    if (c[k]) clearInterval(c[k]!);
    c[k] = null;
  }
}
const snapshotOf = (files: Record<string, unknown>) => ({ kind: "stage-utility-config", version: 1, createdAt: "2026-11-11T00:00:00.000Z", files });

let page: Receiver;
let origin: string;
const publishers: InstanceType<typeof StagePlotsPublisher>[] = [];

afterEach(async () => {
  for (const p of publishers.splice(0)) await p.stop();
  await page?.close();
  quiet();
});

function publisher() {
  let listener: (c: string) => void = () => undefined;
  const p = new StagePlotsPublisher({
    target: async () => ({ ok: true, origin: origin as never, token: TOKEN }),
    store: stageplotsStore,
    image: async () => webp(),
    plan: () => ({ planId: null, planDates: null }),
    timeZone: () => "America/Chicago",
    onSaved: () => undefined,
    listen: (cb) => (listener = cb),
    debounceMs: 20,
  });
  p.start();
  publishers.push(p);
  return { p, hear: (c: string) => listener(c) };
}

const visit = async (secret: string, key = "index") =>
  (await page.worker({ method: "GET", path: `/stageplots/${secret}/${key}`, headers: {}, body: "", bytes: Buffer.alloc(0), at: 0 })).status;
const venue = async () => (await stageplotsStore.get()).venues.find((v) => v.id === "v-1")!;

/** A box whose settings carry `serverId` (or none), with the venue in its store and a page to publish to. */
async function box(serverId: string | null) {
  page = await FakeReceiver.start();
  page.token = TOKEN;
  const parsed = parsePublishUrl(page.origin);
  assert.ok(parsed.ok);
  origin = parsed.origin;
  await fs.writeFile(path.join(TMP, "settings.json"), JSON.stringify({ appName: "Live", ...(serverId ? { serverId } : {}) }), "utf8");
  await stageplotsStore.update(() => checkStagePlotsDoc(structuredClone(venueDoc())));
}

/** A config of this store as it is now, saved by a server with `serverId` (or none). */
async function bundle(serverId: string | null) {
  await stageplotsStore.update((d) => d);
  const sp = JSON.parse(await fs.readFile(path.join(TMP, "stageplots.json"), "utf8"));
  return snapshotOf({ "settings.json": { appName: "Live", ...(serverId ? { serverId } : {}) }, "stageplots.json": sp });
}

/** Restore, then "restart": the store re-read from what the restore wrote, and a new publisher that drains at start. */
async function restoreAndRestart(b: unknown, replacesOriginal = false) {
  for (const p of publishers.splice(0)) await p.stop();
  await configSnapshot.apply(b, { replacesOriginal });
  quiet();
  const onDisk = JSON.parse(await fs.readFile(path.join(TMP, "stageplots.json"), "utf8"));
  await stageplotsStore.update(() => checkStagePlotsDoc(onDisk));
  const r = publisher();
  await r.p.settle();
  return r;
}

/** THE RULE: every secret the page serves is on a venue or queued against this page. */
async function noUnknownLinks() {
  const doc = await stageplotsStore.get();
  const known = new Set([...doc.venues.flatMap((v) => (v.publish?.origin === origin ? [v.publish.secret] : [])), ...doc.pendingRemovals.filter((e) => e.origin === origin).map((e) => e.secret)]);
  const live = new Set([...page.hub.stageplots.keys()].map((id) => id.slice(0, id.indexOf("/"))));
  for (const s of live) assert.ok(known.has(s), "a link is live on the page and the store does not know it");
}

describe("a restore never revives a revoked link, and never strands a live one", () => {
  test("A: own box, regenerated after the backup, restores the backup: the old link stays dead, and the newer one is taken down", async () => {
    await box(OWN);
    const { p } = publisher();
    assert.ok((await p.publish("v-1")).ok);
    const s1 = (await venue()).publish!.secret;
    const b = await bundle(OWN);
    assert.ok((await p.regenerate("v-1")).ok);
    const s2 = (await venue()).publish!.secret;
    assert.equal(await visit(s1), 404);
    const r = await restoreAndRestart(b);
    assert.equal((await venue()).publish, undefined, "the revoked link came back on the venue");
    assert.equal(await visit(s2), 404, "the newer link, which the backup does not know, is still live");
    // And an edit afterwards publishes nothing under the revoked secret.
    await stageplotsStore.update((d) => ({ ...d, plots: d.plots.map((x) => ({ ...x, name: "Edited", version: x.version + 1 })) }));
    r.hear("stageplots:updated");
    await r.p.settle();
    assert.equal(await visit(s1), 404, "an edit after the restore brought the revoked link back");
    assert.deepEqual((await stageplotsStore.get()).pendingRemovals, []);
    await noUnknownLinks();
  });

  test("B: own box, published after the backup, restores the backup: the link is taken down", async () => {
    await box(OWN);
    const b = await bundle(OWN);
    const { p } = publisher();
    assert.ok((await p.publish("v-1")).ok);
    const s = (await venue()).publish!.secret;
    await restoreAndRestart(b);
    assert.equal((await venue()).publish, undefined);
    assert.equal(await visit(s), 404, "the link published after the backup was stranded");
    await noUnknownLinks();
  });

  test("C: this box published, then restores another server's config keeping its own id: its own link is never left unknown", async () => {
    await box(OWN);
    const { p } = publisher();
    assert.ok((await p.publish("v-1")).ok);
    const s = (await venue()).publish!.secret;
    // Another server's config whose stage plots happen to be this box's (a copied backup).
    const b = await bundle(OTHER);
    await restoreAndRestart(b);
    const after = await venue();
    // Both files hold the link on the venue: provably this box's, so it stays published.
    assert.equal(after.publish?.secret, s);
    assert.equal(await visit(s), 200);
    await noUnknownLinks();
  });

  test("C': another server's config with links of its own: this box's are taken down, the other server's left to it", async () => {
    await box(OWN);
    const { p } = publisher();
    assert.ok((await p.publish("v-1")).ok);
    const mine = (await venue()).publish!.secret;
    const theirs = `${"T".repeat(42)}E`;
    const b = await bundle(OTHER);
    (b.files["stageplots.json"] as { venues: { publish: { secret: string } }[] }).venues[0]!.publish.secret = theirs;
    await restoreAndRestart(b);
    assert.equal((await venue()).publish, undefined);
    assert.equal(await visit(mine), 404, "this box's own link was stranded");
    await noUnknownLinks();
  });

  test("a box with no server id restoring its own backup keeps its link published", async () => {
    await box(null);
    const { p } = publisher();
    assert.ok((await p.publish("v-1")).ok);
    const s = (await venue()).publish!.secret;
    await restoreAndRestart(await bundle(null));
    assert.equal((await venue()).publish?.secret, s, "an own backup with no ids unpublished every venue");
    assert.equal(await visit(s), 200);
    await noUnknownLinks();
  });
});

describe("a live stageplots.json that cannot be read", () => {
  test("one that does not parse is never a fresh install: the backup's link is not revived, and is taken down", async () => {
    await box(OWN);
    const { p } = publisher();
    assert.ok((await p.publish("v-1")).ok);
    const s = (await venue()).publish!.secret;
    const b = await bundle(OWN);
    for (const x of publishers.splice(0)) await x.stop();
    // Cut short mid-write: it does not parse, though the page its link was on can still be read.
    await fs.writeFile(path.join(TMP, "stageplots.json"), `{"venues":[{"id":"v-1","publish":{"secret":"${s}","origin":"${origin}"`, "utf8");
    const lines: string[] = [];
    const warn = mock.method(console, "warn", (...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    try {
      await restoreAndRestart(b);
    } finally {
      warn.mock.restore();
    }
    const said = lines.find((l) => l.startsWith("[config-snapshot] the live stageplots.json does not parse")) ?? "";
    assert.ok(said.includes(`any stage plots links in it (on ${new URL(origin).host}) cannot be removed from here and are lost to this box`), said || lines.join(" / "));
    assert.equal(said.includes(s), false, "the warning names a secret");
    assert.equal((await venue()).publish, undefined, "a link the live file may have revoked came back published");
    assert.equal(await visit(s), 404, "the backup's link, queued for removal, is still live");
    await noUnknownLinks();
  });

  test("one that fails its check carries only well-formed links, so the restored file passes the store's own check", async () => {
    await box(OWN);
    const { p } = publisher();
    assert.ok((await p.publish("v-1")).ok);
    const s = (await venue()).publish!.secret;
    const b = await bundle(null);
    (b.files["stageplots.json"] as { venues: { publish?: unknown }[] }).venues[0]!.publish = undefined;
    for (const x of publishers.splice(0)) await x.stop();
    // A venue with no name fails the check; its link is good, another venue's and a queued one's are not.
    const live = JSON.parse(await fs.readFile(path.join(TMP, "stageplots.json"), "utf8"));
    live.venues[0].name = "";
    live.venues.push({ id: "v-9", publish: { secret: "not-a-secret", origin } }, { id: "v-8", publish: { secret: `${"Z".repeat(42)}E`, origin: "nowhere" } });
    live.pendingRemovals = [{ secret: "short", origin, since: "2026-11-13T10:00:00.000Z", reason: "regenerated" }];
    await fs.writeFile(path.join(TMP, "stageplots.json"), JSON.stringify(live), "utf8");
    const lines: string[] = [];
    const warn = mock.method(console, "warn", (...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    try {
      await configSnapshot.apply(b, { replacesOriginal: false });
    } finally {
      warn.mock.restore();
    }
    quiet();
    const written = JSON.parse(await fs.readFile(path.join(TMP, "stageplots.json"), "utf8"));
    const checked = checkStagePlotsDoc(written);
    assert.deepEqual(checked.pendingRemovals.map((e) => [e.secret === s, e.origin === origin, e.reason]), [[true, true, "restored over"]]);
    assert.ok(lines.some((l) => l.includes("3 links in it with a malformed secret or page address")), lines.join(" / "));
    await stageplotsStore.update(() => checked);
    const r = publisher();
    await r.p.settle();
    assert.equal(await visit(s), 404);
    await noUnknownLinks();
  });
});

describe("a restore that cannot quiet a background writer", () => {
  for (const which of ["the live poller", "the stage controller", "the stage plots publisher"] as const) {
    test(`is refused when ${which} cannot be paused, with nothing written and the others resumed`, async () => {
      await box(OWN);
      const before = await fs.readFile(path.join(TMP, "stageplots.json"), "utf8");
      const resumed: string[] = [];
      const pausing = (name: string) => async () => {
        if (name === which) throw new Error("it would not stop");
        return () => void resumed.push(name);
      };
      const spies = [
        mock.method(livePoller, "pause", pausing("the live poller")),
        mock.method(stageController, "pauseBackgroundWork", pausing("the stage controller")),
        mock.method(instance, "pause", pausing("the stage plots publisher")),
      ];
      const quietLog = mock.method(console, "error", () => undefined);
      try {
        await assert.rejects(configSnapshot.apply(await bundle(OWN)), new RegExp(`^Error: The restore was refused: ${which} \\(it would not stop\\) could not be paused`));
      } finally {
        for (const sp of spies) sp.mock.restore();
        quietLog.mock.restore();
      }
      assert.equal(await fs.readFile(path.join(TMP, "stageplots.json"), "utf8"), before, "a refused restore wrote");
      assert.deepEqual(resumed.sort(), ["the live poller", "the stage controller", "the stage plots publisher"].filter((n) => n !== which));
    });
  }
});

describe("the restore holds the publisher", () => {
  test("configSnapshot.apply pauses the app's publisher before it writes, and a refused restore resumes it", async () => {
    await box(OWN);
    let paused = 0;
    let resumed = 0;
    const spy = mock.method(instance, "pause", async () => {
      paused++;
      return () => void resumed++;
    });
    try {
      await assert.rejects(configSnapshot.apply(snapshotOf({ "stageplots.json": { venues: "not a list" } })));
      assert.equal(paused, 0, "a restore refused at its check paused anything");
      await fs.writeFile(path.join(TMP, "settings.json"), "{}", "utf8");
      await configSnapshot.apply(await bundle(OWN));
      quiet();
      assert.equal(paused, 1, "the restore wrote with the publisher running");
      assert.equal(resumed, 0, "a restore that landed resumed the publisher");
    } finally {
      spy.mock.restore();
    }
  });

  test("a republish due while a restore lands writes nothing over the restored file, and actions are refused until it resumes", async () => {
    await box(OWN);
    const resume = await instance.pause();
    try {
      const r = await instance.publish("v-1");
      assert.deepEqual(r.ok ? null : [r.status, /restore is under way/.test(r.error)], [503, true]);
      const before = await fs.readFile(path.join(TMP, "stageplots.json"), "utf8");
      instance.changed();
      await instance.settle();
      assert.equal(await fs.readFile(path.join(TMP, "stageplots.json"), "utf8"), before, "the publisher wrote while paused");
    } finally {
      resume();
    }
  });
});

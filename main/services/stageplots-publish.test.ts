// Publishing a venue's stage plots behind a secret link, end to end: the publisher, the
// app's real store (in a scratch data dir) and the real Worker request handler over HTTP
// (fixtures/publish-receiver.ts), so routing, the token, validation and the limits are
// the Worker's own and not a second reading of the protocol page.
//
// Lists that must stay exact are literal, sorted, one entry to a line.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stageplots-publish-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { FakeReceiver, waitFor } = await import("./fixtures/publish-receiver.js");
const { parsePublishUrl } = await import("./servicecue-publish-rules.js");
const { stageplotsStore, checkStagePlotsDoc } = await import("./stageplots-store.js");
const { StagePlotsPublisher } = await import("./stageplots-publish.js");
const { PUBLISH_MAX_BODY_BYTES, isStagePlotsSecret } = await import("../types/servicecue-publish.js");

import type { FakeReceiver as Receiver, Received } from "./fixtures/publish-receiver.js";
import type { PlotItem, PublishedPlot, PublishedVenue, StagePlotsDoc, Venue } from "../types/stageplots.js";
import type { PatchFile } from "../types/patch.js";

const TOKEN = "k".repeat(40);
const SP = /^\/_publish\/v1\/stageplots\/([^/]+)(?:\/(.+))?$/;

/** A WebP the Worker takes: RIFF, a size, WEBP, then `size` bytes in all. */
function webp(size = 2048, fill = 7): Uint8Array {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  return bytes;
}

const hash = (i: number) => i.toString(16).padStart(16, "0");

function item(id: string, extra: Partial<PlotItem> = {}): PlotItem {
  return { id, type: "box", x: 10, y: 10, w: 40, h: 30, rotation: 0, label: "Wedge", color: null, notes: "", inputs: [], ...extra };
}

/** One venue with `plots` plots, plot i drawn on background i (of `backgrounds`), or none past them. */
function venueDoc(plots = 2, backgrounds = 2, items: (i: number) => PlotItem[] = (i) => [item(`i-${i}`)]): StagePlotsDoc {
  const bgs = Array.from({ length: backgrounds }, (_, i) => ({
    id: `b-${i}`,
    name: `Plan ${i}`,
    original: { hash: hash(1000 + i), mime: "image/png" as const, bytes: 1000 },
    source: { hash: hash(1000 + i), ext: "png" as const },
    converted: { hash: hash(i + 1), width: 2400, height: 1600, bytes: 2048 },
    cleanup: true,
    pdfPage: null,
    pdfPages: null,
  }));
  const ps = Array.from({ length: plots }, (_, i) => ({
    id: `p-${i}`,
    venueId: "v-1",
    name: `Plot ${i}`,
    backgroundId: i < backgrounds ? `b-${i}` : null,
    bgFade: 0.4,
    items: items(i),
    version: 1,
  }));
  return {
    venues: [{ id: "v-1", name: "Main room", kind: "home", notes: "Side door.", plotIds: ps.map((p) => p.id), defaultPlotId: "p-0" }],
    backgrounds: bgs,
    plots: ps,
    overrides: [],
    pendingRemovals: [],
  };
}

interface Harness {
  page: Receiver;
  publisher: InstanceType<typeof StagePlotsPublisher>;
  images: Map<string, Uint8Array>;
  saved: StagePlotsDoc[];
  plan: { planId: string | null; planDates: string | null; serviceTypeId: string | null };
  /** The patch the publisher reads; null reads as a patch that cannot be read. */
  patch: { file: PatchFile | null };
  /** Tell the publisher a channel was broadcast, as the app's broadcaster does. */
  hear: (channel: string) => void;
  /** Change the document as a route would, and broadcast it. */
  edit: (fn: (doc: StagePlotsDoc) => StagePlotsDoc) => Promise<void>;
  venue: () => Promise<Venue>;
}

let open: Harness | null = null;
/** Every fake page a test started, for the standing check after it. */
const pages: { page: Receiver; origin: string }[] = [];

/** A fake page (the Worker's real handler), registered for the standing check. */
async function startPage(): Promise<Receiver> {
  const page = await FakeReceiver.start();
  page.token = TOKEN;
  // The origin read now: a test may close its page before the check runs.
  pages.push({ page, origin: page.origin });
  return page;
}

/**
 * THE STANDING CHECK, after every test: every secret any fake page holds is on a venue or in
 * the store's pending removals, against that page. A secret live on a page that the store does
 * not know of is a link nothing can ever take down.
 */
async function assertNoUnknownLinks(): Promise<void> {
  const doc = await stageplotsStore.get();
  for (const { page, origin: raw } of pages) {
    const origin = parsePublishUrl(raw);
    assert.ok(origin.ok);
    const known = new Set([
      ...doc.venues.flatMap((v) => (v.publish && v.publish.origin === origin.origin ? [v.publish.secret] : [])),
      ...doc.pendingRemovals.filter((e) => e.origin === origin.origin).map((e) => e.secret),
    ]);
    const live = new Set([...page.hub.stageplots.keys()].map((id) => id.slice(0, id.indexOf("/"))));
    for (const secret of live) assert.ok(known.has(secret), `a secret is live on ${raw} and the store does not know it`);
  }
}

async function harness(doc: StagePlotsDoc = venueDoc(), opts: { target?: () => Promise<unknown>; client?: (t: { origin: string; token: string }) => unknown } = {}): Promise<Harness> {
  const page = await startPage();
  const parsed = parsePublishUrl(page.origin);
  assert.ok(parsed.ok);
  await stageplotsStore.update(() => checkStagePlotsDoc(structuredClone(doc)));
  const images = new Map<string, Uint8Array>();
  for (const b of doc.backgrounds) images.set(b.converted.hash, webp());
  const saved: StagePlotsDoc[] = [];
  const plan = { planId: null as string | null, planDates: null as string | null, serviceTypeId: null as string | null };
  const patch: { file: PatchFile | null } = { file: { sheets: [], updatedAt: "" } };
  let listener: (channel: string) => void = () => undefined;
  const publisher = new StagePlotsPublisher({
    target: (opts.target as never) ?? (async () => ({ ok: true, origin: parsed.origin, token: TOKEN })),
    store: stageplotsStore,
    image: async (h) => images.get(h) ?? null,
    plan: () => plan,
    patch: async () => {
      if (!patch.file) throw new Error("patch.json could not be read (EIO)");
      return structuredClone(patch.file);
    },
    timeZone: () => "America/Chicago",
    onSaved: (d) => saved.push(d),
    listen: (cb) => (listener = cb),
    debounceMs: 30,
    ...(opts.client ? { client: opts.client as never } : {}),
  });
  publisher.start();
  const h: Harness = {
    page,
    publisher,
    images,
    saved,
    plan,
    patch,
    hear: (channel) => listener(channel),
    edit: async (fn) => {
      await stageplotsStore.update(fn);
      listener("stageplots:updated");
    },
    venue: async () => (await stageplotsStore.get()).venues.find((v) => v.id === "v-1")!,
  };
  open = h;
  return h;
}

afterEach(async () => {
  await open?.publisher.stop();
  try {
    await assertNoUnknownLinks();
  } finally {
    for (const { page } of pages.splice(0)) await page.close().catch(() => undefined);
    open = null;
  }
});

const pending = async () => (await stageplotsStore.get()).pendingRemovals;

/** The StagePlots requests the page received, as "METHOD secret key". */
function spRequests(page: Receiver): { method: string; secret: string; key: string | null; r: Received }[] {
  return page.requests.flatMap((r) => {
    const m = SP.exec(r.path);
    return m ? [{ method: r.method, secret: m[1]!, key: m[2] ?? null, r }] : [];
  });
}

/** What a visitor gets for a key, through the real handler. */
async function visit(page: Receiver, secret: string, key: string): Promise<{ status: number; body: string }> {
  const a = await page.worker({ method: "GET", path: `/stageplots/${secret}/${key}`, headers: {}, body: "", bytes: Buffer.alloc(0), at: 0 });
  return { status: a.status, body: a.body ?? "" };
}

const host = (page: Receiver) => new URL(page.origin).host;

describe("publishing a venue", () => {
  test("PUTs every background, then each plot, then the index, under a new secret, and saves the link", async () => {
    const h = await harness(venueDoc(2, 2));
    const r = await h.publisher.publish("v-1");
    assert.ok(r.ok, r.ok ? "" : r.error);
    const pub = (await h.venue()).publish!;
    assert.ok(isStagePlotsSecret(pub.secret), "the secret is not 32 bytes of base64url");
    assert.equal(pub.origin, h.page.origin);
    assert.equal(pub.lastError, null);
    assert.deepEqual(pub.publishedImages, [hash(1), hash(2)]);
    assert.deepEqual(pub.unpublishedImages, []);
    assert.deepEqual(await pending(), []);
    assert.deepEqual(h.page.hub.stagePlotKeys(pub.secret).sort(), [
      "image/0000000000000001",
      "image/0000000000000002",
      "index",
      "plot/p-0",
      "plot/p-1",
    ]);
    const order = spRequests(h.page).map((q) => (q.key === null ? `${q.method} keep` : q.key.split("/")[0]));
    // The index goes after every background and plot: it is what makes the link a page.
    assert.deepEqual(order, ["image", "image", "plot", "plot", "index", "PUT keep"]);

    const index = JSON.parse((await visit(h.page, pub.secret, "index")).body) as PublishedVenue;
    assert.deepEqual(index, {
      name: "Main room",
      notes: "Side door.",
      plots: [
        { id: "p-0", name: "Plot 0" },
        { id: "p-1", name: "Plot 1" },
      ],
      defaultPlotId: "p-0",
      shown: { plotId: "p-0", reason: "default" },
      plan: null,
      timeZone: "America/Chicago",
    } satisfies PublishedVenue);
    const plot = JSON.parse((await visit(h.page, pub.secret, "plot/p-1")).body) as PublishedPlot;
    assert.deepEqual(plot.background, { hash: hash(2), width: 2400, height: 1600 });
    // Two writes, each broadcast: the secret queued before its first request went out, then moved onto the venue.
    assert.equal(h.saved.length, 2, "the publish did not write the queue entry and then the venue");
    assert.equal(h.saved.at(-1)!.venues[0]!.publish?.secret, pub.secret);
    assert.deepEqual(h.saved.at(-1)!.pendingRemovals, []);
  });

  test("20 plots on 20 backgrounds: every request is under the cap and the Worker holds all 41 keys", async () => {
    // 500 items with eight inputs each is a heavy plot; 20 of them, each on its own background near 2 MB.
    const heavy = (i: number) => Array.from({ length: 500 }, (_, j) => item(`i-${i}-${j}`, { label: "Floor wedge", notes: "n".repeat(100), inputs: Array.from({ length: 8 }, (_, k) => `Input ${k} ${"x".repeat(30)}`) }));
    const h = await harness(venueDoc(20, 20, heavy));
    for (const k of h.images.keys()) h.images.set(k, webp(PUBLISH_MAX_BODY_BYTES - 10));
    const r = await h.publisher.publish("v-1");
    assert.ok(r.ok, r.ok ? "" : r.error);
    const pub = (await h.venue()).publish!;
    assert.equal(h.page.hub.stagePlotKeys(pub.secret).length, 41);
    assert.deepEqual(pub.unpublishedImages, []);
    for (const q of spRequests(h.page)) assert.ok(q.r.bytes.length <= PUBLISH_MAX_BODY_BYTES, `${q.method} ${q.key} is ${q.r.bytes.length} bytes`);
  });

  test("a background the page refuses is listed as not yet published, its plot is drawn without it, and Publish now sends it", async () => {
    const h = await harness(venueDoc(2, 2));
    let refuse = true;
    h.page.respond = (req) => (refuse && req.path.endsWith(`/image/${hash(2)}`) ? { status: 413, body: '{"error":"too large"}' } : h.page.worker(req));
    const r = await h.publisher.publish("v-1");
    assert.ok(r.ok, "one background refused is not a failed publish");
    let pub = (await h.venue()).publish!;
    assert.deepEqual(pub.unpublishedImages, [hash(2)]);
    assert.deepEqual(pub.publishedImages, [hash(1)]);
    assert.match(pub.lastError?.message ?? "", /1 background not yet published/);
    const plot = JSON.parse((await visit(h.page, pub.secret, "plot/p-1")).body) as PublishedPlot;
    assert.deepEqual(plot.background, { hash: null, width: 2400, height: 1600 }, "a plot named a background the page does not hold");

    refuse = false;
    const again = await h.publisher.publishNow("v-1");
    assert.ok(again.ok, again.ok ? "" : again.error);
    pub = (await h.venue()).publish!;
    assert.deepEqual(pub.unpublishedImages, []);
    assert.deepEqual(pub.publishedImages, [hash(1), hash(2)]);
    assert.equal(pub.lastError, null);
    assert.equal((JSON.parse((await visit(h.page, pub.secret, "plot/p-1")).body) as PublishedPlot).background?.hash, hash(2));
  });

  test("a plot over the size limit is refused by name and nothing is sent", async () => {
    // Legal in the editor: 500 items of 64 inputs of 40 three-byte characters is near 4 MB of JSON.
    const huge = () => Array.from({ length: 500 }, (_, j) => item(`i-${j}`, { inputs: Array.from({ length: 64 }, () => "あ".repeat(40)) }));
    const h = await harness(venueDoc(1, 1, huge));
    const r = await h.publisher.publish("v-1");
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /^Plot "Plot 0" is too large to publish \(\d+\.\d MB; the limit is 2\.0 MB\)/);
    assert.equal(spRequests(h.page).length, 0, "a request was sent for a publish that could not complete");
    assert.equal((await h.venue()).publish, undefined);
  });

  test("a Worker from before StagePlots reads as deploy the Worker, and the venue stays unpublished", async () => {
    const h = await harness();
    // What an old Worker answers every path under /_publish/v1/stageplots/: its generic 404.
    h.page.respond = (req) => (SP.test(req.path) ? { status: 404, body: '{"error":"Not found"}' } : h.page.worker(req));
    const r = await h.publisher.publish("v-1");
    assert.equal(r.ok, false);
    assert.equal(r.ok ? "" : r.error, `${host(h.page)} does not know StagePlots yet: deploy the Worker.`);
    assert.equal((await h.venue()).publish, undefined);
    // Nothing went up on a Worker that answers every StagePlots path 404: nothing to take back.
    assert.deepEqual(spRequests(h.page).map((q) => q.method), ["PUT"], "it went on, or tried to take back what an old Worker never stored");
  });

  test("a page that cannot be reached says so in a sentence, and the venue stays unpublished", async () => {
    const h = await harness();
    const where = host(h.page);
    await h.page.close();
    const r = await h.publisher.publish("v-1");
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, new RegExp(`^${where.replace(/\./g, "\\.")} could not be reached: .+\\.$`));
    assert.equal((await h.venue()).publish, undefined);
  });

  test("with no page address or token, says where to set them and sends nothing", async () => {
    const h = await harness(venueDoc(), { target: async () => ({ ok: false, message: "Set up the Public link first." }) });
    const r = await h.publisher.publish("v-1");
    assert.deepEqual(r.ok ? null : r.error, "Set up the Public link first.");
    assert.equal(h.page.requests.length, 0);
  });

  test("a page that does not answer leaves the venue unpublished and says so", async () => {
    const h = await harness();
    h.page.respond = (req) => (SP.test(req.path) ? { status: 503, body: "" } : h.page.worker(req));
    const r = await h.publisher.publish("v-1");
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /503/);
    assert.equal((await h.venue()).publish, undefined);
  });
});

describe("regenerating the link", () => {
  test("publishes the new secret fully before deleting anything under the old", async () => {
    const h = await harness(venueDoc(2, 2));
    assert.ok((await h.publisher.publish("v-1")).ok);
    const old = (await h.venue()).publish!.secret;
    const before = h.page.requests.length;
    const r = await h.publisher.regenerate("v-1");
    assert.ok(r.ok, r.ok ? "" : r.error);
    const pub = (await h.venue()).publish!;
    assert.notEqual(pub.secret, old);
    assert.deepEqual(await pending(), []);
    const after = spRequests({ ...h.page, requests: h.page.requests.slice(before) } as Receiver);
    const firstOld = after.findIndex((q) => q.secret === old);
    const lastNew = after.map((q) => q.secret === pub.secret).lastIndexOf(true);
    assert.ok(firstOld > lastNew, "something under the old secret was touched before the new one was fully up");
    assert.deepEqual(
      after.filter((q) => q.secret === old).map((q) => `${q.method} ${q.key ?? ""}`),
      ["DELETE "],
    );
    assert.equal(h.page.hub.stagePlotKeys(old).length, 0, "the old link still has something behind it");
    assert.equal(h.page.hub.stagePlotKeys(pub.secret).length, 5);
    assert.equal((await visit(h.page, old, "index")).status, 404);
  });

  test("a failure under the new secret keeps the old one live, records the error, and leaves nothing under the new", async () => {
    const h = await harness(venueDoc(2, 2));
    assert.ok((await h.publisher.publish("v-1")).ok);
    const old = (await h.venue()).publish!.secret;
    // Every background under the new secret is refused: "fully" includes them.
    h.page.respond = (req) => {
      const m = SP.exec(req.path);
      return m && m[1] !== old && req.method === "PUT" && m[2]?.startsWith("image/") ? { status: 500, body: "" } : h.page.worker(req);
    };
    const r = await h.publisher.regenerate("v-1");
    assert.equal(r.ok, false);
    const pub = (await h.venue()).publish!;
    assert.equal(pub.secret, old, "the venue lost the link that still works");
    assert.match(pub.lastError?.message ?? "", /The link was not changed/);
    assert.equal(spRequests(h.page).some((q) => q.secret === old && q.method === "DELETE"), false);
    assert.equal((await visit(h.page, old, "index")).status, 200);
    const fresh = spRequests(h.page).map((q) => q.secret).filter((s) => s !== old);
    for (const s of new Set(fresh)) assert.equal(h.page.hub.stagePlotKeys(s).length, 0, "the half-published new secret was left on the page");
  });

  test("when the old link cannot be removed it is kept and removed by Publish now", async () => {
    const h = await harness();
    assert.ok((await h.publisher.publish("v-1")).ok);
    const old = (await h.venue()).publish!.secret;
    let fail = true;
    h.page.respond = (req) => (fail && req.method === "DELETE" && req.path === `/_publish/v1/stageplots/${old}` ? { status: 500, body: "" } : h.page.worker(req));
    const r = await h.publisher.regenerate("v-1");
    assert.ok(r.ok, "the new link is up, so the regenerate went through");
    assert.deepEqual((await pending()).map((e) => [e.secret === old, e.reason]), [[true, "regenerated"]]);
    assert.equal((await visit(h.page, old, "index")).status, 200);
    // An ordinary change tries again, and failing again writes nothing.
    const saves = h.saved.length;
    await h.edit((d) => ({ ...d, plots: d.plots.map((p) => ({ ...p, name: `${p.name}!`, version: p.version + 1 })) }));
    await h.publisher.settle();
    assert.equal((await pending()).length, 1, "the old link left the queue while it is still live");
    assert.equal(h.saved.length, saves + 1, "a failed removal wrote to the store");
    fail = false;
    assert.ok((await h.publisher.publishNow("v-1")).ok);
    assert.deepEqual(await pending(), []);
    assert.equal((await visit(h.page, old, "index")).status, 404);
  });
});

describe("unpublishing", () => {
  test("deletes every key under the secret and clears it", async () => {
    const h = await harness(venueDoc(2, 2));
    assert.ok((await h.publisher.publish("v-1")).ok);
    const secret = (await h.venue()).publish!.secret;
    const r = await h.publisher.unpublish("v-1");
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal((await h.venue()).publish, undefined);
    assert.equal(h.page.hub.stagePlotKeys(secret).length, 0);
    assert.equal((await visit(h.page, secret, "index")).status, 404);
  });

  test("a delete that fails keeps the venue published and says the link still works", async () => {
    const h = await harness();
    assert.ok((await h.publisher.publish("v-1")).ok);
    const secret = (await h.venue()).publish!.secret;
    h.page.respond = (req) => (req.method === "DELETE" ? { status: 500, body: "" } : h.page.worker(req));
    const r = await h.publisher.unpublish("v-1");
    assert.equal(r.ok, false);
    const pub = (await h.venue()).publish!;
    assert.equal(pub.secret, secret);
    assert.match(pub.lastError?.message ?? "", /the link still works/);
    assert.equal((await visit(h.page, secret, "index")).status, 200);
  });
});

describe("republishing on a change", () => {
  const plotPuts = (h: Harness, from: number) =>
    spRequests({ ...h.page, requests: h.page.requests.slice(from) } as Receiver).filter((q) => q.method === "PUT" && q.key === "plot/p-0");

  test("two quick changes give one republish, and a change during a republish is not lost", async () => {
    const h = await harness();
    assert.ok((await h.publisher.publish("v-1")).ok);
    await h.publisher.settle();
    const mark = h.page.requests.length;
    await h.edit((d) => ({ ...d, plots: d.plots.map((p) => (p.id === "p-0" ? { ...p, name: "First", version: p.version + 1 } : p)) }));
    await h.edit((d) => ({ ...d, plots: d.plots.map((p) => (p.id === "p-0" ? { ...p, name: "Second", version: p.version + 1 } : p)) }));
    await h.publisher.settle();
    assert.equal(plotPuts(h, mark).length, 1, "two changes inside the wait were published twice");
    const secret = (await h.venue()).publish!.secret;
    assert.equal((JSON.parse((await visit(h.page, secret, "plot/p-0")).body) as PublishedPlot).name, "Second");

    // A third change while that plot is on its way.
    const mark2 = h.page.requests.length;
    h.page.respond = (req) => h.page.worker(req, { delayMs: 120 });
    await h.edit((d) => ({ ...d, plots: d.plots.map((p) => (p.id === "p-0" ? { ...p, name: "Third", version: p.version + 1 } : p)) }));
    await waitFor(() => plotPuts(h, mark2).length >= 1, "the republish to start");
    await h.edit((d) => ({ ...d, plots: d.plots.map((p) => (p.id === "p-0" ? { ...p, name: "Fourth", version: p.version + 1 } : p)) }));
    await h.publisher.settle();
    assert.equal((JSON.parse((await visit(h.page, secret, "plot/p-0")).body) as PublishedPlot).name, "Fourth", "the change made during a republish was lost");
  });

  test("a change that alters nothing published sends nothing and writes nothing", async () => {
    const h = await harness();
    assert.ok((await h.publisher.publish("v-1")).ok);
    await h.publisher.settle();
    const requests = h.page.requests.length;
    const saves = h.saved.length;
    for (let i = 0; i < 3; i++) h.hear("stageplots:updated");
    h.hear("stage:state-changed");
    await h.publisher.settle();
    assert.equal(h.page.requests.length, requests, "a republish was sent for a document that had not changed");
    assert.equal(h.saved.length, saves, "the venue was written for a republish that sent nothing");
  });

  test("the followed plan moving to one with an override republishes the index", async () => {
    const doc = venueDoc(2, 2);
    doc.overrides = [{ planId: "9001", venueId: "v-1", plotId: "p-1", planDate: "2026-11-15T15:00:00.000Z" }];
    const h = await harness(doc);
    assert.ok((await h.publisher.publish("v-1")).ok);
    await h.publisher.settle();
    h.plan.planId = "9001";
    h.plan.planDates = "November 15, 2026";
    h.hear("stage:state-changed");
    await h.publisher.settle();
    const secret = (await h.venue()).publish!.secret;
    const index = JSON.parse((await visit(h.page, secret, "index")).body) as PublishedVenue;
    assert.deepEqual(index.shown, { plotId: "p-1", reason: "plan" });
    assert.deepEqual(index.plan, { date: "2026-11-15T15:00:00.000Z", dates: "November 15, 2026" });
  });

  // A wait that is replaced or cancelled must still let settle() return: a settle that never
  // returns hangs whatever awaits it (the route suite once never finished on this). Raced
  // against a deadline, so a regression is a failure here, not a hang.
  const settles = async (p: InstanceType<typeof StagePlotsPublisher>, what: string) => {
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`settle() never returned after ${what}`)), 2000)));
    try {
      await Promise.race([p.settle(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  };

  for (const [what, then] of [
    ["a second change replaced the wait", (p: InstanceType<typeof StagePlotsPublisher>) => p.changed()],
    ["a pause cancelled the wait", (p: InstanceType<typeof StagePlotsPublisher>) => void p.pause()],
    ["a stop cancelled the wait", (p: InstanceType<typeof StagePlotsPublisher>) => void p.stop()],
  ] as const) {
    test(`settle() returns when ${what} it was waiting on`, async () => {
      const h = await harness();
      assert.ok((await h.publisher.publish("v-1")).ok);
      await h.publisher.settle();
      h.publisher.changed();
      const waiting = settles(h.publisher, what);
      then(h.publisher);
      await waiting;
    });
  }

  test("a plot deleted from the venue, and the background only it drew, leave the page", async () => {
    const h = await harness(venueDoc(2, 2));
    assert.ok((await h.publisher.publish("v-1")).ok);
    await h.publisher.settle();
    await h.edit((d) => ({
      ...d,
      plots: d.plots.filter((p) => p.id !== "p-1"),
      venues: d.venues.map((v) => ({ ...v, plotIds: ["p-0"] })),
    }));
    await h.publisher.settle();
    const pub = (await h.venue()).publish!;
    assert.deepEqual(h.page.hub.stagePlotKeys(pub.secret).sort(), ["image/0000000000000001", "index", "plot/p-0"]);
    assert.deepEqual(pub.publishedImages, [hash(1)]);
  });
});

describe("what goes wrong in the background", () => {
  test("a republish that throws (settings unreadable) is logged on [stageplots] and never escapes as an unhandled rejection", async () => {
    let throwNow = false;
    const lines: string[] = [];
    const spy = mock.method(console, "error", (...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => void rejections.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      let h!: Harness;
      h = await harness(venueDoc(), {
        target: async () => {
          if (throwNow) throw new Error("secrets.bin could not be read");
          const parsed = parsePublishUrl(h.page.origin);
          return parsed.ok ? { ok: true, origin: parsed.origin, token: TOKEN } : { ok: false, message: "no" };
        },
      });
      assert.ok((await h.publisher.publish("v-1")).ok);
      await h.publisher.settle();
      throwNow = true;
      await h.edit((d) => ({ ...d, plots: d.plots.map((p) => ({ ...p, name: `${p.name}!`, version: p.version + 1 })) }));
      await h.publisher.settle();
      await new Promise((r) => setImmediate(r));
    } finally {
      spy.mock.restore();
      process.off("unhandledRejection", onRejection);
    }
    assert.deepEqual(rejections, [], "a background republish rejected with nobody to hear it");
    assert.ok(lines.some((l) => l.includes("[stageplots]") && l.includes("secrets.bin could not be read")), `nothing said it on [stageplots]: ${lines.join(" / ")}`);
  });

  test("a failure sentence too long for the store is cut to fit, so the publish it describes is still saved", async () => {
    const h = await harness(venueDoc(2, 2));
    const long = "x".repeat(1000);
    const orig = h.images.get.bind(h.images);
    (h.images as unknown as { get: (k: string) => Uint8Array | undefined }).get = (k: string) => {
      if (k === hash(2)) throw new Error(long);
      return orig(k);
    };
    const r = await h.publisher.publish("v-1");
    assert.ok(r.ok, r.ok ? "" : r.error);
    const pub = (await h.venue()).publish!;
    assert.deepEqual(pub.unpublishedImages, [hash(2)]);
    assert.ok(pub.lastError && pub.lastError.message.length <= 600, `stored ${pub.lastError?.message.length} characters`);
  });
});

describe("taking back what went up", () => {
  /** Answers 500 to the index under any secret but `keep`, after the backgrounds and plots went in. */
  const failIndex = (h: Harness, keep: string | null = null) =>
    (h.page.respond = (req) => {
      const m = SP.exec(req.path);
      return m && m[1] !== keep && m[2] === "index" && req.method === "PUT" ? { status: 500, body: "" } : h.page.worker(req);
    });

  test("a publish that fails at the index takes back the backgrounds and plots it had put up", async () => {
    const h = await harness(venueDoc(2, 2));
    failIndex(h);
    const r = await h.publisher.publish("v-1");
    assert.equal(r.ok, false);
    const secrets = new Set(spRequests(h.page).map((q) => q.secret));
    assert.equal(secrets.size, 1);
    for (const s of secrets) assert.deepEqual(h.page.hub.stagePlotKeys(s), [], "what went up before the failure was left on the page");
  });

  test("a regenerate that fails at the index takes back what it put up under the new secret, and keeps the old", async () => {
    const h = await harness(venueDoc(2, 2));
    assert.ok((await h.publisher.publish("v-1")).ok);
    const old = (await h.venue()).publish!.secret;
    failIndex(h, old);
    assert.equal((await h.publisher.regenerate("v-1")).ok, false);
    for (const s of new Set(spRequests(h.page).map((q) => q.secret))) {
      if (s !== old) assert.deepEqual(h.page.hub.stagePlotKeys(s), [], "what went up under the new secret was left on the page");
    }
    assert.equal((await visit(h.page, old, "index")).status, 200);
  });
});

describe("a venue deleted while it is being sent", () => {
  // The delete route unpublishes on the venue's chain first, so a venue can only vanish under a
  // send that began after that: a publish, a regenerate or a move. Its new secret is still
  // queued, so the standing check after each test cannot see a take-back that never happened;
  // each asserts the page holds nothing under the new secret, and the queue no trace of it.
  /** On the index PUT under any secret but `keep`, delete the venue first, as the route's write would. */
  const deleteOnIndex = (page: Receiver, keep: string | null = null, queueOld?: { origin: string }) =>
    (page.respond = async (req) => {
      const m = SP.exec(req.path);
      if (m && m[1] !== keep && m[2] === "index" && req.method === "PUT") {
        await stageplotsStore.update((d) => ({
          ...d,
          venues: [],
          plots: [],
          overrides: [],
          // The old link of a published venue goes to the queue with it, as retireForDelete does.
          pendingRemovals: keep && queueOld ? [...d.pendingRemovals, { secret: keep, origin: queueOld.origin, since: "2026-11-13T10:00:00.000Z", reason: "venue deleted" as const }] : d.pendingRemovals,
        }));
      }
      return page.worker(req);
    });
  const newSecrets = (page: Receiver, old: string | null) => [...new Set(spRequests(page).map((q) => q.secret))].filter((s) => s !== old);
  const assertTakenBack = async (page: Receiver, old: string | null) => {
    const fresh = newSecrets(page, old);
    assert.equal(fresh.length, 1);
    assert.deepEqual(page.hub.stagePlotKeys(fresh[0]!), [], "what went up under the new secret was left on the page");
    assert.equal((await pending()).some((e) => e.secret === fresh[0]), false, "the new secret is still queued");
  };

  test("a publish takes back what it put up", async () => {
    const h = await harness();
    deleteOnIndex(h.page);
    const r = await h.publisher.publish("v-1");
    assert.deepEqual(r, { ok: false, status: 404, error: "no such venue" });
    await assertTakenBack(h.page, null);
  });

  test("a regenerate takes back what it put up under the new secret", async () => {
    const h = await harness();
    assert.ok((await h.publisher.publish("v-1")).ok);
    const old = (await h.venue()).publish!.secret;
    const o = parsePublishUrl(h.page.origin);
    assert.ok(o.ok);
    deleteOnIndex(h.page, old, { origin: o.origin });
    const r = await h.publisher.regenerate("v-1");
    assert.deepEqual(r, { ok: false, status: 404, error: "no such venue" });
    await assertTakenBack(h.page, old);
  });

  test("a move to a new page takes back what it put up there", async () => {
    const h = await harness();
    assert.ok((await h.publisher.publish("v-1")).ok);
    const old = (await h.venue()).publish!.secret;
    const oldOrigin = parsePublishUrl(h.page.origin);
    const other = await startPage();
    const parsed = parsePublishUrl(other.origin);
    assert.ok(parsed.ok && oldOrigin.ok);
    (h.publisher as unknown as { deps: { target: () => Promise<unknown> } }).deps.target = async () => ({ ok: true, origin: parsed.origin, token: TOKEN });
    deleteOnIndex(other, old, { origin: oldOrigin.origin });
    const r = await h.publisher.publishNow("v-1");
    assert.deepEqual(r, { ok: false, status: 404, error: "no such venue" });
    await assertTakenBack(other, null);
  });
});

describe("a restore landing behind a run in flight", () => {
  test("an action queued behind it answers 503, and sends nothing", async () => {
    const h = await harness();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    h.page.respond = async (req) => {
      if (SP.exec(req.path)?.[2] === "index" && req.method === "PUT") await held;
      return h.page.worker(req);
    };
    const first = h.publisher.publish("v-1");
    await waitFor(() => spRequests(h.page).some((q) => q.key === "index"), "the publish to reach its index");
    const queued = h.publisher.publishNow("v-1");
    const pausing = h.publisher.pause();
    release();
    assert.ok((await first).ok);
    const sent = h.page.requests.length;
    const r = await queued;
    const resume = await pausing;
    resume();
    assert.deepEqual(r.ok ? null : [r.status, /restore is under way/.test(r.error)], [503, true]);
    assert.equal(h.page.requests.length, sent, "the queued action ran with the restore landing");
  });
});

describe("the write that lands a send failing", () => {
  // The page took everything; the write that puts the new link on the venue then fails. Without a
  // take-back the new secret stays live under a "publishing" entry the card hides until a restart.
  /** The publisher's store, with the next write that moves a publishing secret onto a venue failing. */
  function failLanding(h: Harness) {
    (h.publisher as unknown as { deps: { store: unknown } }).deps.store = {
      get: () => stageplotsStore.get(),
      update: (fn: (d: StagePlotsDoc) => StagePlotsDoc) =>
        stageplotsStore.update((d) => {
          const next = fn(d);
          const inFlight = new Set(d.pendingRemovals.filter((e) => e.reason === "publishing").map((e) => e.secret));
          if (next.venues.some((v) => v.publish && inFlight.has(v.publish.secret))) throw new Error("disk full");
          return next;
        }),
    };
  }
  const freshOn = (page: Receiver, old: string | null) => [...new Set(spRequests(page).map((q) => q.secret))].filter((x) => x !== old);
  const quietly = async <T,>(run: () => Promise<T>): Promise<T> => {
    const q = [mock.method(console, "error", () => undefined), mock.method(console, "warn", () => undefined)];
    try {
      return await run();
    } finally {
      for (const m of q) m.mock.restore();
    }
  };

  test("a publish takes the new link back and says why", async () => {
    const h = await harness();
    failLanding(h);
    const r = await quietly(() => h.publisher.publish("v-1"));
    assert.deepEqual(r.ok ? null : [r.status, r.error.startsWith("What went up could not be saved here (disk full)")], [503, true]);
    const [fresh] = freshOn(h.page, null);
    assert.deepEqual(h.page.hub.stagePlotKeys(fresh!), [], "the new link is still live");
    assert.deepEqual(await pending(), []);
    assert.equal((await h.venue()).publish, undefined);
  });

  test("a regenerate takes the new link back, keeps the old, and the card says why", async () => {
    const h = await harness();
    assert.ok((await h.publisher.publish("v-1")).ok);
    const old = (await h.venue()).publish!.secret;
    failLanding(h);
    const r = await quietly(() => h.publisher.regenerate("v-1"));
    assert.equal(r.ok ? 0 : r.status, 503);
    const [fresh] = freshOn(h.page, old);
    assert.deepEqual(h.page.hub.stagePlotKeys(fresh!), [], "the new link is still live");
    const pub = (await h.venue()).publish!;
    assert.equal(pub.secret, old);
    assert.match(pub.lastError?.message ?? "", /^The link was not changed: What went up could not be saved here \(disk full\)/);
    assert.equal((await visit(h.page, old, "index")).status, 200);
  });

  test("a move takes the new link back from the new page, and the venue stays where it was", async () => {
    const h = await harness();
    assert.ok((await h.publisher.publish("v-1")).ok);
    const old = (await h.venue()).publish!.secret;
    const o = parsePublishUrl(h.page.origin);
    const other = await startPage();
    const parsed = parsePublishUrl(other.origin);
    assert.ok(o.ok && parsed.ok);
    (h.publisher as unknown as { deps: { target: () => Promise<unknown> } }).deps.target = async () => ({ ok: true, origin: parsed.origin, token: TOKEN });
    failLanding(h);
    const r = await quietly(() => h.publisher.publishNow("v-1"));
    assert.equal(r.ok ? 0 : r.status, 503);
    const [fresh] = freshOn(other, null);
    assert.deepEqual(other.hub.stagePlotKeys(fresh!), [], "the new link is still live on the new page");
    const pub = (await h.venue()).publish!;
    assert.deepEqual([pub.origin, pub.secret], [o.origin, old]);
    assert.match(pub.lastError?.message ?? "", /^Not moved to 127\.0\.0\.1:\d+: What went up could not be saved here \(disk full\)/);
  });
});

describe("the log", () => {
  test("a venue name with a line break in it never breaks a [stageplots] line, and is still legible", async () => {
    const doc = venueDoc();
    doc.venues[0]!.name = "Main room\n[updater] update installed";
    const lines: string[] = [];
    const spies = (["log", "warn", "error"] as const).map((level) => mock.method(console, level, (...a: unknown[]) => void lines.push(a.map(String).join(" "))));
    try {
      const h = await harness(doc);
      assert.ok((await h.publisher.publish("v-1")).ok);
      h.page.respond = (req) => (req.method === "DELETE" ? { status: 500, body: "" } : h.page.worker(req));
      await h.publisher.unpublish("v-1");
    } finally {
      for (const sp of spies) sp.mock.restore();
    }
    const ours = lines.filter((l) => l.startsWith("[stageplots]"));
    assert.ok(ours.length >= 2, lines.join(" / "));
    for (const l of ours) assert.doesNotMatch(l, /[\n\r]/, `a [stageplots] line was broken in two: ${JSON.stringify(l)}`);
    assert.ok(ours.some((l) => l.includes("Main room\\n[updater] update installed")), `the name is not legible: ${ours.join(" / ")}`);
  });
});

describe("the page's own words", () => {
  test("a failure that names the request's path never reaches a log line, an answer or a stored error with the secret in it", async () => {
    const { createPushClient } = await import("./servicecue-publish-client.js");
    // A seam, since the real client discards what a refusal's body says: this one repeats the
    // path it sent to, as a page or a proxy in front of it might.
    const echoing = (t: { origin: string; token: string }) => {
      const c = createPushClient(t as never);
      return {
        ...c,
        putStagePlot: async (secret: string, key: string, body: string | Uint8Array, type: string) => {
          const r = await c.putStagePlot(secret, key, body, type);
          return r.ok ? r : { ...r, message: `${r.message} (PUT /_publish/v1/stageplots/${secret}/${key})` };
        },
      };
    };
    const lines: string[] = [];
    const spies = (["log", "warn", "error"] as const).map((level) => mock.method(console, level, (...a: unknown[]) => void lines.push(a.map(String).join(" "))));
    let h!: Harness;
    try {
      h = await harness(venueDoc(2, 2), { client: echoing });
      h.page.respond = (req) => (SP.test(req.path) && req.path.endsWith("/index") ? { status: 413, body: "" } : h.page.worker(req));
      const r = await h.publisher.publish("v-1");
      assert.equal(r.ok, false);
      lines.push(r.ok ? "" : r.error);
    } finally {
      for (const sp of spies) sp.mock.restore();
    }
    const secrets = new Set(spRequests(h.page).map((q) => q.secret));
    assert.ok(lines.some((l) => l.includes("PUT /_publish/v1/stageplots/<secret>/index")), `the path was not repeated at all: ${lines.join(" / ")}`);
    for (const s of secrets) for (const l of lines) assert.equal(l.includes(s), false, `a line names the secret: ${l}`);
  });
});

describe("refusals", () => {
  test("each action refused before a request goes out is said on [stageplots]", async () => {
    const h = await harness(venueDoc(), { target: async () => ({ ok: false, message: "Set up the public link first." }) });
    const lines: string[] = [];
    const spy = mock.method(console, "warn", (...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    try {
      await h.publisher.publish("v-1");
      await h.publisher.unpublish("v-1");
      await h.publisher.publish("v-nope");
    } finally {
      spy.mock.restore();
    }
    assert.deepEqual(lines, [
      '[stageplots] Publish refused for "Main room": Set up the public link first.',
      '[stageplots] Unpublish refused for "Main room": Main room is not published',
      "[stageplots] Publish refused for venue v-nope: no such venue",
    ]);
  });
});

describe("regenerating needs what the old link held, and no more", () => {
  test("a background the old link never had does not stop the link moving", async () => {
    const h = await harness(venueDoc(2, 2));
    h.page.respond = (req) => (req.path.endsWith(`/image/${hash(2)}`) ? { status: 413, body: "" } : h.page.worker(req));
    assert.ok((await h.publisher.publish("v-1")).ok);
    const old = (await h.venue()).publish!;
    assert.deepEqual(old.unpublishedImages, [hash(2)]);
    const r = await h.publisher.regenerate("v-1");
    assert.ok(r.ok, r.ok ? "" : r.error);
    const pub = (await h.venue()).publish!;
    assert.notEqual(pub.secret, old.secret);
    assert.deepEqual(pub.publishedImages, [hash(1)]);
    assert.deepEqual(pub.unpublishedImages, [hash(2)]);
    assert.equal((await visit(h.page, old.secret, "index")).status, 404);
  });
});

describe("after the page address changes", () => {
  /** Publish to the harness's page, then point the publisher at a second page, as saving a new address does. */
  async function moved() {
    const h = await harness();
    assert.ok((await h.publisher.publish("v-1")).ok);
    const other = await startPage();
    const parsed = parsePublishUrl(other.origin);
    assert.ok(parsed.ok);
    (h.publisher as unknown as { deps: { target: () => Promise<unknown> } }).deps.target = async () => ({ ok: true, origin: parsed.origin, token: TOKEN });
    return { h, other, oldHost: host(h.page) };
  }
  /** A secret live on `page` and queued against it, as an old link waiting to be removed. */
  async function queuedOn(page: Receiver, origin: string, i: number): Promise<string> {
    const secret = `${i.toString(36).padStart(42, "A")}E`;
    await page.worker({ method: "PUT", path: `/_publish/v1/stageplots/${secret}/index`, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: "{}", bytes: Buffer.from("{}"), at: 0 });
    assert.equal(page.hub.stagePlotKeys(secret).length, 1);
    await stageplotsStore.update((d) => ({ ...d, pendingRemovals: [...d.pendingRemovals, { secret, origin, since: "2026-11-13T10:00:00.000Z", reason: "regenerated" }] }));
    return secret;
  }
  const leftOnRe = (oldHost: string) => new RegExp(`left on ${oldHost.replace(/\./g, "\\.")}`);
  const capture = () => {
    const lines: string[] = [];
    const spies = (["log", "warn"] as const).map((level) => mock.method(console, level, (...args: unknown[]) => void lines.push(args.map(String).join(" "))));
    return { lines, restore: () => spies.forEach((s) => s.mock.restore()) };
  };

  test("following the same page address with its settings unreadable says so on the venue's card, and still drains the page with its token", async () => {
    const h = await harness();
    assert.ok((await h.publisher.publish("v-1")).ok);
    const o = parsePublishUrl(h.page.origin);
    assert.ok(o.ok);
    const stale = await queuedOn(h.page, o.origin, 11);
    (h.publisher as unknown as { deps: { target: () => Promise<unknown> } }).deps.target = async () => {
      throw new Error("secrets store unreadable");
    };
    const quiet = mock.method(console, "error", () => undefined);
    try {
      await h.publisher.pageSaved({ origin: o.origin, token: TOKEN }, o.origin);
      await h.publisher.settle();
    } finally {
      quiet.mock.restore();
    }
    assert.match((await h.venue()).publish?.lastError?.message ?? "", /^The page address was saved, but the published stage plots could not follow it: the page settings could not be read: secrets store unreadable$/);
    assert.deepEqual(h.page.hub.stagePlotKeys(stale), [], "the old page's queue was not drained with its token");
    assert.equal((await pending()).some((e) => e.secret === stale), false);
  });

  test("a move that throws is on that venue's card, and the old page is still drained with its token", async () => {
    const h = await harness();
    assert.ok((await h.publisher.publish("v-1")).ok);
    const first = (await h.venue()).publish!.secret;
    const o = parsePublishUrl(h.page.origin);
    const other = await startPage();
    const parsed = parsePublishUrl(other.origin);
    assert.ok(o.ok && parsed.ok);
    const stale = await queuedOn(h.page, o.origin, 12);
    const deps = (h.publisher as unknown as { deps: { target: () => Promise<unknown>; store: unknown } }).deps;
    deps.target = async () => ({ ok: true, origin: parsed.origin, token: TOKEN });
    // The write that queues the new secret before its first request fails, once.
    let fail = true;
    deps.store = {
      get: () => stageplotsStore.get(),
      update: (fn: (d: StagePlotsDoc) => StagePlotsDoc) =>
        stageplotsStore.update((d) => {
          const next = fn(d);
          if (fail && next.pendingRemovals.some((e) => e.reason === "publishing")) {
            fail = false;
            throw new Error("disk full");
          }
          return next;
        }),
    };
    const quiet = mock.method(console, "error", () => undefined);
    try {
      await h.publisher.pageSaved({ origin: o.origin, token: TOKEN }, parsed.origin);
      await h.publisher.settle();
    } finally {
      quiet.mock.restore();
    }
    const pub = (await h.venue()).publish!;
    assert.deepEqual([pub.origin, pub.secret], [o.origin, first], "the venue left a page that still serves it");
    assert.match(pub.lastError?.message ?? "", /^Not moved to 127\.0\.0\.1:\d+: disk full$/);
    assert.deepEqual(h.page.hub.stagePlotKeys(stale), [], "the old page's queue was not drained with its token");
  });

  /** The publisher's store, with the next read or the next unpublishing write made to fail once. */
  function failing(h: Harness) {
    const f = { get: false, unpublish: false, gets: 0 };
    (h.publisher as unknown as { deps: { store: unknown } }).deps.store = {
      get: () => {
        if (f.get || f.gets > 0) {
          f.get = false;
          f.gets = Math.max(0, f.gets - 1);
          return Promise.reject(new Error("disk went away"));
        }
        return stageplotsStore.get();
      },
      update: (fn: (d: StagePlotsDoc) => StagePlotsDoc) =>
        stageplotsStore.update((d) => {
          const next = fn(d);
          if (f.unpublish && d.venues.some((v) => v.publish) && !next.venues.some((v) => v.publish)) {
            f.unpublish = false;
            throw new Error("disk full");
          }
          return next;
        }),
    };
    return f;
  }

  for (const [what, moving] of [
    ["a move to the new page", true],
    ["a take-down with no new page", false],
  ] as const) {
    test(`${what} that cannot read the stage plots says so on the card, and still drains the old page with its token`, async () => {
      const h = await harness();
      assert.ok((await h.publisher.publish("v-1")).ok);
      const o = parsePublishUrl(h.page.origin);
      const other = await startPage();
      const parsed = parsePublishUrl(other.origin);
      assert.ok(o.ok && parsed.ok);
      const stale = await queuedOn(h.page, o.origin, 13);
      (h.publisher as unknown as { deps: { target: () => Promise<unknown> } }).deps.target = async () =>
        moving ? { ok: true, origin: parsed.origin, token: TOKEN } : { ok: false, message: "Set up the public link first." };
      const f = failing(h);
      const quiet = mock.method(console, "error", () => undefined);
      try {
        f.get = true;
        await h.publisher.pageSaved({ origin: o.origin, token: TOKEN }, moving ? parsed.origin : null);
        await h.publisher.settle();
      } finally {
        quiet.mock.restore();
      }
      assert.match((await h.venue()).publish?.lastError?.message ?? "", /^The page address was saved, but the published stage plots could not follow it: the stage plots could not be read: disk went away$/);
      assert.deepEqual(h.page.hub.stagePlotKeys(stale), [], "the old page's queue was not drained with its token");
    });
  }

  test("a take-down whose unpublish cannot be saved says so on the card, and still drains the old page with its token", async () => {
    const h = await harness();
    assert.ok((await h.publisher.publish("v-1")).ok);
    const o = parsePublishUrl(h.page.origin);
    assert.ok(o.ok);
    const stale = await queuedOn(h.page, o.origin, 14);
    (h.publisher as unknown as { deps: { target: () => Promise<unknown> } }).deps.target = async () => ({ ok: false, message: "Set up the public link first." });
    const f = failing(h);
    const quiet = mock.method(console, "error", () => undefined);
    try {
      f.unpublish = true;
      await h.publisher.pageSaved({ origin: o.origin, token: TOKEN }, null);
      await h.publisher.settle();
    } finally {
      quiet.mock.restore();
    }
    assert.match((await h.venue()).publish?.lastError?.message ?? "", /^The page address changed, and taking its link down from 127\.0\.0\.1:\d+ failed part way: disk full$/);
    assert.deepEqual(h.page.hub.stagePlotKeys(stale), [], "the old page's queue was not drained with its token");
  });

  const setTarget = (h: Harness, t: () => Promise<unknown>) => ((h.publisher as unknown as { deps: { target: () => Promise<unknown> } }).deps.target = t);
  /** Hold every index PUT `page` gets until the answer is released. */
  const holdIndex = (page: Receiver) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    page.respond = async (req) => {
      if (SP.exec(req.path)?.[2] === "index" && req.method === "PUT") await held;
      return page.worker(req);
    };
    return release;
  };

  for (const [what, moving] of [
    ["moves it to the new page", true],
    ["takes it down with no new page", false],
  ] as const) {
    test(`a first publish still in flight to the old page when the address is saved: the follow waits for it, and ${what}`, async () => {
      const h = await harness();
      const o = parsePublishUrl(h.page.origin);
      const other = await startPage();
      const parsed = parsePublishUrl(other.origin);
      assert.ok(o.ok && parsed.ok);
      const release = holdIndex(h.page);
      const first = h.publisher.publish("v-1");
      await waitFor(() => spRequests(h.page).some((q) => q.key === "index"), "the publish to reach its index");
      setTarget(h, async () => (moving ? { ok: true, origin: parsed.origin, token: TOKEN } : { ok: false, message: "Set up the public link first." }));
      const follow = h.publisher.pageSaved({ origin: o.origin, token: TOKEN }, moving ? parsed.origin : null);
      release();
      assert.ok((await first).ok);
      await follow;
      await h.publisher.settle();
      assert.equal(h.page.hub.stageplots.size, 0, "the publish landed on the old page after its token was gone");
      assert.equal((await h.venue()).publish?.origin, moving ? parsed.origin : undefined);
      assert.deepEqual(await pending(), []);
    });
  }

  test("a page address saved with its settings unreadable takes the old page's links down with its token, and the card says so", async () => {
    const h = await harness();
    assert.ok((await h.publisher.publish("v-1")).ok);
    const o = parsePublishUrl(h.page.origin);
    assert.ok(o.ok);
    const stale = await queuedOn(h.page, o.origin, 15);
    setTarget(h, async () => {
      throw new Error("secrets store unreadable");
    });
    const saves = h.saved.length;
    const quiet = [mock.method(console, "error", () => undefined), mock.method(console, "warn", () => undefined)];
    try {
      await h.publisher.pageSaved({ origin: o.origin, token: TOKEN }, "https://elsewhere.example");
      await h.publisher.settle();
    } finally {
      for (const q of quiet) q.mock.restore();
    }
    assert.equal(h.page.hub.stageplots.size, 0, "a link is left on a page whose token is gone");
    assert.equal((await h.venue()).publish, undefined);
    assert.deepEqual(await pending(), []);
    void stale;
    assert.match(h.publisher.notice()?.message ?? "", /^The page address was saved, but the page settings could not be read: secrets store unreadable\. The published plots on 127\.0\.0\.1:\d+ were taken down with its token/);
    assert.ok(h.saved.length > saves, "the card was never told");
  });

  test("the same, with the old page refusing the take-down: the link is queued against it, in sight", async () => {
    const h = await harness();
    assert.ok((await h.publisher.publish("v-1")).ok);
    const o = parsePublishUrl(h.page.origin);
    assert.ok(o.ok);
    h.page.respond = (req) => (req.method === "DELETE" ? { status: 500, body: "" } : h.page.worker(req));
    setTarget(h, async () => {
      throw new Error("secrets store unreadable");
    });
    const quiet = [mock.method(console, "error", () => undefined), mock.method(console, "warn", () => undefined)];
    try {
      await h.publisher.pageSaved({ origin: o.origin, token: TOKEN }, "https://elsewhere.example");
      await h.publisher.settle();
    } finally {
      for (const q of quiet) q.mock.restore();
    }
    assert.equal((await h.venue()).publish, undefined);
    assert.deepEqual((await pending()).map((e) => [e.origin, e.reason]), [[o.origin, "address changed"]]);
  });

  test("a follow whose drain with the old token cannot read the queue says so on the card", async () => {
    const h = await harness();
    assert.ok((await h.publisher.publish("v-1")).ok);
    const o = parsePublishUrl(h.page.origin);
    assert.ok(o.ok);
    const f = failing(h);
    setTarget(h, async () => {
      f.get = true;
      return { ok: true, origin: o.origin, token: TOKEN };
    });
    const saves = h.saved.length;
    const quiet = mock.method(console, "error", () => undefined);
    try {
      await h.publisher.pageSaved({ origin: o.origin, token: TOKEN }, o.origin);
      await h.publisher.settle();
    } finally {
      quiet.mock.restore();
    }
    assert.match(h.publisher.notice()?.message ?? "", /^The old links on 127\.0\.0\.1:\d+ could not be removed with its token, and cannot be from here once it is replaced: The old links waiting to be removed could not be read or saved: disk went away$/);
    assert.ok(h.saved.length > saves, "the card was never told");
    // The next follow that does it all clears it.
    setTarget(h, async () => ({ ok: true, origin: o.origin, token: TOKEN }));
    await h.publisher.pageSaved({ origin: o.origin, token: TOKEN }, o.origin);
    await h.publisher.settle();
    assert.equal(h.publisher.notice(), null);
  });

  test("both drains of a follow failing alike say it once on the card", async () => {
    const h = await harness();
    assert.ok((await h.publisher.publish("v-1")).ok);
    const o = parsePublishUrl(h.page.origin);
    assert.ok(o.ok);
    const f = failing(h);
    setTarget(h, async () => {
      f.gets = 2;
      return { ok: true, origin: o.origin, token: TOKEN };
    });
    const quiet = mock.method(console, "error", () => undefined);
    try {
      await h.publisher.pageSaved({ origin: o.origin, token: TOKEN }, o.origin);
      await h.publisher.settle();
    } finally {
      quiet.mock.restore();
    }
    const said = h.publisher.notice()?.message ?? "";
    assert.equal(said.split("disk went away").length - 1, 1, said);
  });

  test("Publish now whose drain cannot read the queue says so beside the venue, never as done", async () => {
    const h = await harness();
    assert.ok((await h.publisher.publish("v-1")).ok);
    const o = parsePublishUrl(h.page.origin);
    assert.ok(o.ok);
    const f = failing(h);
    setTarget(h, async () => {
      f.get = true;
      return { ok: true, origin: o.origin, token: TOKEN };
    });
    const quiet = mock.method(console, "error", () => undefined);
    let r: Awaited<ReturnType<typeof h.publisher.publishNow>>;
    try {
      r = await h.publisher.publishNow("v-1");
    } finally {
      quiet.mock.restore();
    }
    assert.ok(r.ok);
    assert.equal(r.ok ? r.notice : null, "The old links waiting to be removed could not be read or saved: disk went away");
  });

  test("Unpublish names the old page whose copy it cannot reach, and never claims it is gone", async () => {
    const { h, other, oldHost } = await moved();
    const log = capture();
    try {
      const off = await h.publisher.unpublish("v-1");
      assert.ok(off.ok);
      assert.match(off.ok ? (off.notice ?? "") : "", leftOnRe(oldHost));
      assert.ok(h.page.hub.stageplots.size > 0, "the old page's copy was reached after all");
      assert.equal(log.lines.some((l) => l.includes(`removed from ${oldHost}`)), false, log.lines.join(" / "));
      assert.ok(log.lines.some((l) => l.includes("[stageplots]") && leftOnRe(oldHost).test(l)), "the log does not name the old page");
    } finally {
      log.restore();
    }
    void other;
  });

  test("Regenerate says the old link's copy is left on the old page, not that it is removed", async () => {
    const { h, other, oldHost } = await moved();
    const log = capture();
    try {
      const old = (await h.venue()).publish!.secret;
      const reg = await h.publisher.regenerate("v-1");
      assert.ok(reg.ok, reg.ok ? "" : reg.error);
      const parsedOld = parsePublishUrl(h.page.origin);
      assert.ok(parsedOld.ok);
      assert.deepEqual((await pending()).map((e) => [e.secret === old, e.origin, e.reason]), [[true, parsedOld.origin, "regenerated"]]);
      assert.ok(h.page.hub.stageplots.size > 0);
      assert.equal(log.lines.some((l) => l.includes("the old one is removed")), false, log.lines.join(" / "));
      assert.ok(log.lines.some((l) => leftOnRe(oldHost).test(l)), "the log does not name the old page");
    } finally {
      log.restore();
    }
    void other;
  });
});

describe("pending removals: a secret is never forgotten while it may be live", () => {
  const fakeSecret = (i: number) => `${i.toString(36).padStart(42, "A")}E`;
  const originOf = (h: Harness) => {
    const o = parsePublishUrl(h.page.origin);
    assert.ok(o.ok);
    return o.origin;
  };

  test("a failed take-back leaves the secret queued, shown, and removed by Remove now once the page answers", async () => {
    const { stagePlotsView } = await import("./stageplots-files.js");
    const h = await harness(venueDoc(2, 2));
    let down = true;
    h.page.respond = (req) => {
      const m = SP.exec(req.path);
      if (down && m && m[2] === "index") return { status: 500, body: "" };
      if (down && m && req.method === "DELETE") return { status: 500, body: "" };
      return h.page.worker(req);
    };
    assert.equal((await h.publisher.publish("v-1")).ok, false);
    const queued = await pending();
    assert.deepEqual(queued.map((e) => e.reason), ["not taken back"]);
    assert.deepEqual(stagePlotsView(await stageplotsStore.get()).pendingRemovals.map((e) => e.reason), ["not taken back"], "the card cannot see it");
    assert.equal(JSON.stringify(stagePlotsView(await stageplotsStore.get())).includes(queued[0]!.secret), false, "the view carries a secret");
    down = false;
    assert.deepEqual(await h.publisher.removePending(), { removed: 1, left: 0, waiting: 0 });
    assert.deepEqual(await pending(), []);
  });

  test("a publish left in flight by a crash is removed when the publisher starts", async () => {
    const h = await harness();
    const secret = fakeSecret(7);
    await h.page.worker({ method: "PUT", path: `/_publish/v1/stageplots/${secret}/plot/p-0`, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: "{}", bytes: Buffer.from("{}"), at: 0 });
    await stageplotsStore.update((d) => ({ ...d, pendingRemovals: [{ secret, origin: originOf(h), since: "2026-11-12T10:00:00.000Z", reason: "publishing" }] }));
    const { StagePlotsPublisher: P } = await import("./stageplots-publish.js");
    const fresh = new P({ target: async () => ({ ok: true, origin: originOf(h), token: TOKEN }), store: stageplotsStore, image: async () => null, plan: () => ({ planId: null, planDates: null, serviceTypeId: null }), patch: async () => ({ sheets: [], updatedAt: "" }), timeZone: () => "UTC", onSaved: () => undefined });
    fresh.start();
    await fresh.settle();
    await fresh.stop();
    assert.deepEqual(await pending(), []);
    assert.deepEqual(h.page.hub.stagePlotKeys(secret), []);
  });

  test("Unpublish with no page set up queues the link, unpublishes the venue, and says where it is left", async () => {
    let set = true;
    let h!: Harness;
    h = await harness(venueDoc(), { target: async () => (set ? { ok: true, origin: originOf(h), token: TOKEN } : { ok: false, message: "Set up the public link first." }) });
    assert.ok((await h.publisher.publish("v-1")).ok);
    const secret = (await h.venue()).publish!.secret;
    set = false;
    const off = await h.publisher.unpublish("v-1");
    assert.ok(off.ok, off.ok ? "" : off.error);
    assert.equal((await h.venue()).publish, undefined);
    assert.match(off.ok ? (off.notice ?? "") : "", new RegExp(`left on ${host(h.page).replace(/\./g, "\\.")} until that page is set up here again`));
    assert.deepEqual((await pending()).map((e) => [e.secret === secret, e.reason]), [[true, "unpublished"]]);
    set = true;
    assert.deepEqual(await h.publisher.removePending(), { removed: 1, left: 0, waiting: 0 });
    assert.equal((await visit(h.page, secret, "index")).status, 404);
  });

  test("an entry for another page waits, is said once, and writes nothing", async () => {
    const h = await harness();
    await stageplotsStore.update((d) => ({ ...d, pendingRemovals: [{ secret: fakeSecret(3), origin: "https://elsewhere.example", since: "2026-11-12T10:00:00.000Z", reason: "regenerated" }] }));
    const lines: string[] = [];
    const spy = mock.method(console, "warn", (...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    try {
      const saves = h.saved.length;
      assert.deepEqual(await h.publisher.removePending(), { removed: 0, left: 0, waiting: 1 });
      assert.deepEqual(await h.publisher.removePending(), { removed: 0, left: 0, waiting: 1 });
      assert.equal(h.saved.length, saves, "waiting wrote to the store");
    } finally {
      spy.mock.restore();
    }
    assert.equal(lines.filter((l) => l.includes("elsewhere.example") && l.includes("waits")).length, 1, lines.join(" / "));
  });

  /** The real store, with one read made to fail when `failNext` is set. */
  const flaky = () => {
    const f = {
      failNext: false,
      afterUpdate: (_d: StagePlotsDoc) => undefined as void,
      get: async () => {
        if (f.failNext) {
          f.failNext = false;
          throw new Error("disk went away");
        }
        return stageplotsStore.get();
      },
      update: async (fn: (d: StagePlotsDoc) => StagePlotsDoc) => {
        const d = await stageplotsStore.update(fn);
        f.afterUpdate(d);
        return d;
      },
    };
    return f;
  };
  const errors = () => {
    const lines: string[] = [];
    const spy = mock.method(console, "error", (...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    return { lines, restore: () => spy.mock.restore() };
  };

  test("Remove now with the queue unreadable answers why, never that the links went", async () => {
    const h = await harness();
    const store = flaky();
    await stageplotsStore.update((d) => ({ ...d, pendingRemovals: [{ secret: fakeSecret(4), origin: originOf(h), since: "2026-11-12T10:00:00.000Z", reason: "regenerated" }] }));
    const { StagePlotsPublisher: P } = await import("./stageplots-publish.js");
    const p = new P({ target: async () => ({ ok: true, origin: originOf(h), token: TOKEN }), store, image: async () => null, plan: () => ({ planId: null, planDates: null, serviceTypeId: null }), patch: async () => ({ sheets: [], updatedAt: "" }), timeZone: () => "UTC", onSaved: () => undefined });
    const log = errors();
    let r: Awaited<ReturnType<typeof p.removePending>>;
    try {
      store.failNext = true;
      r = await p.removePending();
    } finally {
      log.restore();
    }
    assert.deepEqual(r, { status: 503, error: "The old links waiting to be removed could not be read or saved: disk went away" });
    assert.equal((await pending()).length, 1, "the entry left the queue");
    assert.ok(log.lines.some((l) => l.startsWith("[stageplots] The old links waiting to be removed could not be read")), log.lines.join(" / "));
  });

  test("a regenerate whose drain cannot read the queue says the old link stays queued, not that it is removed", async () => {
    const page = await startPage();
    const o = parsePublishUrl(page.origin);
    assert.ok(o.ok);
    await stageplotsStore.update(() => checkStagePlotsDoc(venueDoc()));
    const store = flaky();
    const { StagePlotsPublisher: P } = await import("./stageplots-publish.js");
    const p = new P({ target: async () => ({ ok: true, origin: o.origin, token: TOKEN }), store, image: async () => webp(), plan: () => ({ planId: null, planDates: null, serviceTypeId: null }), patch: async () => ({ sheets: [], updatedAt: "" }), timeZone: () => "UTC", onSaved: () => undefined });
    assert.ok((await p.publish("v-1")).ok);
    const old = (await stageplotsStore.get()).venues[0]!.publish!.secret;
    // The write that queues the old link is the last before the drain reads the queue.
    store.afterUpdate = (d) => void (d.pendingRemovals.some((e) => e.secret === old) && (store.failNext = true));
    const lines: string[] = [];
    const spies = (["log", "error"] as const).map((level) => mock.method(console, level, (...a: unknown[]) => void lines.push(a.map(String).join(" "))));
    try {
      assert.ok((await p.regenerate("v-1")).ok);
    } finally {
      for (const s of spies) s.mock.restore();
    }
    await p.stop();
    assert.equal(lines.some((l) => l.includes("the old one is removed")), false, lines.join(" / "));
    assert.ok(lines.some((l) => l.includes("the old one stays queued: The old links waiting to be removed could not be read")), lines.join(" / "));
    assert.deepEqual((await pending()).map((e) => [e.secret === old, e.reason]), [[true, "regenerated"]]);
  });

  test("a drain at start whose page settings cannot be read says so, and nothing escapes unhandled", async () => {
    await stageplotsStore.update((d) => ({ ...d, pendingRemovals: [{ secret: fakeSecret(5), origin: "https://elsewhere.example", since: "2026-11-12T10:00:00.000Z", reason: "regenerated" }] }));
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => void unhandled.push(r);
    process.on("unhandledRejection", onUnhandled);
    const log = errors();
    const { StagePlotsPublisher: P } = await import("./stageplots-publish.js");
    const p = new P({
      target: async () => {
        throw new Error("secrets store unreadable");
      },
      store: stageplotsStore,
      image: async () => null,
      plan: () => ({ planId: null, planDates: null, serviceTypeId: null }), patch: async () => ({ sheets: [], updatedAt: "" }),
      timeZone: () => "UTC",
      onSaved: () => undefined,
    });
    try {
      p.start();
      await p.settle();
      await new Promise((r) => setImmediate(r));
    } finally {
      log.restore();
      process.off("unhandledRejection", onUnhandled);
      await p.stop();
    }
    assert.deepEqual(unhandled.map(String), []);
    assert.ok(log.lines.some((l) => l.includes("[stageplots] The old links waiting to be removed could not be read or saved: secrets store unreadable")), log.lines.join(" / "));
  });

  test("a queue that is not a list is never read as empty: Remove now and Publish say why", async () => {
    const page = await startPage();
    const o = parsePublishUrl(page.origin);
    assert.ok(o.ok);
    const damaged = { ...venueDoc(), pendingRemovals: "lost" } as unknown as StagePlotsDoc;
    const { StagePlotsPublisher: P } = await import("./stageplots-publish.js");
    const p = new P({
      target: async () => ({ ok: true, origin: o.origin, token: TOKEN }),
      store: { get: async () => damaged, update: async () => Promise.reject(new Error("refused")) },
      image: async () => null,
      plan: () => ({ planId: null, planDates: null, serviceTypeId: null }), patch: async () => ({ sheets: [], updatedAt: "" }),
      timeZone: () => "UTC",
      onSaved: () => undefined,
    });
    const log = errors();
    const warn = mock.method(console, "warn", () => undefined);
    let removed: Awaited<ReturnType<typeof p.removePending>>;
    let published: Awaited<ReturnType<typeof p.publish>>;
    try {
      removed = await p.removePending();
      published = await p.publish("v-1");
    } finally {
      log.restore();
      warn.mock.restore();
    }
    assert.deepEqual(removed, { status: 503, error: "The old links waiting to be removed could not be read or saved: stageplots.json's pending removals are not a list, so the old links waiting to be removed cannot be read." });
    assert.equal(published.ok, false);
    assert.match(published.ok ? "" : published.error, /pending removals are not a list/);
    assert.equal(page.requests.length, 0, "a publish went out with the queue unreadable");
  });

  test("a full queue refuses a regenerate before anything is sent, so the old link is never left unknown", async () => {
    const h = await harness();
    assert.ok((await h.publisher.publish("v-1")).ok);
    const filler = Array.from({ length: 199 }, (_, i) => ({ secret: fakeSecret(i + 100), origin: "https://elsewhere.example", since: "2026-11-12T10:00:00.000Z", reason: "regenerated" as const }));
    await stageplotsStore.update((d) => ({ ...d, pendingRemovals: filler }));
    h.page.respond = (req) => (req.method === "DELETE" ? { status: 500, body: "" } : h.page.worker(req));
    assert.ok((await h.publisher.regenerate("v-1")).ok, "the 199th queued link is still allowed");
    assert.equal((await pending()).length, 200);
    const before = h.page.requests.length;
    const r = await h.publisher.regenerate("v-1");
    assert.equal(r.ok, false);
    assert.equal(r.ok ? 0 : r.status, 409);
    assert.match(r.ok ? "" : r.error, /old links are still waiting to be removed/);
    assert.equal(h.page.requests.length, before, "a refused regenerate sent something");
  });
});

describe("the secret", () => {
  test("never appears in a log line, an error sent back, or a stored error", async () => {
    const lines: string[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((level) =>
      mock.method(console, level, (...args: unknown[]) => void lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" "))),
    );
    const errors: string[] = [];
    const secrets = new Set<string>();
    try {
      const h = await harness(venueDoc(2, 2));
      const note = async (r: Awaited<ReturnType<typeof h.publisher.publish>>) => {
        if (!r.ok) errors.push(r.error);
        const pub = (await h.venue()).publish;
        if (pub) {
          secrets.add(pub.secret);
          for (const e of await pending()) secrets.add(e.secret);
          if (pub.lastError) errors.push(pub.lastError.message);
        }
      };
      await note(await h.publisher.publish("v-1"));
      // A republish the page refuses, then times out on.
      h.page.respond = () => ({ status: 500, body: "" });
      await h.edit((d) => ({ ...d, plots: d.plots.map((p) => ({ ...p, name: `${p.name}!`, version: p.version + 1 })) }));
      await h.publisher.settle();
      await note(await h.publisher.publishNow("v-1"));
      await note(await h.publisher.regenerate("v-1"));
      await note(await h.publisher.unpublish("v-1"));
      h.page.respond = (req) => (req.method === "DELETE" ? { status: 500, body: "" } : h.page.worker(req));
      await note(await h.publisher.regenerate("v-1"));
      await note(await h.publisher.publishNow("v-1"));
      h.page.respond = (req) => h.page.worker(req);
      await note(await h.publisher.publishNow("v-1"));
      await note(await h.publisher.unpublish("v-1"));
      for (const q of spRequests(h.page)) secrets.add(q.secret);
    } finally {
      for (const s of spies) s.mock.restore();
    }
    assert.ok(secrets.size >= 2, "the run never made a second secret");
    assert.ok(errors.length >= 3, "the run never failed");
    assert.ok(lines.some((l) => l.includes("[stageplots]")), "nothing was logged on [stageplots]");
    for (const s of secrets) {
      for (const l of lines) assert.equal(l.includes(s), false, `a log line names a secret: ${l}`);
      for (const e of errors) assert.equal(e.includes(s), false, `an error names a secret: ${e}`);
    }
  });
});

describe("the publish state in the store", () => {
  beforeEach(async () => {
    await stageplotsStore.update(() => checkStagePlotsDoc(venueDoc()));
  });

  test("passes the store's own check again unchanged, with its lists sorted and unique", async () => {
    const doc = venueDoc();
    doc.venues[0]!.publish = {
      secret: "A".repeat(42) + "E",
      origin: "https://servicecue.example.workers.dev",
      publishedAt: "2026-11-12T14:32:00.000Z",
      lastError: { at: "2026-11-12T14:31:00.000Z", message: "It did not answer." },
      publishedImages: [hash(2), hash(1), hash(2)],
      unpublishedImages: [],
    };
    const once = checkStagePlotsDoc(doc);
    assert.deepEqual(once.venues[0]!.publish!.publishedImages, [hash(1), hash(2)]);
    assert.deepEqual(checkStagePlotsDoc(once), once);
    const off = checkStagePlotsDoc(venueDoc());
    assert.equal(Object.hasOwn(off.venues[0]!, "publish"), false, "an unpublished venue grew a publish field");
  });

  test("pending removals are checked, sorted by page then secret, one per pair, and pass the check again unchanged", async () => {
    const e = (secret: string, origin: string, reason = "regenerated") => ({ secret, origin, since: "2026-11-12T10:00:00.000Z", reason });
    const A = "A".repeat(42) + "E";
    const B = "B".repeat(42) + "E";
    const doc = { ...venueDoc(), pendingRemovals: [e(B, "https://b.example"), e(A, "https://b.example"), e(A, "https://a.example"), e(A, "https://b.example", "unpublished")] };
    const once = checkStagePlotsDoc(doc);
    assert.deepEqual(once.pendingRemovals.map((x) => [x.origin, x.secret === A ? "A" : "B"]), [
      ["https://a.example", "A"],
      ["https://b.example", "A"],
      ["https://b.example", "B"],
    ]);
    assert.deepEqual(checkStagePlotsDoc(once), once);
    for (const bad of [e("short", "https://a.example"), e(A, "not a url"), e(A, "https://a.example", "because")]) {
      assert.throws(() => checkStagePlotsDoc({ ...venueDoc(), pendingRemovals: [bad] }), Error, JSON.stringify(bad));
    }
  });

  test("a stageplots.json whose pending removals are not a list is never read as none", async () => {
    const { normalizeStagePlots } = await import("./stageplots-store.js");
    const lines: string[] = [];
    const spy = mock.method(console, "warn", (...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    let out: unknown;
    try {
      out = normalizeStagePlots({ ...venueDoc(), pendingRemovals: "lost" } as never);
    } finally {
      spy.mock.restore();
    }
    assert.equal((out as { pendingRemovals: unknown }).pendingRemovals, "lost", "a damaged list was replaced, forgetting what it held");
    assert.ok(lines.some((l) => l.includes("pending removals are not a list")));
    assert.throws(() => checkStagePlotsDoc(out), Error, "a save would go through and write over it");
    // And the document still reads: GET /api/stageplots and every broadcast go through the view.
    const { stagePlotsView } = await import("./stageplots-files.js");
    assert.deepEqual(stagePlotsView(out as StagePlotsDoc).pendingRemovals, []);
  });

  test("the view carries what following the Public link could not do, and no field when there is nothing", async () => {
    const { stagePlotsView } = await import("./stageplots-files.js");
    const notice = { at: "2026-11-13T15:04:00.000Z", message: "The old links could not be removed." };
    assert.deepEqual(stagePlotsView(venueDoc(), notice).notice, notice);
    assert.equal(Object.hasOwn(stagePlotsView(venueDoc()), "notice"), false);
  });

  test("refuses a secret, an image or an origin of the wrong shape", async () => {
    const base = venueDoc();
    const pub = { secret: "A".repeat(42) + "E", origin: "https://x.example", publishedAt: "2026-11-12T14:32:00.000Z", lastError: null, publishedImages: [], unpublishedImages: [] };
    for (const bad of [{ secret: "short" }, { secret: "A".repeat(42) + "B" }, { publishedImages: ["nothex"] }, { origin: "not a url" }, { publishedAt: "yesterday" }]) {
      base.venues[0]!.publish = { ...pub, ...bad } as never;
      assert.throws(() => checkStagePlotsDoc(base), Error, JSON.stringify(bad));
    }
  });
});

describe("linked connection points on the public page", () => {
  // Every patch field the public page must never see carries SENTINEL; only the linked
  // device's name, its connectors, the sheet's name and its channels' console channel and
  // label are published.
  function patchWithSentinels(): PatchFile {
    return {
      updatedAt: "",
      sheets: [
        {
          id: "sheet-SENTINEL-ID",
          name: "Main patch",
          kind: "dante",
          devices: [
            { id: "rack-SENTINEL-ID", name: "SENTINEL rack", kind: "rack", inputs: 32, outputs: 16, color: "#8b8d98" },
            { id: "sb1-SENTINEL-ID", name: "SB-1", kind: "snake", inputs: 16, outputs: 4, color: "#0091ff", inLabels: ["A1", "A2"] },
            { id: "hop-SENTINEL-ID", name: "SENTINEL hop", kind: "pocket", inputs: 4, outputs: 0, color: "#e5484d" },
            { id: "fp3-SENTINEL-ID", name: "FP-3", kind: "pocket", inputs: 4, outputs: 0, color: "#12a594" },
          ],
          endpoints: [
            {
              rackId: "rack-SENTINEL-ID",
              dir: "in",
              index: 1,
              consoleChannel: "1",
              label: "Kick In",
              mic: "SENTINEL mic",
              phantom: true,
              notes: "SENTINEL notes",
              owner: "SENTINEL owner",
              micSlotRef: "SENTINEL slot",
              pcoPosition: "SENTINEL position",
              path: [{ deviceId: "hop-SENTINEL-ID", connector: "SENTINEL-CONNECTOR" }, { deviceId: "sb1-SENTINEL-ID", connector: "A1" }],
            },
            { rackId: "rack-SENTINEL-ID", dir: "in", index: 2, consoleChannel: "2", label: "Snare", mic: "SENTINEL mic", path: [{ deviceId: "sb1-SENTINEL-ID", connector: "A2" }] },
            { rackId: "rack-SENTINEL-ID", dir: "in", index: 3, consoleChannel: "3", label: "SENTINEL unrelated", path: [{ deviceId: "hop-SENTINEL-ID", connector: "1" }] },
            { rackId: "rack-SENTINEL-ID", dir: "out", index: 1, consoleChannel: "Mix 1", label: "Wedge", feedType: "SENTINEL feed", path: [{ deviceId: "fp3-SENTINEL-ID", connector: "1" }] },
          ],
          variants: [{ id: "var-SENTINEL", name: "SENTINEL variant", overrides: {} }],
          assignments: { byServiceType: { "st-SENTINEL": "var-SENTINEL" }, byPlan: {} },
        },
      ],
    };
  }

  const linked = (deviceId: string, lastName: string, lastColor: string | null = null) => ({
    sheetId: "sheet-SENTINEL-ID",
    deviceId,
    lastName,
    lastColor,
  });

  /** v-1 links SB-1 and a device that is gone; v-2 links FP-3. Both published. */
  async function twoVenues() {
    const doc = venueDoc(1, 1, () => [
      item("box-1"),
      // Every type's own fields too: publishedItems names each field, so one it forgot is gone from the page.
      item("sym-1", { type: "symbol", symbol: "wedge", label: "Floor wedge" }),
      item("txt-1", { type: "text", textKind: "callout", label: "Riser skirt" }),
      item("cab-1", { type: "cable", points: [[10, 10], [200, 120]], dashed: true, label: "" }),
      item("c-sb1", { type: "conn", label: "Old SB", color: null, patchLink: linked("sb1-SENTINEL-ID", "Old SB") }),
      item("c-gone", { type: "conn", label: "Lost box", color: "#46a758", inputs: ["Spare"], patchLink: linked("gone-SENTINEL-ID", "Lost box", "#46a758") }),
    ]);
    doc.venues.push({ id: "v-2", name: "Chapel", kind: "home", notes: "", plotIds: ["p-9"], defaultPlotId: "p-9" });
    doc.plots.push({ id: "p-9", venueId: "v-2", name: "Chapel plot", backgroundId: null, bgFade: 0, items: [item("c-fp3", { type: "conn", label: "FP-3", color: "#12a594", patchLink: linked("fp3-SENTINEL-ID", "FP-3", "#12a594") })], version: 1 });
    const h = await harness(doc);
    h.patch.file = patchWithSentinels();
    assert.ok((await h.publisher.publish("v-1")).ok);
    assert.ok((await h.publisher.publish("v-2")).ok);
    await h.publisher.settle();
    const doc2 = await stageplotsStore.get();
    const secretOf = (id: string) => doc2.venues.find((v) => v.id === id)!.publish!.secret;
    return { h, s1: secretOf("v-1"), s2: secretOf("v-2") };
  }

  /** Every key path in a JSON value, arrays as [], sorted and unique. */
  function keyPaths(value: unknown, at = ""): string[] {
    if (Array.isArray(value)) return value.flatMap((v) => keyPaths(v, `${at}[]`));
    if (value === null || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([k, v]) => [`${at ? `${at}.` : ""}${k}`, ...keyPaths(v, `${at ? `${at}.` : ""}${k}`)]);
  }
  const sortedPaths = (value: unknown) => [...new Set(keyPaths(value))].sort();

  test("the published plot carries exactly the resolved name, colour and channels, and no other patch data", async () => {
    const { h, s1 } = await twoVenues();
    const body = (await visit(h.page, s1, "plot/p-0")).body;
    assert.ok(!body.includes("SENTINEL"), `patch data the page must not see was published: ${body.match(/.{0,40}SENTINEL.{0,40}/)?.[0]}`);
    const plot = JSON.parse(body) as PublishedPlot;
    assert.deepEqual(sortedPaths(plot), [
      "background",
      "background.hash",
      "background.height",
      "background.width",
      "bgFade",
      "id",
      "items",
      "items[].color",
      "items[].dashed",
      "items[].h",
      "items[].id",
      "items[].inputs",
      "items[].label",
      "items[].notes",
      "items[].patch",
      "items[].patch.channels",
      "items[].patch.channels[].channel",
      "items[].patch.channels[].label",
      "items[].patch.channels[].path",
      "items[].patch.sheet",
      "items[].points",
      "items[].rotation",
      "items[].symbol",
      "items[].textKind",
      "items[].type",
      "items[].w",
      "items[].x",
      "items[].y",
      "name",
    ]);
    const sb1 = plot.items.find((it) => it.id === "c-sb1")!;
    assert.deepEqual([sb1.label, sb1.color], ["SB-1", "#0091ff"]);
    assert.deepEqual(sb1.patch, {
      sheet: "Main patch",
      channels: [
        { channel: "Ch 1", label: "Kick In", path: "SB-1/A1" },
        { channel: "Ch 2", label: "Snare", path: "SB-1/A2" },
      ],
    });
    assert.equal(plot.items.find((it) => it.id === "sym-1")!.symbol, "wedge");
    assert.equal(plot.items.find((it) => it.id === "txt-1")!.textKind, "callout");
    assert.deepEqual(plot.items.find((it) => it.id === "cab-1")!.points, [[10, 10], [200, 120]]);
    const gone = plot.items.find((it) => it.id === "c-gone")!;
    assert.deepEqual([gone.label, gone.color, gone.patch, gone.inputs], ["Lost box", "#46a758", undefined, ["Spare"]]);
  });

  test("a patch change republishes only the venues that show it; one nothing published shows sends nothing", async () => {
    const { h, s1, s2 } = await twoVenues();
    const sentSince = (mark: number) => spRequests({ ...h.page, requests: h.page.requests.slice(mark) } as Receiver).map((q) => `${q.method} ${q.secret === s1 ? "v-1" : q.secret === s2 ? "v-2" : "?"} ${q.key ?? "keep"}`);
    const patchSaved = async (fn: (f: PatchFile) => void) => {
      fn(h.patch.file!);
      h.hear("patch:updated");
      await h.publisher.settle();
    };

    let mark = h.page.requests.length;
    await patchSaved((f) => {
      f.sheets[0]!.endpoints[0]!.mic = "SENTINEL another mic";
      f.sheets[0]!.devices[0]!.name = "SENTINEL rack renamed";
      // On the chain of a channel SB-1 lists, but before SB-1: a row names only SB-1.
      f.sheets[0]!.devices[2]!.name = "SENTINEL hop renamed";
      f.sheets[0]!.variants[0]!.name = "SENTINEL renamed variant";
    });
    assert.deepEqual(sentSince(mark), [], "a patch change no published point shows was sent");

    mark = h.page.requests.length;
    await patchSaved((f) => {
      f.sheets[0]!.devices[1]!.name = "SB-1 Left";
    });
    assert.deepEqual(sentSince(mark), ["PUT v-1 plot/p-0"], "a rename of v-1's device reached another venue, or sent more than its plot");
    const renamed = JSON.parse((await visit(h.page, s1, "plot/p-0")).body) as PublishedPlot;
    assert.equal(renamed.items.find((it) => it.id === "c-sb1")!.label, "SB-1 Left");

    mark = h.page.requests.length;
    await patchSaved((f) => {
      f.sheets[0]!.endpoints[3]!.label = "Wedge 2";
    });
    assert.deepEqual(sentSince(mark), ["PUT v-2 plot/p-9"], "a channel through v-2's device reached v-1");
  });

  test("a week variant that re-patches a channel publishes this plan's channels", async () => {
    const { h, s1 } = await twoVenues();
    const f = h.patch.file!;
    f.sheets[0]!.variants.push({ id: "var-week", name: "Week", overrides: { "rack-SENTINEL-ID:in:3": { path: [{ deviceId: "sb1-SENTINEL-ID", connector: "9" }], label: "Keys" } } });
    f.sheets[0]!.assignments.byPlan["plan-week"] = { variantId: "var-week" };
    h.plan.planId = "plan-week";
    h.plan.planDates = "November 15, 2026";
    h.hear("stage:state-changed");
    await h.publisher.settle();
    const plot = JSON.parse((await visit(h.page, s1, "plot/p-0")).body) as PublishedPlot;
    assert.deepEqual(plot.items.find((it) => it.id === "c-sb1")!.patch!.channels.map((c) => c.path), ["SB-1/A1", "SB-1/A2", "SB-1/9"]);
  });

  test("an unreadable patch publishes linked points unlinked with their last names, said once on [stageplots]", async () => {
    const lines: string[] = [];
    const spies = (["log", "warn", "error"] as const).map((level) => mock.method(console, level, (...a: unknown[]) => void lines.push(a.map(String).join(" "))));
    let h: Harness;
    let s1: string;
    try {
      ({ h, s1 } = await twoVenues());
      h.patch.file = null;
      h.hear("patch:updated");
      h.hear("patch:updated");
      await h.publisher.settle();
      await h.edit((d) => ({ ...d, plots: d.plots.map((p) => (p.id === "p-0" ? { ...p, name: "Renamed", version: p.version + 1 } : p)) }));
      await h.publisher.settle();
    } finally {
      for (const sp of spies) sp.mock.restore();
    }
    const plot = JSON.parse((await visit(h.page, s1, "plot/p-0")).body) as PublishedPlot;
    const sb1 = plot.items.find((it) => it.id === "c-sb1")!;
    assert.deepEqual([sb1.label, sb1.color, sb1.patch], ["Old SB", null, undefined]);
    const ours = lines.filter((l) => l.startsWith("[stageplots]"));
    assert.equal(ours.filter((l) => l.includes("could not read the patch sheet")).length, 1, ours.join(" / "));
    assert.ok(
      ours.some((l) => l.includes('"Main room" · "Plot 0": 2 connection points published unlinked') && l.includes('"Old SB" (the patch sheet cannot be read)')),
      ours.join(" / "),
    );
  });

  test("a device removed from the patch is published with its last name, and said on [stageplots]", async () => {
    const lines: string[] = [];
    const spies = (["log", "warn", "error"] as const).map((level) => mock.method(console, level, (...a: unknown[]) => void lines.push(a.map(String).join(" "))));
    try {
      await twoVenues();
    } finally {
      for (const sp of spies) sp.mock.restore();
    }
    assert.ok(lines.some((l) => l.startsWith("[stageplots]") && l.includes('"Lost box" (its patch device is gone)')), lines.join(" / "));
  });
});

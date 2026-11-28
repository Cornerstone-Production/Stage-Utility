// /api/stageplots: venues, backgrounds and plots, through the real route module,
// the real store and the real conversion, against a real data directory.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import sharp from "sharp";

import { serveOnSocket, type SocketServer } from "../fixtures/socket-server.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stageplots-routes-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { callRoute } = await import("./route-harness.js");
const { stageplotsRoutes } = await import("./stageplots-routes.js");
const { stageplotsStore } = await import("../stageplots-store.js");
const { addBroadcastListener } = await import("../broadcaster.js");
const { RemoteServer } = await import("../remote-server.js");
const { STAGEPLOTS_CHANNEL, STAGEPLOT_DRAFTS_CHANNEL } = await import("../../types/stageplots.js");
const { plotDraftsStore } = await import("../stageplot-drafts-store.js");
const { STAGEPLOT_IMAGE_DIR, STAGEPLOT_ORIGINAL_DIR } = await import("../stageplots-files.js");
type View = import("../../types/stageplots.js").StagePlotsView;

const frames: unknown[] = [];
addBroadcastListener((channel, payload) => {
  if (channel === STAGEPLOTS_CHANNEL) frames.push(payload);
});

let server: SocketServer;
before(async () => {
  server = await serveOnSocket(new RemoteServer().handle);
});
after(async () => {
  await server.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

beforeEach(async () => {
  await stageplotsStore.update(() => ({ venues: [], backgrounds: [], plots: [], overrides: [], pendingRemovals: [] }));
  for (const d of [STAGEPLOT_IMAGE_DIR, STAGEPLOT_ORIGINAL_DIR]) await fs.rm(path.join(TMP, d), { recursive: true, force: true });
  frames.length = 0;
});

const call = (method: string, p: string, body?: unknown) => callRoute(stageplotsRoutes, p, { method, body });
const upload = (p: string, raw: Uint8Array) => callRoute(stageplotsRoutes, p, { method: "POST", raw });

async function jpeg(width = 640, height = 480): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 180, b: 140 } } }).jpeg().toBuffer();
}

function tinyPdf(tag = ""): Buffer {
  return Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n%${tag}\n`, "latin1");
}

/** Every warning `run` logs under `tag` ([stageplots] unless said). */
async function warnings(run: () => Promise<unknown>, tag = "[stageplots]"): Promise<string[]> {
  const seen: string[] = [];
  const real = console.warn;
  console.warn = (...a: unknown[]) => void seen.push(a.join(" "));
  try {
    await run();
  } finally {
    console.warn = real;
  }
  return seen.filter((w) => w.startsWith(tag));
}

async function aged(dir: string, file: string): Promise<void> {
  const { STAGEPLOT_FILE_GRACE_MS } = await import("../stageplots-files.js");
  const old = new Date(Date.now() - STAGEPLOT_FILE_GRACE_MS - 60_000);
  await fs.utimes(path.join(TMP, dir, file), old, old);
}

async function venue(name = "Main room") {
  const r = await call("POST", "/api/stageplots/venues", { name, kind: "home", notes: "" });
  assert.equal(r.status, 201, r.body);
  return r.json as { id: string };
}

async function plot(venueId: string, name = "Standard", backgroundId?: string) {
  const r = await call("POST", "/api/stageplots/plots", { venueId, name, ...(backgroundId ? { backgroundId } : {}) });
  assert.equal(r.status, 201, r.body);
  return r.json as { id: string };
}

/** A published venue's secret, as the store holds it: no answer a browser gets carries it, but GET …/link. */
async function storedSecret(id: string): Promise<string> {
  const secret = (await stageplotsStore.get()).venues.find((v) => v.id === id)?.publish?.secret;
  assert.ok(secret, `venue ${id} is not published`);
  return secret;
}

/** Publish a venue through its route, and answer the secret it was published under. */
async function publishVenue(id: string): Promise<string> {
  const r = await call("POST", `/api/stageplots/venues/${id}/publish`);
  assert.equal(r.status, 200, r.body);
  return storedSecret(id);
}

async function filesIn(dir: string): Promise<string[]> {
  return fs.readdir(path.join(TMP, dir)).catch(() => []);
}

describe("stage plot routes", () => {
  test("GET answers the document with each background's URLs", async () => {
    const r = await call("GET", "/api/stageplots");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { venues: [], backgrounds: [], plots: [], overrides: [], pendingRemovals: [] });
  });

  test("venues: create, rename (the address stays), change kind and notes, delete with its plots", async () => {
    const v = await venue();
    const p = await plot(v.id);
    let r = await call("PATCH", `/api/stageplots/venues/${v.id}`, { name: "  Chapel ", kind: "offsite", notes: "Side door" });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(r.json, { id: v.id, name: "Chapel", slug: "main-room", oldSlugs: [], kind: "offsite", notes: "Side door", plotIds: [p.id], defaultPlotId: p.id });
    r = await call("DELETE", `/api/stageplots/venues/${v.id}`);
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(await stageplotsStore.get(), { venues: [], backgrounds: [], plots: [], overrides: [], pendingRemovals: [] });
  });

  test("a venue's first plot becomes its default, and set default moves it", async () => {
    const v = await venue();
    const a = await plot(v.id, "Standard");
    const b = await plot(v.id, "Baptism");
    let doc = await stageplotsStore.get();
    assert.equal(doc.venues[0].defaultPlotId, a.id);
    assert.deepEqual(doc.venues[0].plotIds, [a.id, b.id]);
    const r = await call("POST", `/api/stageplots/venues/${v.id}/default`, { plotId: b.id });
    assert.equal(r.status, 200, r.body);
    doc = await stageplotsStore.get();
    assert.equal(doc.venues[0].defaultPlotId, b.id);
    assert.equal((await call("POST", `/api/stageplots/venues/${v.id}/default`, { plotId: "p-nowhere" })).status, 400);
  });

  test("deleting the default makes the first plot left the default; the last plot deletes too", async () => {
    const v = await venue();
    const a = await plot(v.id, "Standard");
    const b = await plot(v.id, "Baptism");
    const c = await plot(v.id, "Christmas");
    const d = await plot(v.id, "Easter");
    // Not the default: the default stays, and the answer names it.
    const other = await call("DELETE", `/api/stageplots/plots/${b.id}`);
    assert.equal(other.status, 200);
    assert.equal((other.json as { defaultPlotId: string | null }).defaultPlotId, a.id, "the answer is the default as it is after the delete");
    let doc = await stageplotsStore.get();
    assert.equal(doc.venues[0].defaultPlotId, a.id);
    // Tab order now differs from creation order: d, then c, then a.
    assert.equal((await call("PATCH", `/api/stageplots/venues/${v.id}`, { plotIds: [d.id, c.id, a.id] })).status, 200);
    // The default: the FIRST plot left in tab order (d) takes over, not the last (c), and the
    // answer says which.
    const r = await call("DELETE", `/api/stageplots/plots/${a.id}`);
    assert.equal(r.status, 200, r.body);
    assert.equal((r.json as { defaultPlotId: string | null }).defaultPlotId, d.id);
    doc = await stageplotsStore.get();
    assert.deepEqual(doc.venues[0].plotIds, [d.id, c.id]);
    assert.equal(doc.venues[0].defaultPlotId, d.id);
    assert.equal((await call("DELETE", `/api/stageplots/plots/${d.id}`)).status, 200);
    doc = await stageplotsStore.get();
    assert.equal(doc.venues[0].defaultPlotId, c.id);
    assert.equal(doc.venues[0].plotIds.length, 1);
    // The last plot: the venue is left with none.
    const last = await call("DELETE", `/api/stageplots/plots/${c.id}`);
    assert.equal(last.status, 200, last.body);
    assert.equal((last.json as { defaultPlotId: string | null }).defaultPlotId, null, "null only when no plot is left");
    doc = await stageplotsStore.get();
    assert.deepEqual(doc.venues[0].plotIds, []);
    assert.equal(doc.venues[0].defaultPlotId, null);
    assert.deepEqual(doc.plots, []);
  });

  test("a venue's plots reorder by naming each exactly once", async () => {
    const v = await venue();
    const a = await plot(v.id, "Standard");
    const b = await plot(v.id, "Baptism");
    const c = await plot(v.id, "Christmas");
    const r = await call("PATCH", `/api/stageplots/venues/${v.id}`, { plotIds: [c.id, a.id, b.id] });
    assert.equal(r.status, 200, r.body);
    let doc = await stageplotsStore.get();
    assert.deepEqual(doc.venues[0].plotIds, [c.id, a.id, b.id]);
    assert.equal(doc.venues[0].defaultPlotId, a.id, "a reorder leaves the default where it was");
    for (const bad of [[c.id, a.id], [c.id, a.id, a.id], [c.id, a.id, "p-nowhere"], [c.id, a.id, b.id, b.id], "nope", [1, 2, 3]]) {
      assert.equal((await call("PATCH", `/api/stageplots/venues/${v.id}`, { plotIds: bad })).status, 400, JSON.stringify(bad));
    }
    doc = await stageplotsStore.get();
    assert.deepEqual(doc.venues[0].plotIds, [c.id, a.id, b.id], "a refused order changes nothing");
  });

  test("duplicate is independent (renaming the copy leaves the original)", async () => {
    const v = await venue();
    const a = await plot(v.id, "Standard");
    await call("PATCH", `/api/stageplots/plots/${a.id}`, { bgFade: 0.7 });
    const r = await call("POST", `/api/stageplots/plots/${a.id}/duplicate`);
    assert.equal(r.status, 201, r.body);
    const copy = r.json as { id: string; name: string; bgFade: number; version: number };
    assert.equal(copy.name, "Standard copy");
    assert.equal(copy.bgFade, 0.7);
    assert.notEqual(copy.id, a.id);
    await call("PATCH", `/api/stageplots/plots/${copy.id}`, { name: "Christmas" });
    const doc = await stageplotsStore.get();
    assert.deepEqual(doc.plots.map((p) => p.name), ["Standard", "Christmas"]);
    assert.deepEqual(doc.venues[0].plotIds, [a.id, copy.id]);
  });

  test("a plot change bumps its version", async () => {
    const v = await venue();
    const a = await plot(v.id);
    const r = await call("PATCH", `/api/stageplots/plots/${a.id}`, { name: "Renamed", bgFade: 0.2 });
    assert.equal(r.status, 200, r.body);
    assert.equal((r.json as { version: number }).version, 1);
    assert.equal((await call("PATCH", `/api/stageplots/plots/${a.id}`, { bgFade: 3 })).status, 400);
    assert.equal((await call("PATCH", `/api/stageplots/plots/${a.id}`, { backgroundId: "b-nowhere" })).status, 400);
  });

  test("upload a JPEG: converted, listed, served, logged", async () => {
    const r = await upload("/api/stageplots/backgrounds?name=Plan.jpg", await jpeg(3000, 2000));
    assert.equal(r.status, 201, r.body);
    const bg = r.json as View["backgrounds"][number];
    assert.equal(bg.name, "Plan.jpg");
    assert.equal(bg.original.mime, "image/jpeg");
    assert.equal(bg.source.ext, "jpg");
    assert.equal(bg.original.hash, bg.source.hash);
    assert.deepEqual([bg.converted.width, bg.converted.height], [2400, 1600]);
    assert.ok(bg.converted.bytes < 1_000_000);
    assert.equal(bg.cleanup, true);
    assert.equal(bg.url, `/${STAGEPLOT_IMAGE_DIR}/${bg.converted.hash}.webp`);
    assert.equal(bg.sourceUrl, `/${STAGEPLOT_IMAGE_DIR}/${bg.source.hash}.jpg`);
    const served = await server.send("GET", bg.url);
    assert.equal(served.status, 200);
    assert.equal(served.headers["content-type"], "image/webp");
  });

  test("the source served for a phone photo is 2400 px with no EXIF, and the original is that source", async () => {
    const photo = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 90, g: 120, b: 150 } } })
      .withExif({ IFD0: { Make: "Phone" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "41/1 35/1 0/1" } })
      .jpeg({ quality: 95 })
      .toBuffer();
    const bg = (await upload("/api/stageplots/backgrounds?name=Photo.jpg", photo)).json as View["backgrounds"][number];
    const served = await fetch(`http://${server.host}${bg.sourceUrl}`);
    assert.equal(served.status, 200);
    const bytes = Buffer.from(await served.arrayBuffer());
    const meta = await sharp(bytes).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height, meta.exif], ["jpeg", 2400, 1800, undefined]);
    assert.deepEqual(bg.original, { hash: bg.source.hash, mime: "image/jpeg", bytes: bytes.length });
    // Clean-up re-converts from that stored source.
    const r = await call("PATCH", `/api/stageplots/backgrounds/${bg.id}`, { cleanup: false });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual([(r.json as View["backgrounds"][number]).converted.width, (r.json as View["backgrounds"][number]).converted.height], [2400, 1800]);
  });

  test("a zip renamed .png is 400 and stores nothing", async () => {
    const zip = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.alloc(400)]);
    const r = await upload("/api/stageplots/backgrounds?name=plan.png", zip);
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /PNG, JPEG or PDF/);
    assert.deepEqual(await filesIn(STAGEPLOT_IMAGE_DIR), []);
    assert.deepEqual((await stageplotsStore.get()).backgrounds, []);
    assert.equal(frames.length, 0);
  });

  test("an SVG renamed .jpg and a 30000x30000 PNG are 400 before any conversion", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    assert.equal((await upload("/api/stageplots/backgrounds?name=plan.jpg", svg)).status, 400);
    const { crc32, deflateSync } = await import("node:zlib");
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(body));
      return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(30000, 0);
    ihdr.writeUInt32BE(30000, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const bomb = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(1))), chunk("IEND", Buffer.alloc(0))]);
    const r = await upload("/api/stageplots/backgrounds?name=bomb.png", bomb);
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /50 megapixels/);
    assert.deepEqual(await filesIn(STAGEPLOT_IMAGE_DIR), []);
  });

  test("a 13 MB image body is 413, and a 26 MB PDF", async () => {
    // Refused by readRawBody's cap, which the server answers 413; that mapping
    // is the server's, so the route is driven directly and the throw read.
    const big = new Uint8Array(13 * 1024 * 1024);
    const too = (p: string, raw: Uint8Array) =>
      callRoute(stageplotsRoutes, p, { method: "POST", raw }).then(
        () => assert.fail(`${p} took the body`),
        (err: { status?: number }) => assert.equal(err.status, 413),
      );
    await too("/api/stageplots/backgrounds?name=big.jpg", big);
    await too("/api/stageplots/backgrounds/pdf?name=big.pdf", new Uint8Array(26 * 1024 * 1024));
    assert.deepEqual(await filesIn(STAGEPLOT_IMAGE_DIR), []);
    assert.deepEqual(await filesIn(STAGEPLOT_ORIGINAL_DIR), []);
  });

  test("a PDF upload keeps the original, then the page raster makes the background", async () => {
    const pdf = tinyPdf();
    let r = await upload("/api/stageplots/backgrounds/pdf?name=Plan.pdf", pdf);
    assert.equal(r.status, 201, r.body);
    const { originalHash } = r.json as { originalHash: string };
    assert.match(originalHash, /^[0-9a-f]{16}$/);
    const raster = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: { r: 250, g: 250, b: 250 } } }).png().toBuffer();
    r = await upload(`/api/stageplots/backgrounds?name=Plan.pdf&original=${originalHash}&page=2&pages=3`, raster);
    assert.equal(r.status, 201, r.body);
    const bg = r.json as View["backgrounds"][number];
    assert.deepEqual(bg.original, { hash: originalHash, mime: "application/pdf", bytes: pdf.length });
    assert.equal(bg.source.ext, "png");
    assert.deepEqual([bg.pdfPage, bg.pdfPages], [2, 3]);
    assert.ok((await filesIn(STAGEPLOT_ORIGINAL_DIR)).includes(`${originalHash}.pdf`));
  });

  test("a raster naming an original that is not here, or a bad page, is 400", async () => {
    const raster = await jpeg();
    assert.equal((await upload("/api/stageplots/backgrounds?name=x&original=0000000000000000&page=1&pages=1", raster)).status, 400);
    const { originalHash } = (await upload("/api/stageplots/backgrounds/pdf?name=Plan.pdf", tinyPdf())).json as { originalHash: string };
    assert.equal((await upload(`/api/stageplots/backgrounds?name=x&original=${originalHash}&page=4&pages=3`, raster)).status, 400);
    assert.equal((await upload("/api/stageplots/backgrounds?name=x", tinyPdf())).status, 400);
    assert.equal((await upload("/api/stageplots/backgrounds/pdf?name=x", raster)).status, 400);
  });

  test("clean-up toggle re-converts and changes the converted image", async () => {
    const bg = (await upload("/api/stageplots/backgrounds?name=Photo.jpg", await jpeg())).json as View["backgrounds"][number];
    const r = await call("PATCH", `/api/stageplots/backgrounds/${bg.id}`, { cleanup: false, name: "Photo" });
    assert.equal(r.status, 200, r.body);
    const after = r.json as View["backgrounds"][number];
    assert.equal(after.cleanup, false);
    assert.equal(after.name, "Photo");
    assert.notEqual(after.converted.hash, bg.converted.hash);
    assert.equal(after.source.hash, bg.source.hash);
  });

  test("deleting a used background is 409 naming the plots; unused, it goes with its files", async () => {
    const bg = (await upload("/api/stageplots/backgrounds?name=Plan.jpg", await jpeg())).json as View["backgrounds"][number];
    const v = await venue();
    const p = await plot(v.id, "Standard", bg.id);
    let r = await call("DELETE", `/api/stageplots/backgrounds/${bg.id}`);
    assert.equal(r.status, 409);
    assert.deepEqual((r.json as { plots: string[] }).plots, ["Main room · Standard"]);
    await call("PATCH", `/api/stageplots/plots/${p.id}`, { backgroundId: null });
    r = await call("DELETE", `/api/stageplots/backgrounds/${bg.id}`);
    assert.equal(r.status, 200, r.body);
    assert.deepEqual((await stageplotsStore.get()).backgrounds, []);
    // Inside the hour its files stay: a PDF upload's two requests may be between them.
    assert.deepEqual((await filesIn(STAGEPLOT_IMAGE_DIR)).sort(), [`${bg.converted.hash}.webp`, `${bg.source.hash}.jpg`].sort());
  });

  test("a deleted background's files go once they are an hour old", async () => {
    const bg = (await upload("/api/stageplots/backgrounds?name=Plan.jpg", await jpeg())).json as View["backgrounds"][number];
    await aged(STAGEPLOT_IMAGE_DIR, `${bg.converted.hash}.webp`);
    await aged(STAGEPLOT_IMAGE_DIR, `${bg.source.hash}.jpg`);
    assert.equal((await call("DELETE", `/api/stageplots/backgrounds/${bg.id}`)).status, 200);
    assert.deepEqual(await filesIn(STAGEPLOT_IMAGE_DIR), []);
  });

  test("an empty PATCH writes nothing, broadcasts nothing and keeps the plot's version", async () => {
    const v = await venue();
    const a = await plot(v.id);
    const bg = (await upload("/api/stageplots/backgrounds?name=Plan.jpg", await jpeg())).json as View["backgrounds"][number];
    const file = path.join(TMP, "stageplots.json");
    const before = (await fs.stat(file)).mtimeMs;
    frames.length = 0;
    for (const [p, body] of [
      [`/api/stageplots/venues/${v.id}`, {}],
      [`/api/stageplots/venues/${v.id}`, { name: "Main room" }],
      [`/api/stageplots/plots/${a.id}`, {}],
      [`/api/stageplots/plots/${a.id}`, { bgFade: 0.4 }],
      [`/api/stageplots/backgrounds/${bg.id}`, {}],
      [`/api/stageplots/backgrounds/${bg.id}`, { cleanup: true }],
    ] as const) {
      const r = await call("PATCH", p, body);
      assert.equal(r.status, 200, `${p}: ${r.body}`);
    }
    assert.equal(frames.length, 0, "an empty change broadcast");
    assert.equal((await fs.stat(file)).mtimeMs, before, "an empty change wrote stageplots.json");
    assert.equal((await stageplotsStore.get()).plots[0].version, 0);
    assert.equal(((await call("PATCH", `/api/stageplots/plots/${a.id}`, { bgFade: 0.5 })).json as { version: number }).version, 1);
  });

  test("a clean-up switch whose source is missing is 409, said on [stageplots]", async () => {
    const bg = (await upload("/api/stageplots/backgrounds?name=Plan.jpg", await jpeg())).json as View["backgrounds"][number];
    await fs.rm(path.join(TMP, STAGEPLOT_IMAGE_DIR, `${bg.source.hash}.jpg`));
    let r: Awaited<ReturnType<typeof call>> | null = null;
    const said = await warnings(async () => (r = await call("PATCH", `/api/stageplots/backgrounds/${bg.id}`, { cleanup: false })));
    assert.equal(r!.status, 409);
    assert.match((r!.json as { error: string }).error, /upload it again/);
    assert.ok(said.some((w) => /source image is missing/.test(w)), said.join("\n"));
  });

  test("refused uploads are said on [stageplots]: the background limit, a bad name, a bad page, over the cap", async () => {
    await stageplotsStore.update((d) => ({
      ...d,
      backgrounds: Array.from({ length: 50 }, (_, i) => ({
        id: `b-${i}`,
        name: `Plan ${i}`,
        original: { hash: "0123456789abcdef", mime: "image/png" as const, bytes: 1 },
        source: { hash: "0123456789abcdef", ext: "png" as const },
        converted: { hash: "fedcba9876543210", width: 2, height: 1, bytes: 1 },
        cleanup: true,
        pdfPage: null,
        pdfPages: null,
      })),
    }));
    const jpg = await jpeg();
    let limited: Awaited<ReturnType<typeof upload>> | null = null;
    const saidLimit = await warnings(async () => (limited = await upload("/api/stageplots/backgrounds?name=One+too+many.jpg", jpg)));
    assert.equal(limited!.status, 400);
    assert.deepEqual(saidLimit, ['[stageplots] upload refused: "One too many.jpg" there can be at most 50 backgrounds']);
    await stageplotsStore.update((d) => ({ ...d, backgrounds: [] }));
    const saidName = await warnings(() => upload("/api/stageplots/backgrounds?name=", jpg));
    assert.deepEqual(saidName, ['[stageplots] upload refused: "(no name)" the background needs a name']);
    const saidPage = await warnings(() => upload("/api/stageplots/backgrounds?name=p.png&original=0000000000000000&page=x&pages=2", jpg));
    assert.deepEqual(saidPage, ['[stageplots] upload refused: "p.png" ?page= must be a page number']);
    const saidCap = await warnings(() =>
      callRoute(stageplotsRoutes, "/api/stageplots/backgrounds?name=big.jpg", { method: "POST", raw: new Uint8Array(13 * 1024 * 1024) }).catch(() => null),
    );
    assert.deepEqual(saidCap, ['[stageplots] upload refused: "big.jpg" is over the 12.0 MB cap']);
  });

  test("after a damaged stageplots.json, old originals do not block a new PDF", async () => {
    // The tidy holds off while a .corrupt- copy sits in the data folder, so
    // the six hour-old originals stay; none of them is waiting for a page.
    const corrupt = path.join(TMP, "stageplots.json.corrupt-1");
    await fs.writeFile(corrupt, "{");
    try {
      for (let i = 0; i < 6; i++) {
        const r = await upload(`/api/stageplots/backgrounds/pdf?name=old${i}.pdf`, tinyPdf(`old${i}`));
        await aged(STAGEPLOT_ORIGINAL_DIR, `${(r.json as { originalHash: string }).originalHash}.pdf`);
      }
      const r = await upload("/api/stageplots/backgrounds/pdf?name=new.pdf", tinyPdf("new"));
      assert.equal(r.status, 201, r.body);
      assert.equal((await filesIn(STAGEPLOT_ORIGINAL_DIR)).length, 7, "the tidy removed originals while a .corrupt- copy was there");
    } finally {
      await fs.rm(corrupt, { force: true });
    }
  });

  test("PDFs waiting for their page are capped at five; an hour-old one is tidied first", async () => {
    const hashes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await upload(`/api/stageplots/backgrounds/pdf?name=p${i}.pdf`, tinyPdf(`p${i}`));
      assert.equal(r.status, 201, r.body);
      hashes.push((r.json as { originalHash: string }).originalHash);
    }
    let sixth: Awaited<ReturnType<typeof upload>> | null = null;
    const said = await warnings(async () => (sixth = await upload("/api/stageplots/backgrounds/pdf?name=p5.pdf", tinyPdf("p5"))));
    assert.equal(sixth!.status, 409);
    assert.match((sixth!.json as { error: string }).error, /5 PDFs waiting for their page/);
    assert.equal(said.length, 1, said.join("\n"));
    // One already waiting may be sent again: it adds no file.
    assert.equal((await upload("/api/stageplots/backgrounds/pdf?name=p0.pdf", tinyPdf("p0"))).status, 201);
    // An hour-old one is removed, which makes room.
    await aged(STAGEPLOT_ORIGINAL_DIR, `${hashes[0]}.pdf`);
    assert.equal((await upload("/api/stageplots/backgrounds/pdf?name=p5.pdf", tinyPdf("p5"))).status, 201);
    assert.ok(!(await filesIn(STAGEPLOT_ORIGINAL_DIR)).includes(`${hashes[0]}.pdf`));
    assert.equal((await filesIn(STAGEPLOT_ORIGINAL_DIR)).length, 5);
  });

  test("a non-object JSON body is 400", async () => {
    for (const body of [[1, 2], "text", 42, null]) {
      const r = await call("POST", "/api/stageplots/venues", body);
      assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.body}`);
    }
    assert.equal((await callRoute(stageplotsRoutes, "/api/stageplots/venues", { method: "POST", raw: "{not json" })).status, 400);
  });

  test("every mutation broadcasts stageplots:updated once, with the whole document", async () => {
    const steps: [string, () => Promise<unknown>][] = [];
    const v = await venue();
    const a = await plot(v.id);
    frames.length = 0;
    steps.push(["rename venue", () => call("PATCH", `/api/stageplots/venues/${v.id}`, { name: "Hall" })]);
    steps.push(["new plot", () => plot(v.id, "Second")]);
    steps.push(["duplicate", () => call("POST", `/api/stageplots/plots/${a.id}/duplicate`)]);
    steps.push(["fade", () => call("PATCH", `/api/stageplots/plots/${a.id}`, { bgFade: 0.1 })]);
    steps.push(["upload", async () => upload("/api/stageplots/backgrounds?name=Plan.jpg", await jpeg())]);
    for (const [what, step] of steps) {
      const before = frames.length;
      await step();
      assert.equal(frames.length, before + 1, `${what} broadcast ${frames.length - before} times`);
      const frame = frames.at(-1) as View;
      assert.deepEqual(frame, (await call("GET", "/api/stageplots")).json, `${what}: the frame is not the document`);
    }
  });

  test("a refused change broadcasts nothing", async () => {
    const v = await venue();
    const a = await plot(v.id);
    frames.length = 0;
    await call("PATCH", `/api/stageplots/venues/${v.id}`, { plotIds: [a.id, a.id] });
    await call("PATCH", `/api/stageplots/venues/${v.id}`, { kind: "garage" });
    assert.equal(frames.length, 0);
  });

  test("unknown ids are 404", async () => {
    const v = await venue();
    for (const [method, p, body] of [
      ["PATCH", "/api/stageplots/venues/v-nowhere", { name: "x" }],
      ["DELETE", "/api/stageplots/venues/v-nowhere", undefined],
      ["POST", "/api/stageplots/venues/v-nowhere/default", { plotId: "p-1" }],
      ["PATCH", "/api/stageplots/plots/p-nowhere", { name: "x" }],
      ["DELETE", "/api/stageplots/plots/p-nowhere", undefined],
      ["POST", "/api/stageplots/plots/p-nowhere/duplicate", undefined],
      ["PATCH", "/api/stageplots/backgrounds/b-nowhere", { name: "x" }],
      ["DELETE", "/api/stageplots/backgrounds/b-nowhere", undefined],
    ] as const) {
      assert.equal((await call(method, p, body)).status, 404, `${method} ${p}`);
    }
    assert.equal((await call("POST", "/api/stageplots/plots", { venueId: "v-nowhere", name: "x" })).status, 400);
    assert.ok(v.id);
  });

  test("the 21st plot in a venue is 400, and so is a duplicate past it", async () => {
    const v = await venue();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push((await plot(v.id, `Plot ${i}`)).id);
    const first = ids[0];
    const r = await call("POST", "/api/stageplots/plots", { venueId: v.id, name: "One too many" });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /20 plots/);
    assert.equal((await call("POST", `/api/stageplots/plots/${first}/duplicate`)).status, 400);
  });

  test("the 51st venue is 400", async () => {
    await stageplotsStore.update((d) => ({
      ...d,
      venues: Array.from({ length: 50 }, (_, i) => ({ id: `v-${i}`, name: `Room ${i}`, slug: null, oldSlugs: [], kind: "home" as const, notes: "", plotIds: [], defaultPlotId: null })),
    }));
    const r = await call("POST", "/api/stageplots/venues", { name: "One too many", kind: "home" });
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /50 venues/);
  });

  test("a path it does not own falls through", async () => {
    const r = await call("GET", "/api/stageplotsx");
    assert.equal(r.responded, false);
  });
});

describe("venue addresses", () => {
  const patchVenue = (id: string, body: unknown) => call("PATCH", `/api/stageplots/venues/${id}`, body);
  const venueNow = async (id: string) => (await stageplotsStore.get()).venues.find((v) => v.id === id)!;
  /** Every line `run` logs under [stageplots]. */
  async function logs(run: () => Promise<unknown>): Promise<string[]> {
    const seen: string[] = [];
    const real = console.log;
    console.log = (...a: unknown[]) => void seen.push(a.join(" "));
    try {
      await run();
    } finally {
      console.log = real;
    }
    return seen.filter((l) => l.startsWith("[stageplots]"));
  }

  test("a new venue's address is made from its name, with -2, -3 when it is taken", async () => {
    const made = async (name: string) => ((await call("POST", "/api/stageplots/venues", { name, kind: "home" })).json as { slug: string }).slug;
    assert.equal(await made("Main Auditorium"), "main-auditorium");
    assert.equal(await made("Main  Auditorium!"), "main-auditorium-2");
    assert.equal(await made("main auditorium"), "main-auditorium-3");
    assert.equal(await made("Café Été"), "cafe-ete");
    assert.equal(await made("!!!"), "venue");
    // The editor's own address is never a venue's.
    assert.equal(await made("Edit"), "edit-2");
    // Nor the app's own Stage plots page.
    assert.equal(await made("Manage"), "manage-2");
    const long = await made("A".repeat(60));
    assert.equal(long, "a".repeat(60));
    const longer = await made("A".repeat(60));
    assert.equal(longer, `${"a".repeat(58)}-2`);
  });

  test("a changed address keeps the old one as an alias; going back takes it off the list; both logged", async () => {
    const v = await venue("Main room");
    const said = await logs(async () => {
      const r = await patchVenue(v.id, { slug: "hall" });
      assert.equal(r.status, 200, r.body);
    });
    assert.deepEqual(said, [`[stageplots] venue ${v.id} now at /stageplots/hall; /stageplots/main-room still opens it`]);
    assert.deepEqual(await venueNow(v.id).then((x) => [x.slug, x.oldSlugs]), ["hall", ["main-room"]]);
    await patchVenue(v.id, { slug: "big-hall" });
    assert.deepEqual(await venueNow(v.id).then((x) => [x.slug, x.oldSlugs]), ["big-hall", ["main-room", "hall"]]);
    // An old address taken back is its address again, and off the list.
    await patchVenue(v.id, { slug: "main-room" });
    assert.deepEqual(await venueNow(v.id).then((x) => [x.slug, x.oldSlugs]), ["main-room", ["hall", "big-hall"]]);
    // A rename leaves it alone.
    await patchVenue(v.id, { name: "The Big Hall" });
    assert.equal((await venueNow(v.id)).slug, "main-room");
  });

  test("old addresses can only be dropped, and a drop is logged", async () => {
    const v = await venue("Main room");
    await patchVenue(v.id, { slug: "hall" });
    await patchVenue(v.id, { slug: "big-hall" });
    let r = await patchVenue(v.id, { oldSlugs: ["main-room", "elsewhere"] });
    assert.equal(r.status, 400);
    assert.equal((r.json as { error: string }).error, "Old addresses can only be dropped from the venue's own list, never added");
    const said = await logs(async () => assert.equal((await patchVenue(v.id, { oldSlugs: ["hall"] })).status, 200));
    assert.deepEqual(said, [`[stageplots] venue ${v.id} no longer answers to /stageplots/main-room`]);
    assert.deepEqual((await venueNow(v.id)).oldSlugs, ["hall"]);
    r = await patchVenue(v.id, { oldSlugs: "hall" });
    assert.equal(r.status, 400);
  });

  test("at most ten old addresses are kept, the newest", async () => {
    const v = await venue("Room");
    for (let i = 1; i <= 12; i++) assert.equal((await patchVenue(v.id, { slug: `room-${i}` })).status, 200);
    const now = await venueNow(v.id);
    assert.equal(now.slug, "room-12");
    assert.deepEqual(now.oldSlugs, ["room-2", "room-3", "room-4", "room-5", "room-6", "room-7", "room-8", "room-9", "room-10", "room-11"]);
  });

  test("an address another venue answers to, by its address, an old one or its id, is refused naming it, and said", async () => {
    const chapel = await venue("Chapel");
    await patchVenue(chapel.id, { slug: "the-chapel" });
    const main = await venue("Main room");
    await stageplotsStore.update((d) => ({ ...d, venues: [...d.venues, { id: "side-room", name: "Side room", slug: null, oldSlugs: [], kind: "home", notes: "", plotIds: [], defaultPlotId: null }] }));
    for (const taken of ["the-chapel", "chapel", "side-room"]) {
      const said = await warnings(async () => {
        const r = await patchVenue(main.id, { slug: taken });
        assert.equal(r.status, 400, taken);
        assert.equal((r.json as { error: string }).error, taken === "side-room" ? "Side room already uses that address" : "Chapel already uses that address");
      });
      assert.equal(said.length, 1, taken);
      assert.match(said[0], new RegExp(`address refused for venue ${main.id}: .*already uses that address`));
    }
    assert.equal((await venueNow(main.id)).slug, "main-room");
  });

  test("an address that breaks the rules is refused, and saves nothing", async () => {
    const v = await venue("Main room");
    for (const [slug, says] of [
      ["Main Room", /lower-case letters/],
      ["-room", /lower-case letters/],
      ["room--two", /lower-case letters/],
      ["", /lower-case letters/],
      ["a".repeat(61), /1 to 60/],
      [42, /lower-case letters/],
      ["edit", /editor's own/],
      ["manage", /app's own Stage plots page/],
      ["v-0123456789ab", /venue id/],
      [null, /changed, not removed/],
    ] as const) {
      const r = await patchVenue(v.id, { slug });
      assert.equal(r.status, 400, String(slug));
      assert.match((r.json as { error: string }).error, says, String(slug));
      // The Venues card shows it as written: a sentence, never capitalised there.
      assert.match((r.json as { error: string }).error, /^[A-Z]/, `the refusal of ${String(slug)} is not a sentence`);
    }
    assert.deepEqual(await venueNow(v.id).then((x) => [x.slug, x.oldSlugs]), ["main-room", []]);
  });

  test("a venue saved before addresses existed has none, answers at its id, and can be given one", async () => {
    await stageplotsStore.update((d) => ({ ...d, venues: [{ id: "v-old", name: "Old room", slug: null, oldSlugs: [], kind: "home", notes: "", plotIds: [], defaultPlotId: null }] }));
    const r = await patchVenue("v-old", { slug: "old-room" });
    assert.equal(r.status, 200, r.body);
    // Its id was never an old address: it opens the venue anyway, as every id does.
    assert.deepEqual(await venueNow("v-old").then((x) => [x.slug, x.oldSlugs]), ["old-room", []]);
  });

  test("a document where two venues answer to one address is refused", async () => {
    await venue("Chapel");
    await assert.rejects(
      stageplotsStore.update((d) => ({ ...d, venues: [...d.venues, { id: "v-2", name: "Another", slug: "x", oldSlugs: ["chapel"], kind: "home", notes: "", plotIds: [], defaultPlotId: null }] })),
      /both answer to the address "chapel"/,
    );
  });
});

describe("plot items: PUT /api/stageplots/plots/:id/items", () => {
  type PlotJson = { id: string; version: number; items: Record<string, unknown>[] };
  const box = (over: Record<string, unknown> = {}) => ({
    id: "i-1",
    type: "box",
    x: 100,
    y: 100,
    w: 80,
    h: 60,
    rotation: 0,
    label: "Drum riser",
    color: null,
    notes: "",
    inputs: [],
    ...over,
  });
  const save = (id: string, version: number, items: unknown) => call("PUT", `/api/stageplots/plots/${id}/items`, { version, items });
  async function fresh() {
    const v = await venue();
    return plot(v.id);
  }
  async function refusedWith(id: string, items: unknown, why: RegExp) {
    let r!: Awaited<ReturnType<typeof call>>;
    const said = await warnings(async () => {
      r = await save(id, 0, items);
    });
    assert.equal(r.status, 400, r.body);
    assert.match((r.json as { error: string }).error, why);
    assert.ok(said.some((w) => /items refused/.test(w)), `the refusal was not said on [stageplots]: ${said.join("\n")}`);
    assert.deepEqual((await stageplotsStore.get()).plots[0].items, [], "a refused save stored something");
  }

  test("an unknown type is 400", async () => {
    const p = await fresh();
    await refusedWith(p.id, [box({ type: "triangle" })], /type/);
  });

  test("a symbol outside SYMBOL_KINDS is 400", async () => {
    const p = await fresh();
    await refusedWith(p.id, [box({ type: "symbol", symbol: "harp" })], /symbol/);
  });

  test("a colour outside PATCH_COLORS is 400", async () => {
    const p = await fresh();
    await refusedWith(p.id, [box({ color: "#123456" })], /colou?r/);
  });

  test("NaN or out-of-plot geometry is 400", async () => {
    const p = await fresh();
    // JSON has no NaN: a client that sends one sends null, or a string.
    await refusedWith(p.id, [box({ x: null })], /x/);
    await refusedWith(p.id, [box({ x: "NaN" })], /x/);
    await refusedWith(p.id, [box({ y: 563 })], /y/); // the grid plot is 562.5 high
    await refusedWith(p.id, [box({ x: 1001 })], /x/);
  });

  test("the 501st item is 400", async () => {
    const p = await fresh();
    const many = Array.from({ length: 501 }, (_, i) => box({ id: `i-${i}` }));
    await refusedWith(p.id, many, /500 items/);
    const r = await save(p.id, 0, many.slice(0, 500));
    assert.equal(r.status, 200, r.body);
  });

  test("a cable with one point is 400", async () => {
    const p = await fresh();
    await refusedWith(p.id, [box({ type: "cable", points: [[10, 10]], dashed: false })], /2 to 50 points/);
  });

  test("a refused body is said on [stageplots]: not an object, or an unknown plot", async () => {
    const p = await fresh();
    let r!: Awaited<ReturnType<typeof call>>;
    let said = await warnings(async () => {
      r = await call("PUT", `/api/stageplots/plots/${p.id}/items`, [1, 2]);
    });
    assert.equal(r.status, 400, r.body);
    assert.ok(said.some((w) => /items refused .*not a JSON object/.test(w)), said.join("\n"));
    said = await warnings(async () => {
      r = await save("p-nowhere", 0, []);
    });
    assert.equal(r.status, 404, r.body);
    assert.ok(said.some((w) => /items refused for plot p-nowhere: no such plot/.test(w)), said.join("\n"));
  });

  test("a body without a whole-number version is 400", async () => {
    const p = await fresh();
    const r = await call("PUT", `/api/stageplots/plots/${p.id}/items`, { items: [] });
    assert.equal(r.status, 400, r.body);
    assert.match((r.json as { error: string }).error, /version/);
    assert.equal((await call("PUT", "/api/stageplots/plots/p-nowhere/items", { version: 0, items: [] })).status, 404);
  });

  test("a stale version is 409 and stores nothing", async () => {
    const p = await fresh();
    assert.equal((await save(p.id, 0, [box()])).status, 200);
    frames.length = 0;
    let r!: Awaited<ReturnType<typeof call>>;
    const said = await warnings(async () => {
      r = await save(p.id, 0, [box({ label: "Overwritten" })]);
    });
    assert.equal(r.status, 409, r.body);
    assert.deepEqual(r.json, { error: "changed elsewhere", version: 1 });
    assert.ok(said.some((w) => /changed elsewhere/.test(w)), said.join("\n"));
    const stored = (await stageplotsStore.get()).plots[0];
    assert.equal(stored.items[0].label, "Drum riser");
    assert.equal(stored.version, 1);
    assert.equal(frames.length, 0, "a refused save broadcast");
  });

  test("two saves on one version: one lands, the other is 409, one broadcast", async () => {
    const p = await fresh();
    frames.length = 0;
    const [a, b] = await Promise.all([save(p.id, 0, [box({ label: "First" })]), save(p.id, 0, [box({ label: "Second" })])]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const winner = a.status === 200 ? "First" : "Second";
    const stored = (await stageplotsStore.get()).plots[0];
    assert.equal(stored.items[0].label, winner);
    assert.equal(stored.version, 1);
    assert.equal(frames.length, 1);
  });

  test("a good save bumps version and broadcasts once", async () => {
    const p = await fresh();
    frames.length = 0;
    const r = await save(p.id, 0, [box({ secret: "dropped" }), box({ id: "i-2", type: "symbol", symbol: "drumkit", color: "#e5484d", inputs: ["Kick In"] })]);
    assert.equal(r.status, 200, r.body);
    const saved = (r.json as { plot: PlotJson }).plot;
    assert.equal(saved.version, 1);
    assert.equal(saved.items.length, 2);
    assert.equal("secret" in saved.items[0], false, "an unknown field was kept");
    assert.equal(frames.length, 1);
    assert.deepEqual((frames[0] as View).plots[0], saved);
  });

  test("an unchanged save writes nothing, broadcasts nothing and keeps the version", async () => {
    const p = await fresh();
    assert.equal((await save(p.id, 0, [box()])).status, 200);
    const file = path.join(TMP, "stageplots.json");
    const before = (await fs.stat(file)).mtimeMs;
    frames.length = 0;
    const r = await save(p.id, 1, [box()]);
    assert.equal(r.status, 200, r.body);
    assert.equal((r.json as { plot: PlotJson }).plot.version, 1);
    assert.equal(frames.length, 0);
    assert.equal((await fs.stat(file)).mtimeMs, before);
  });

  test("every write rebuilds items, so a duplicate never shares one with its original", async () => {
    const p = await fresh();
    assert.equal((await save(p.id, 0, [box({ inputs: ["Kick In"] })])).status, 200);
    const copy = (await call("POST", `/api/stageplots/plots/${p.id}/duplicate`)).json as PlotJson;
    const doc = await stageplotsStore.get();
    const [orig, dup] = [doc.plots.find((x) => x.id === p.id)!, doc.plots.find((x) => x.id === copy.id)!];
    // The store keeps the document in memory: a copy that shares an item object
    // with its original changes both the moment either is edited in place. What
    // keeps them apart is checkStagePlotsDoc rebuilding every item on every write
    // (checkItems), not the duplicate route's own structuredClone.
    assert.notEqual(dup.items[0], orig.items[0], "the copy shares an item object with the original");
    assert.notEqual(dup.items[0].inputs, orig.items[0].inputs, "the copy shares an inputs list with the original");
    assert.equal((await save(copy.id, 0, [box({ label: "Changed" })])).status, 200);
    assert.equal((await stageplotsStore.get()).plots.find((x) => x.id === p.id)!.items[0].label, "Drum riser");
  });

  test("a plot with a full-height cable on a 3:2 plan switches to a shorter background, the cable fitted", async () => {
    const plan = (await upload("/api/stageplots/backgrounds?name=Plan.jpg", await jpeg(2400, 1600))).json as View["backgrounds"][number];
    const wide = (await upload("/api/stageplots/backgrounds?name=Wide.jpg", await jpeg(600, 300))).json as View["backgrounds"][number];
    const v = await venue();
    const p = await plot(v.id, "Standard", plan.id);
    const H32 = 2000 / 3;
    const cable = box({ type: "cable", points: [[50, 0], [50, H32]], dashed: true, x: 50, y: 0, w: 0, h: H32 });
    assert.equal((await save(p.id, 0, [cable])).status, 200);
    const r = await call("PATCH", `/api/stageplots/plots/${p.id}`, { backgroundId: wide.id });
    assert.equal(r.status, 200, r.body);
    const stored = (await stageplotsStore.get()).plots[0];
    assert.deepEqual(stored.items[0].points, [[50, 0], [50, 500]]);
    assert.equal(stored.items[0].h, 500);
  });

  test("a background switch moves an item below the new bottom back onto the plot, and says so", async () => {
    const tall = (await upload("/api/stageplots/backgrounds?name=Tall.jpg", await jpeg(600, 900))).json as View["backgrounds"][number];
    const v = await venue();
    const p = await plot(v.id, "Standard", tall.id);
    // 600 x 900 is a plot 1500 units high.
    const items = [
      box({ y: 1200, h: 60 }),
      box({ id: "i-2", type: "cable", points: [[10, 20], [300, 1400]], dashed: true, x: 10, y: 20, w: 290, h: 1380 }),
      box({ id: "i-3", y: 50 }),
    ];
    assert.equal((await save(p.id, 0, items)).status, 200);
    let r!: Awaited<ReturnType<typeof call>>;
    const said: string[] = [];
    const real = console.log;
    console.log = (...a: unknown[]) => void said.push(a.join(" "));
    try {
      r = await call("PATCH", `/api/stageplots/plots/${p.id}`, { backgroundId: null });
    } finally {
      console.log = real;
    }
    assert.equal(r.status, 200, r.body);
    const stored = (await stageplotsStore.get()).plots[0];
    assert.equal(stored.items[0].y, 562.5 - 60);
    assert.deepEqual(stored.items[1].points, [[10, 20], [300, 562.5]]);
    assert.equal(stored.items[1].h, 542.5);
    assert.equal(stored.items[2].y, 50, "an item already on the plot moved");
    assert.ok(said.some((l) => /\[stageplots\].*2 items moved/.test(l)), said.join("\n"));
  });
});

describe("plot drafts", () => {
  const box = (id = "i-1", x = 10) => ({ id, type: "box", x, y: 10, w: 100, h: 50, rotation: 0, label: "Riser", color: null, notes: "", inputs: [] });
  const keep = (plotId: string, body: unknown) => call("PUT", `/api/stageplots/plots/${plotId}/draft`, body);
  const draftsNow = async () => ((await call("GET", "/api/stageplots/drafts")).json as { drafts: { plotId: string; baseVersion: number; items: unknown[]; savedAt: string }[] }).drafts;
  const notes: unknown[] = [];
  addBroadcastListener((channel, payload) => {
    if (channel === STAGEPLOT_DRAFTS_CHANNEL) notes.push(payload);
  });
  beforeEach(async () => {
    await plotDraftsStore.update(() => []);
    notes.length = 0;
  });

  test("a kept draft is listed, says which plot on stageplots:drafts, and never touches the plot", async () => {
    const v = await venue();
    const p = await plot(v.id);
    const before = (await stageplotsStore.get()).plots[0];
    frames.length = 0;
    const r = await keep(p.id, { baseVersion: 0, items: [box()] });
    assert.equal(r.status, 200, r.body);
    const { savedAt } = r.json as { savedAt: string };
    assert.deepEqual(r.json, { plotId: p.id, baseVersion: 0, savedAt });
    assert.deepEqual(await draftsNow(), [{ plotId: p.id, baseVersion: 0, items: [box()], savedAt }]);
    // Which plot, and since when: never the items.
    assert.deepEqual(notes, [{ drafts: [{ plotId: p.id, savedAt }] }]);
    assert.equal(frames.length, 0, "a draft broadcast stageplots:updated");
    assert.deepEqual((await stageplotsStore.get()).plots[0], before, "a draft changed the plot");
  });

  test("a draft is held to a save's rules; a refusal stores nothing and is said on [stageplots]", async () => {
    const v = await venue();
    const p = await plot(v.id);
    for (const [plotId, body, status, says] of [
      ["p-nowhere", { baseVersion: 0, items: [] }, 404, /no such plot/],
      [p.id, { baseVersion: -1, items: [] }, 400, /baseVersion/],
      [p.id, { baseVersion: 0, items: [{ ...box(), type: "blob" }] }, 400, /type must be one of/],
      [p.id, { baseVersion: 0, items: [{ ...box(), y: 9999 }] }, 400, /y must be a number/],
      [p.id, { baseVersion: 0, items: Array.from({ length: 501 }, (_, i) => box(`i-${i}`)) }, 400, /at most 500 items/],
    ] as const) {
      const said = await warnings(async () => {
        const r = await keep(plotId, body);
        assert.equal(r.status, status, r.body);
        assert.match((r.json as { error: string }).error, says);
      });
      assert.equal(said.length, 1, String(says));
      assert.match(said[0], new RegExp(`draft refused for plot ${plotId}`));
    }
    assert.deepEqual(await draftsNow(), []);
    assert.deepEqual(notes, []);
  });

  test("one draft per plot: keeping again replaces it", async () => {
    const v = await venue();
    const p = await plot(v.id);
    await keep(p.id, { baseVersion: 0, items: [box()] });
    await keep(p.id, { baseVersion: 0, items: [box("i-1", 300)] });
    const drafts = await draftsNow();
    assert.equal(drafts.length, 1);
    assert.equal((drafts[0].items[0] as { x: number }).x, 300);
  });

  test("a save deletes the plot's draft, an unchanged save too, before it answers", async () => {
    const v = await venue();
    const p = await plot(v.id);
    await keep(p.id, { baseVersion: 0, items: [box()] });
    assert.equal((await call("PUT", `/api/stageplots/plots/${p.id}/items`, { version: 0, items: [box()] })).status, 200);
    assert.deepEqual(await draftsNow(), []);
    assert.deepEqual(notes.at(-1), { drafts: [] });
    await keep(p.id, { baseVersion: 1, items: [box("i-1", 50)] });
    assert.equal((await call("PUT", `/api/stageplots/plots/${p.id}/items`, { version: 1, items: [box()] })).status, 200);
    assert.deepEqual(await draftsNow(), [], "an unchanged save left the draft");
  });

  test("a refused save keeps the draft", async () => {
    const v = await venue();
    const p = await plot(v.id);
    await keep(p.id, { baseVersion: 0, items: [box()] });
    assert.equal((await call("PUT", `/api/stageplots/plots/${p.id}/items`, { version: 7, items: [box()] })).status, 409);
    assert.equal((await draftsNow()).length, 1);
  });

  test("Discard deletes it; a plot with none is not an error", async () => {
    const v = await venue();
    const p = await plot(v.id);
    await keep(p.id, { baseVersion: 0, items: [box()] });
    assert.deepEqual((await call("DELETE", `/api/stageplots/plots/${p.id}/draft`)).json, { ok: true });
    assert.deepEqual(await draftsNow(), []);
    const r = await call("DELETE", `/api/stageplots/plots/${p.id}/draft`);
    assert.deepEqual([r.status, r.json], [200, { ok: true }]);
  });

  test("deleting a plot, or its venue, deletes its draft and leaves another plot's", async () => {
    const v = await venue("Main room");
    const a = await plot(v.id, "Standard");
    const b = await plot(v.id, "Baptism");
    const w = await venue("Chapel");
    const c = await plot(w.id, "Standard");
    for (const p of [a, b, c]) await keep(p.id, { baseVersion: 0, items: [box()] });
    // Read from the store, not GET, which leaves a draft whose plot is gone out of its answer.
    await call("DELETE", `/api/stageplots/plots/${b.id}`);
    assert.deepEqual((await plotDraftsStore.all()).map((d) => d.plotId).sort(), [a.id, c.id].sort());
    await call("DELETE", `/api/stageplots/venues/${v.id}`);
    assert.deepEqual((await plotDraftsStore.all()).map((d) => d.plotId), [c.id]);
  });

  test("a rename or a fade moves a draft's base to the new version; a background that moved items does not", async () => {
    const v = await venue();
    const p = await plot(v.id);
    await keep(p.id, { baseVersion: 0, items: [box()] });
    await call("PATCH", `/api/stageplots/plots/${p.id}`, { name: "Renamed" });
    await call("PATCH", `/api/stageplots/plots/${p.id}`, { bgFade: 0.7 });
    assert.equal((await stageplotsStore.get()).plots[0].version, 2);
    assert.equal((await draftsNow())[0].baseVersion, 2, "a change that left the items alone made the draft look stale");
    // A draft drawn on an older version stays behind: its items were not these.
    await keep(p.id, { baseVersion: 1, items: [box()] });
    await call("PATCH", `/api/stageplots/plots/${p.id}`, { name: "Again" });
    assert.equal((await draftsNow())[0].baseVersion, 1);
  });

  test("a background switch that moves items leaves the draft's base behind", async () => {
    const v = await venue();
    const p = await plot(v.id);
    // An item low on the 16:9 grid, then a wide background that is shorter.
    assert.equal((await call("PUT", `/api/stageplots/plots/${p.id}/items`, { version: 0, items: [{ ...box(), y: 500 }] })).status, 200);
    await keep(p.id, { baseVersion: 1, items: [{ ...box(), y: 500 }, box("i-2")] });
    const bytes = await jpeg(1600, 400);
    const bg = (await upload("/api/stageplots/backgrounds?name=Wide", bytes)).json as { id: string };
    assert.equal((await call("PATCH", `/api/stageplots/plots/${p.id}`, { backgroundId: bg.id })).status, 200);
    assert.equal((await stageplotsStore.get()).plots[0].version, 2);
    assert.equal((await draftsNow())[0].baseVersion, 1);
  });

  test("a draft whose plot is gone is left out when the drafts are read, said once, and never deleted by the read", async () => {
    const v = await venue();
    const p = await plot(v.id);
    await keep(p.id, { baseVersion: 0, items: [box()] });
    await plotDraftsStore.update((d) => [...d, { plotId: "p-gone", baseVersion: 3, items: [], savedAt: "2026-11-14T14:32:00.000Z" }]);
    const said = await warnings(async () => assert.deepEqual((await draftsNow()).map((d) => d.plotId), [p.id]));
    assert.deepEqual(said, ["[stageplots] 1 unsaved drafts left out: their plots are not in stageplots.json (p-gone); they stay in stageplot-drafts.json"]);
    assert.deepEqual((await plotDraftsStore.all()).map((d) => d.plotId).sort(), [p.id, "p-gone"].sort(), "a read deleted a draft");
    assert.deepEqual(await warnings(() => draftsNow()), [], "the same draft left out was said again on the next read");
  });

  test("a drafts store that cannot be written never turns a save, a rename or a delete into a failure: the answer says so", async (t) => {
    const v = await venue("Main room");
    const a = await plot(v.id, "Standard");
    const b = await plot(v.id, "Baptism");
    const w = await venue("Chapel");
    await plot(w.id, "Standard");
    await keep(a.id, { baseVersion: 0, items: [box()] });
    t.mock.method(plotDraftsStore, "update", async () => {
      throw new Error("stageplot-drafts.json could not be written (ENOSPC)");
    });
    const errors: string[] = [];
    t.mock.method(console, "error", (...m: unknown[]) => void errors.push(m.join(" ")));
    const notice = (r: { json: unknown }) => (r.json as { draftNotice?: string }).draftNotice ?? "";

    let r = await call("PUT", `/api/stageplots/plots/${a.id}/items`, { version: 0, items: [box("i-2")] });
    assert.equal(r.status, 200, r.body);
    assert.equal((r.json as { plot: { version: number } }).plot.version, 1);
    assert.match(notice(r), /^Saved, but the plot's unsaved draft could not be deleted, so it may open again: .*ENOSPC/);

    r = await call("PATCH", `/api/stageplots/plots/${a.id}`, { name: "Renamed" });
    assert.equal(r.status, 200, r.body);
    assert.equal((r.json as { name: string }).name, "Renamed");
    assert.match(notice(r), /^Saved, but the plot's unsaved draft could not be moved onto this version, so it may open as saved elsewhere: /);

    r = await call("DELETE", `/api/stageplots/plots/${b.id}`);
    assert.equal(r.status, 200, r.body);
    assert.equal((r.json as { ok: boolean }).ok, true);
    assert.match(notice(r), /^The plot was deleted, but its unsaved draft could not be deleted with it: /);

    r = await call("DELETE", `/api/stageplots/venues/${w.id}`);
    assert.equal(r.status, 200, r.body);
    assert.match(notice(r), /^The venue was deleted, but the unsaved drafts of its plots could not be deleted with it: /);

    assert.deepEqual(
      (await stageplotsStore.get()).plots.map((p) => p.name),
      ["Renamed"],
      "a save, a rename or a delete did not land",
    );
    assert.equal(errors.filter((e) => e.startsWith("[stageplots] a draft could not be written")).length, 4, errors.join(" | "));
  });
});

describe("per-plan overrides", () => {
  const put = (body: unknown) => call("PUT", "/api/stageplots/overrides", body);
  /** Every [stageplots] line `run` logs. */
  async function said(run: () => Promise<unknown>): Promise<string[]> {
    const seen: string[] = [];
    const real = console.log;
    console.log = (...a: unknown[]) => void seen.push(a.join(" "));
    try {
      await run();
    } finally {
      console.log = real;
    }
    return seen.filter((l) => l.startsWith("[stageplots]"));
  }

  async function room() {
    const v = await venue();
    const std = await plot(v.id, "Standard");
    const bap = await plot(v.id, "Baptism");
    const xmas = await plot(v.id, "Christmas");
    return { v, std, bap, xmas };
  }

  test("PUT sets an override, answers the document, broadcasts once and says so", async () => {
    const { v, bap } = await room();
    frames.length = 0;
    let r!: Awaited<ReturnType<typeof call>>;
    const lines = await said(async () => {
      r = await put({ planId: "101", venueId: v.id, plotId: bap.id, planDate: "2026-11-16T15:00:00Z" });
    });
    assert.equal(r.status, 200, r.body);
    const stored = (await stageplotsStore.get()).overrides;
    assert.deepEqual(stored, [{ planId: "101", venueId: v.id, plotId: bap.id, planDate: "2026-11-16T15:00:00.000Z" }]);
    assert.deepEqual((r.json as View).overrides, stored);
    assert.equal(frames.length, 1);
    assert.deepEqual((frames[0] as View).overrides, stored);
    assert.ok(lines.some((l) => l.includes("plan 101") && l.includes("Baptism")), lines.join("\n"));
  });

  test("the same override again, or removing one that is not there, writes and broadcasts nothing", async () => {
    const { v, bap } = await room();
    assert.equal((await put({ planId: "101", venueId: v.id, plotId: bap.id, planDate: "2026-11-16T15:00:00Z" })).status, 200);
    const file = path.join(TMP, "stageplots.json");
    const before = (await fs.stat(file)).mtimeMs;
    frames.length = 0;
    // The same date in another spelling is the same instant.
    let r = await put({ planId: "101", venueId: v.id, plotId: bap.id, planDate: "2026-11-16T15:00:00.000Z" });
    assert.equal(r.status, 200, r.body);
    // A save that does not know the date keeps the one stored.
    r = await put({ planId: "101", venueId: v.id, plotId: bap.id, planDate: null });
    assert.equal(r.status, 200, r.body);
    r = await put({ planId: "999", venueId: v.id, plotId: null });
    assert.equal(r.status, 200, r.body);
    assert.equal(frames.length, 0, "a change that changed nothing broadcast");
    assert.equal((await fs.stat(file)).mtimeMs, before, "a change that changed nothing wrote the file");
    assert.equal((await stageplotsStore.get()).overrides[0].planDate, "2026-11-16T15:00:00.000Z");
  });

  test("plotId null removes the override", async () => {
    const { v, bap } = await room();
    await put({ planId: "101", venueId: v.id, plotId: bap.id });
    frames.length = 0;
    const r = await put({ planId: "101", venueId: v.id, plotId: null });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual((await stageplotsStore.get()).overrides, []);
    assert.equal(frames.length, 1);
  });

  test("an unknown venue is 404, another venue's plot and a bad body 400, each said on [stageplots] and none stored", async () => {
    const { v, bap } = await room();
    const other = await venue("Chapel");
    const otherPlot = await plot(other.id, "Chapel");
    frames.length = 0;
    const cases: [unknown, number, RegExp][] = [
      [{ planId: "101", venueId: "v-nowhere", plotId: bap.id }, 404, /no such venue/],
      [{ planId: "101", venueId: v.id, plotId: otherPlot.id }, 400, /one of the venue's plots/],
      [{ planId: "101", venueId: v.id, plotId: "p-gone" }, 400, /one of the venue's plots/],
      [{ planId: "1/2", venueId: v.id, plotId: bap.id }, 400, /plan id/],
      [{ venueId: v.id, plotId: bap.id }, 400, /plan id/],
      [{ planId: "101", venueId: v.id, plotId: 7 }, 400, /plotId/],
      [{ planId: "101", venueId: v.id, plotId: bap.id, planDate: "soon" }, 400, /date/],
      [[1, 2], 400, /object/],
    ];
    for (const [body, status, why] of cases) {
      let r!: Awaited<ReturnType<typeof call>>;
      const w = await warnings(async () => {
        r = await put(body);
      });
      assert.equal(r.status, status, `${JSON.stringify(body)}: ${r.body}`);
      assert.match(String((r.json as { error?: string } | null)?.error), why);
      assert.ok(w.some((l) => l.includes("override refused")), `${JSON.stringify(body)} was refused without a word: ${w.join(" | ")}`);
    }
    assert.deepEqual((await stageplotsStore.get()).overrides, []);
    assert.equal(frames.length, 0);
  });

  test("a refusal's log line is scrubbed", async () => {
    const w = await warnings(() => put({ planId: "101", venueId: "v-x\n[stageplots] forged", plotId: "p-1" }));
    assert.ok(w.length > 0);
    assert.ok(w.every((l) => !l.includes("\n")), w.join(" | "));
  });

  test("deleting a plot removes its overrides and names the plans", async () => {
    const { v, std, bap, xmas } = await room();
    await put({ planId: "101", venueId: v.id, plotId: bap.id });
    await put({ planId: "102", venueId: v.id, plotId: xmas.id });
    await put({ planId: "103", venueId: v.id, plotId: bap.id });
    let r!: Awaited<ReturnType<typeof call>>;
    const lines = await said(async () => {
      r = await call("DELETE", `/api/stageplots/plots/${bap.id}`);
    });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(r.json, { ok: true, clearedPlans: ["101", "103"], defaultPlotId: std.id });
    assert.deepEqual(
      (await stageplotsStore.get()).overrides.map((o) => o.planId),
      ["102"],
    );
    assert.ok(lines.some((l) => /2 plan overrides cleared/.test(l)), lines.join("\n"));
    // A plot no plan overrides clears none.
    r = await call("DELETE", `/api/stageplots/plots/${xmas.id}`);
    assert.deepEqual(r.json, { ok: true, clearedPlans: ["102"], defaultPlotId: std.id });
  });

  test("deleting a venue takes its overrides with it, and leaves another venue's", async () => {
    const { v, bap } = await room();
    const other = await venue("Chapel");
    await plot(other.id, "Chapel");
    const otherAlt = await plot(other.id, "Chapel alt");
    await put({ planId: "101", venueId: v.id, plotId: bap.id });
    await put({ planId: "101", venueId: other.id, plotId: otherAlt.id });
    const r = await call("DELETE", `/api/stageplots/venues/${v.id}`);
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(
      (await stageplotsStore.get()).overrides.map((o) => o.venueId),
      [other.id],
    );
  });

  test("at the 2000-override limit a new override is refused and said; a change to one already there is not", async () => {
    const { v, bap, xmas } = await room();
    await stageplotsStore.update((d) => ({
      ...d,
      overrides: Array.from({ length: 2000 }, (_, i) => ({ planId: String(10_000 + i), venueId: v.id, plotId: bap.id, planDate: null })),
    }));
    frames.length = 0;
    let r!: Awaited<ReturnType<typeof call>>;
    const w = await warnings(async () => {
      r = await put({ planId: "1", venueId: v.id, plotId: bap.id });
    });
    assert.equal(r.status, 400, r.body);
    assert.match(String((r.json as { error: string }).error), /at most 2000 overrides/);
    assert.ok(w.some((l) => l.includes("override refused")), w.join(" | "));
    assert.equal(frames.length, 0);
    r = await put({ planId: "10000", venueId: v.id, plotId: xmas.id });
    assert.equal(r.status, 200, r.body);
    assert.equal((await stageplotsStore.get()).overrides.length, 2000);
  });

  test("an override for a past plan is kept by every other change", async () => {
    const { v, bap, std } = await room();
    await put({ planId: "50", venueId: v.id, plotId: bap.id, planDate: "2020-01-05T15:00:00Z" });
    await call("PATCH", `/api/stageplots/plots/${bap.id}`, { name: "Baptism 2" });
    await call("POST", `/api/stageplots/venues/${v.id}/default`, { plotId: bap.id });
    await call("POST", `/api/stageplots/venues/${v.id}/default`, { plotId: std.id });
    assert.deepEqual(
      (await stageplotsStore.get()).overrides.map((o) => o.planId),
      ["50"],
    );
  });
});


describe("publishing: POST /api/stageplots/venues/:id/publish and the rest", () => {
  // The page is the Worker's own request handler over HTTP (fixtures/publish-receiver.ts); the
  // address and token are saved where the ServiceCue Public link card saves them.
  const TOKEN = "p".repeat(40);
  const venueWithPlot = async () => {
    const v = (await call("POST", "/api/stageplots/venues", { name: "Main room", kind: "home" })).json as { id: string };
    await call("POST", "/api/stageplots/plots", { venueId: v.id, name: "Standard" });
    return v.id;
  };

  test("with no page set up, every action is a 409 that says where to set it up", async () => {
    const { servicecuePublishStore, forgetPublishToken } = await import("../servicecue-publish-store.js");
    await servicecuePublishStore.save({ enabled: false, url: "" });
    await forgetPublishToken();
    const id = await venueWithPlot();
    const r = await call("POST", `/api/stageplots/venues/${id}/publish`);
    assert.equal(r.status, 409);
    assert.match((r.json as { error: string }).error, /^Set up the public link first/);
    for (const action of ["regenerate", "unpublish", "publish-now"]) {
      assert.equal((await call("POST", `/api/stageplots/venues/${id}/${action}`)).status, 409, action);
    }
    assert.equal((await call("POST", "/api/stageplots/venues/v-nope/publish")).status, 404);
  });

  /** A page set up as the Public link card saves one, the publisher started, and `run` handed it. */
  async function withPage(run: (page: Awaited<ReturnType<(typeof import("../fixtures/publish-receiver.js"))["FakeReceiver"]["start"]>>) => Promise<void>) {
    const { FakeReceiver } = await import("../fixtures/publish-receiver.js");
    const { servicecuePublishStore, savePublishToken } = await import("../servicecue-publish-store.js");
    const { parsePublishUrl } = await import("../servicecue-publish-rules.js");
    const { stageplotsPublisher } = await import("../stageplots-publish-instance.js");
    const page = await FakeReceiver.start();
    try {
      page.token = TOKEN;
      const parsed = parsePublishUrl(page.origin);
      assert.ok(parsed.ok);
      await servicecuePublishStore.save({ enabled: false, url: parsed.origin });
      await savePublishToken(parsed.origin, TOKEN);
      stageplotsPublisher.start();
      await run(page);
      await stageplotsPublisher.settle();
    } finally {
      await page.close();
    }
  }
  const settled = async () => {
    const { stageplotsPublisher } = await import("../stageplots-publish-instance.js");
    await stageplotsPublisher.settle();
    // The landing list goes on its own chain, after the broadcast that settle does not wait for.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
    await stageplotsPublisher.settle();
  };
  const landingOn = (page: { hub: { landing: string | null } }) => (page.hub.landing === null ? null : (JSON.parse(page.hub.landing) as { venues: { name: string; secret: string; plots: number }[] }));

  test("no secret is in GET /api/stageplots, a stageplots:updated frame or any answer: GET …/link alone carries it", async () => {
    const { parsePublishUrl } = await import("../servicecue-publish-rules.js");
    await withPage(async (page) => {
      const origin = parsePublishUrl(page.origin);
      assert.ok(origin.ok);
      const id = await venueWithPlot();
      const plotId = (await stageplotsStore.get()).venues.find((v) => v.id === id)!.plotIds[0]!;
      await settled();
      frames.length = 0;
      const answers: [string, unknown][] = [];
      const answer = async (method: string, p: string, body?: unknown) => {
        const r = await call(method, p, body);
        assert.equal(r.status, 200, `${method} ${p}: ${r.body}`);
        answers.push([`${method} ${p}`, r.json]);
      };
      await answer("POST", `/api/stageplots/venues/${id}/publish`);
      const secret = await storedSecret(id);
      assert.match(secret, /^[A-Za-z0-9_-]{43}$/, "the store holds no secret to look for");
      // Both ways a frame is made: the publisher's own writes, and a route's save.
      const fromPublisher = frames.length;
      assert.ok(fromPublisher > 0, "the publisher's own save broadcast nothing");
      await answer("PATCH", `/api/stageplots/venues/${id}`, { notes: "Side door" });
      assert.ok(frames.length > fromPublisher, "the route's save broadcast nothing");
      await answer("POST", `/api/stageplots/venues/${id}/default`, { plotId });
      await answer("POST", `/api/stageplots/venues/${id}/listed`, { listed: true });
      await answer("POST", `/api/stageplots/venues/${id}/publish-now`);
      await settled();
      const get = await call("GET", "/api/stageplots");
      assert.equal((get.json as View).venues[0]?.publish?.origin, origin.origin, "the venue is not shown as published at all");
      const seen: [string, unknown][] = [["GET /api/stageplots", get.json], ...frames.map((f, i): [string, unknown] => [`stageplots:updated frame ${i + 1} of ${frames.length}`, f]), ...answers];
      for (const [what, body] of seen) assert.equal(JSON.stringify(body).includes(secret), false, `${what} carries the secret`);
      // The manage page's own read.
      const link = await call("GET", `/api/stageplots/venues/${id}/link`);
      assert.deepEqual(link.json, { url: `${origin.origin}/stageplots/${secret}` });
      assert.equal(link.headers["Cache-Control"], "no-store", "the link may be cached, and outlive a regenerate");
      await answer("POST", `/api/stageplots/venues/${id}/unpublish`);
      assert.deepEqual((await call("GET", `/api/stageplots/venues/${id}/link`)).json, { url: null });
      assert.equal((await call("GET", "/api/stageplots/venues/v-000000000000/link")).status, 404);
    });
  });

  test("a listed venue is on its page's landing list, names and links only, and the list follows every change to it", async () => {
    await withPage(async (page) => {
      const id = await venueWithPlot();
      const secret = await publishVenue(id);
      await settled();
      assert.deepEqual(landingOn(page)?.venues ?? [], [], "a venue was listed before it was asked");
      let r = await call("POST", `/api/stageplots/venues/${id}/listed`, { listed: true });
      assert.equal(r.status, 200, r.body);
      assert.equal((r.json as { publish: { listed: boolean } }).publish.listed, true);
      assert.deepEqual(landingOn(page), { venues: [{ name: "Main room", secret, plots: 1 }] });
      // A rename and a new plot: sent again.
      await call("PATCH", `/api/stageplots/venues/${id}`, { name: "Main Auditorium", notes: "Side door" });
      await call("POST", "/api/stageplots/plots", { venueId: id, name: "Baptism" });
      await settled();
      assert.deepEqual(landingOn(page), { venues: [{ name: "Main Auditorium", secret, plots: 2 }] }, "the notes, or a stale name or count, reached the list");
      // A regenerate lists the new link, still listed.
      r = await call("POST", `/api/stageplots/venues/${id}/regenerate`);
      assert.equal(r.status, 200, r.body);
      assert.equal((r.json as { publish: { listed: boolean } }).publish.listed, true, "the regenerate dropped the listing");
      await settled();
      assert.deepEqual(landingOn(page), { venues: [{ name: "Main Auditorium", secret: await storedSecret(id), plots: 2 }] });
      // Unpublished: off the list.
      await call("POST", `/api/stageplots/venues/${id}/unpublish`);
      await settled();
      assert.deepEqual(landingOn(page), { venues: [] });
      await call("DELETE", `/api/stageplots/venues/${id}`);
    });
  });

  test("taking a venue off the landing page, or deleting it, takes it off the list", async () => {
    await withPage(async (page) => {
      const a = await venueWithPlot();
      const b = (await call("POST", "/api/stageplots/venues", { name: "Chapel", kind: "offsite" })).json as { id: string };
      for (const id of [a, b.id]) {
        assert.equal((await call("POST", `/api/stageplots/venues/${id}/publish`)).status, 200);
        assert.equal((await call("POST", `/api/stageplots/venues/${id}/listed`, { listed: true })).status, 200);
      }
      assert.deepEqual(landingOn(page)!.venues.map((v) => v.name), ["Main room", "Chapel"]);
      assert.equal((await call("POST", `/api/stageplots/venues/${a}/listed`, { listed: false })).status, 200);
      assert.deepEqual(landingOn(page)!.venues.map((v) => v.name), ["Chapel"]);
      await call("DELETE", `/api/stageplots/venues/${b.id}`);
      await settled();
      assert.deepEqual(landingOn(page), { venues: [] });
      await call("DELETE", `/api/stageplots/venues/${a}`);
    });
  });

  test("only a published venue can be listed, and listed is true or false", async () => {
    await withPage(async () => {
      const id = await venueWithPlot();
      const said = await warnings(async () => {
        const r = await call("POST", `/api/stageplots/venues/${id}/listed`, { listed: true });
        assert.equal(r.status, 409);
        assert.match((r.json as { error: string }).error, /not published/);
      });
      assert.equal(said.length, 1);
      assert.equal((await call("POST", `/api/stageplots/venues/${id}/listed`, { listed: "yes" })).status, 400);
      assert.equal((await call("POST", "/api/stageplots/venues/v-nowhere/listed", { listed: true })).status, 404);
      await call("DELETE", `/api/stageplots/venues/${id}`);
    });
  });

  test("a page whose Worker predates landing pages: the listing is saved, the card says the page needs updating, said once", async () => {
    await withPage(async (page) => {
      const real = page.respond;
      page.respond = (req) => (req.path === "/_publish/v1/landing" ? { status: 404, body: '{"error":"Not found"}' } : real(req));
      const id = await venueWithPlot();
      assert.equal((await call("POST", `/api/stageplots/venues/${id}/publish`)).status, 200);
      const said = await warnings(async () => {
        const r = await call("POST", `/api/stageplots/venues/${id}/listed`, { listed: true });
        assert.equal(r.status, 200, r.body);
        assert.match((r.json as { notice: string }).notice, /needs updating before it can show a landing page: deploy the Worker\./);
        await settled();
      });
      assert.equal(said.filter((w) => /landing page/.test(w)).length, 1, said.join(" | "));
      const view = (await call("GET", "/api/stageplots")).json as View;
      assert.match(view.landing!.message, /needs updating before it can show a landing page/);
      assert.equal(view.venues[0].publish!.listed, true, "the listing was not kept");
      // The Worker deployed: the next change sends the list, and the card's line goes.
      page.respond = real;
      await call("PATCH", `/api/stageplots/venues/${id}`, { notes: "x" });
      await call("PATCH", `/api/stageplots/venues/${id}`, { name: "Main room 2" });
      await settled();
      assert.equal(landingOn(page)!.venues.length, 1);
      assert.equal(((await call("GET", "/api/stageplots")).json as View).landing, undefined);
      await call("DELETE", `/api/stageplots/venues/${id}`);
    });
  });

  test("a draft kept on a published venue's plot sends nothing to the page and broadcasts no change to the plots", async () => {
    const { FakeReceiver } = await import("../fixtures/publish-receiver.js");
    const { servicecuePublishStore, savePublishToken } = await import("../servicecue-publish-store.js");
    const { parsePublishUrl } = await import("../servicecue-publish-rules.js");
    const { stageplotsPublisher } = await import("../stageplots-publish-instance.js");
    const page = await FakeReceiver.start();
    try {
      page.token = TOKEN;
      const parsed = parsePublishUrl(page.origin);
      assert.ok(parsed.ok);
      await servicecuePublishStore.save({ enabled: false, url: parsed.origin });
      await savePublishToken(parsed.origin, TOKEN);
      const id = await venueWithPlot();
      assert.equal((await call("POST", `/api/stageplots/venues/${id}/publish`)).status, 200);
      stageplotsPublisher.start();
      await stageplotsPublisher.settle();
      const plotId = (await stageplotsStore.get()).venues.find((v) => v.id === id)!.plotIds[0]!;
      const sent = page.requests.length;
      frames.length = 0;
      const item = { id: "i-1", type: "box", x: 10, y: 10, w: 100, h: 50, rotation: 0, label: "Riser", color: null, notes: "", inputs: [] };
      assert.equal((await call("PUT", `/api/stageplots/plots/${plotId}/draft`, { baseVersion: 0, items: [item] })).status, 200);
      await stageplotsPublisher.settle();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(frames.length, 0, "a draft broadcast stageplots:updated");
      assert.equal(page.requests.length, sent, "a draft reached the page");
      assert.deepEqual((await stageplotsStore.get()).plots.find((p) => p.id === plotId)!.items, []);
      await call("DELETE", `/api/stageplots/venues/${id}`);
      await stageplotsPublisher.settle();
    } finally {
      await page.close();
    }
  });

  test("publishes to the page, follows a change, unpublishes, and deletes a published venue by unpublishing it first", async () => {
    const { FakeReceiver } = await import("../fixtures/publish-receiver.js");
    const { servicecuePublishStore, savePublishToken } = await import("../servicecue-publish-store.js");
    const { parsePublishUrl } = await import("../servicecue-publish-rules.js");
    const page = await FakeReceiver.start();
    try {
      page.token = TOKEN;
      const parsed = parsePublishUrl(page.origin);
      assert.ok(parsed.ok);
      await servicecuePublishStore.save({ enabled: false, url: parsed.origin });
      await savePublishToken(parsed.origin, TOKEN);
      const id = await venueWithPlot();

      const r = await call("POST", `/api/stageplots/venues/${id}/publish`);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const secret = await storedSecret(id);
      assert.deepEqual(page.hub.stagePlotKeys(secret).sort().map((k) => k.split("/")[0]), ["index", "plot"]);
      assert.equal((frames.at(-1) as View).venues[0]!.publish?.origin, parsed.origin, "the published venue was not broadcast");
      assert.equal((await call("POST", `/api/stageplots/venues/${id}/publish`)).status, 409, "published twice");

      // A saved change reaches the page through the app's own broadcaster and the publisher's
      // real listener, once, and then nothing more is sent.
      const { stageplotsPublisher } = await import("../stageplots-publish-instance.js");
      stageplotsPublisher.start();
      const plotId = (await stageplotsStore.get()).venues.find((v) => v.id === id)!.plotIds[0]!;
      assert.equal((await call("PATCH", `/api/stageplots/plots/${plotId}`, { name: "Renamed" })).status, 200);
      await stageplotsPublisher.settle();
      const got = await page.worker({ method: "GET", path: `/stageplots/${secret}/plot/${plotId}`, headers: {}, body: "", bytes: Buffer.alloc(0), at: 0 });
      assert.equal(JSON.parse(got.body ?? "{}").name, "Renamed", "the saved change never reached the page");
      const settled = page.requests.length;
      await stageplotsPublisher.settle();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(page.requests.length, settled, "the publisher kept sending after the change was published");

      const off = await call("POST", `/api/stageplots/venues/${id}/unpublish`);
      assert.equal(off.status, 200);
      assert.equal((off.json as { publish?: unknown }).publish, undefined);
      assert.equal(page.hub.stagePlotKeys(secret).length, 0);

      // Published again, then deleted: the link goes with it.
      const second = await publishVenue(id);
      const del = await call("DELETE", `/api/stageplots/venues/${id}`);
      assert.deepEqual([del.status, del.json], [200, { ok: true }]);
      assert.equal(page.hub.stagePlotKeys(second).length, 0, "the deleted venue's link is still live");
      assert.deepEqual((await stageplotsStore.get()).pendingRemovals, []);
      await stageplotsPublisher.settle();
    } finally {
      await page.close();
    }
  });

  test("deleting a published venue with no page set up queues its link, says so, and Remove now takes it down once the page is back", async () => {
    const { FakeReceiver } = await import("../fixtures/publish-receiver.js");
    const { servicecuePublishStore, savePublishToken, forgetPublishToken } = await import("../servicecue-publish-store.js");
    const { parsePublishUrl } = await import("../servicecue-publish-rules.js");
    const page = await FakeReceiver.start();
    try {
      page.token = TOKEN;
      const parsed = parsePublishUrl(page.origin);
      assert.ok(parsed.ok);
      await servicecuePublishStore.save({ enabled: false, url: parsed.origin });
      await savePublishToken(parsed.origin, TOKEN);
      const id = await venueWithPlot();
      const secret = await publishVenue(id);
      await forgetPublishToken();
      const del = await call("DELETE", `/api/stageplots/venues/${id}`);
      assert.equal(del.status, 200);
      assert.match((del.json as { notice?: string }).notice ?? "", /until that page is set up here again/);
      const view = frames.at(-1) as View;
      assert.deepEqual(view.pendingRemovals.map((e) => [e.origin, e.reason]), [[parsed.origin, "venue deleted"]]);
      assert.equal(page.hub.stagePlotKeys(secret).length > 0, true, "the test's page lost the link before it was set up again");
      await savePublishToken(parsed.origin, TOKEN);
      const removed = await call("POST", "/api/stageplots/pending/remove");
      assert.deepEqual([removed.status, removed.json], [200, { removed: 1, left: 0, waiting: 0 }]);
      assert.equal(page.hub.stagePlotKeys(secret).length, 0);
      assert.deepEqual((await stageplotsStore.get()).pendingRemovals, []);
    } finally {
      await page.close();
    }
  });
});

describe("a restore landing", () => {
  test("refuses a venue's delete: deleting it then would leave its link live with nothing knowing it", async () => {
    const { stageplotsPublisher } = await import("../stageplots-publish-instance.js");
    const id = (await call("POST", "/api/stageplots/venues", { name: "Main room", kind: "home" })).json as { id: string };
    const secret = "A".repeat(42) + "E";
    await stageplotsStore.update((d) => ({
      ...d,
      venues: d.venues.map((v) => (v.id === id.id ? { ...v, publish: { secret, origin: "https://page.example", publishedAt: "2026-11-13T10:00:00.000Z", lastError: null, publishedImages: [], unpublishedImages: [], listed: false } } : v)),
    }));
    const resume = await stageplotsPublisher.pause();
    try {
      const del = await call("DELETE", `/api/stageplots/venues/${id.id}`);
      assert.deepEqual([del.status, /restore is under way/.test((del.json as { error: string }).error)], [503, true]);
      const after = (await stageplotsStore.get()).venues.find((v) => v.id === id.id);
      assert.equal(after?.publish?.secret, secret, "the venue went, and its link with nothing to remove it");
    } finally {
      resume();
    }
  });

  test("refuses the Public link save, before its token is replaced, and says so", async () => {
    const { stageplotsPublisher } = await import("../stageplots-publish-instance.js");
    const { serviceCuePublishRoutes } = await import("./servicecue-publish-routes.js");
    const { servicecuePublishStore, savePublishToken, readPublishToken } = await import("../servicecue-publish-store.js");
    await servicecuePublishStore.save({ enabled: false, url: "https://old.example" });
    await savePublishToken("https://old.example" as Parameters<typeof savePublishToken>[0], "o".repeat(40));
    const resume = await stageplotsPublisher.pause();
    let said: string[];
    try {
      said = await warnings(async () => {
        const r = await callRoute(serviceCuePublishRoutes, "/api/servicecue/publish", { method: "POST", body: { url: "https://new.example", token: "n".repeat(40) } });
        assert.deepEqual([r.status, /restore is under way/.test((r.json as { error: string }).error)], [503, true]);
      }, "[publish]");
    } finally {
      resume();
    }
    assert.equal((await servicecuePublishStore.load()).url, "https://old.example");
    assert.equal((await readPublishToken("https://old.example" as Parameters<typeof readPublishToken>[0])).trim(), "o".repeat(40), "the old token was replaced with the stage plots unable to use it");
    assert.ok(said.some((l) => l.startsWith("[publish] the Public link was not saved: A config restore is under way")), said.join(" / "));
  });

  test("every publishing action and Remove now refused for it is said on [stageplots]", async () => {
    const { stageplotsPublisher } = await import("../stageplots-publish-instance.js");
    const id = ((await call("POST", "/api/stageplots/venues", { name: "Main room", kind: "home" })).json as { id: string }).id;
    const resume = await stageplotsPublisher.pause();
    let said: string[];
    try {
      said = await warnings(async () => {
        for (const action of ["publish", "regenerate", "unpublish", "publish-now"]) assert.equal((await call("POST", `/api/stageplots/venues/${id}/${action}`)).status, 503, action);
        assert.equal((await call("POST", "/api/stageplots/pending/remove")).status, 503);
      });
    } finally {
      resume();
    }
    const why = "A config restore is under way; try again once the server is back.";
    assert.deepEqual(said, [
      `[stageplots] publish refused for venue ${id}: ${why}`,
      `[stageplots] regenerate refused for venue ${id}: ${why}`,
      `[stageplots] unpublish refused for venue ${id}: ${why}`,
      `[stageplots] publish-now refused for venue ${id}: ${why}`,
      `[stageplots] Remove now refused: ${why}`,
    ]);
  });
});

describe("the page address changing under published venues", () => {
  // Two pages, each the Worker's own handler. The venue is published to A; the Public link card
  // then saves B's address and token through its own route, which still holds A's token.
  const TOKEN = "q".repeat(40);
  async function twoPages() {
    const { FakeReceiver } = await import("../fixtures/publish-receiver.js");
    const { servicecuePublishStore, savePublishToken } = await import("../servicecue-publish-store.js");
    const { parsePublishUrl } = await import("../servicecue-publish-rules.js");
    const { serviceCuePublishRoutes } = await import("./servicecue-publish-routes.js");
    const { stageplotsPublisher } = await import("../stageplots-publish-instance.js");
    const a = await FakeReceiver.start();
    const b = await FakeReceiver.start();
    a.token = TOKEN;
    b.token = TOKEN;
    const pa = parsePublishUrl(a.origin);
    const pb = parsePublishUrl(b.origin);
    assert.ok(pa.ok && pb.ok);
    await servicecuePublishStore.save({ enabled: false, url: pa.origin });
    await savePublishToken(pa.origin, TOKEN);
    const v = (await call("POST", "/api/stageplots/venues", { name: "Main room", kind: "home" })).json as { id: string };
    await call("POST", "/api/stageplots/plots", { venueId: v.id, name: "Standard" });
    const first = await publishVenue(v.id);
    // The Public link card's save, through its own route, then everything it set off.
    const save = async (body: { url?: string; token?: string }) => {
      const r = await callRoute(serviceCuePublishRoutes, "/api/servicecue/publish", { method: "POST", body });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      await stageplotsPublisher.settle();
    };
    const moveTo = () => save({ url: pb.origin, token: TOKEN });
    const venue = async () => (await stageplotsStore.get()).venues.find((x) => x.id === v.id)!;
    // Whatever an earlier store write scheduled has run, so only what the save sets off is seen.
    await stageplotsPublisher.settle();
    return { a, b, pa: pa.origin, pb: pb.origin, first, id: v.id, save, moveTo, venue, close: async () => (await a.close(), await b.close()) };
  }

  test("moves each venue to the new page under a new link, and takes the old one down with the old token", async () => {
    const t = await twoPages();
    try {
      await t.moveTo();
      const pub = (await t.venue()).publish!;
      assert.equal(pub.origin, t.pb);
      assert.notEqual(pub.secret, t.first, "the same secret now lives on two pages");
      assert.deepEqual(t.b.hub.stagePlotKeys(pub.secret).sort().map((k) => k.split("/")[0]), ["index", "plot"]);
      assert.equal(t.a.hub.stageplots.size, 0, "the old page still serves the venue");
      assert.deepEqual((await stageplotsStore.get()).pendingRemovals, []);
    } finally {
      await t.close();
    }
  });

  test("a listed venue moves onto the new page's landing list, still listed, and the old page lists nothing", async () => {
    const { stageplotsPublisher } = await import("../stageplots-publish-instance.js");
    stageplotsPublisher.start();
    const t = await twoPages();
    try {
      assert.equal((await call("POST", `/api/stageplots/venues/${t.id}/listed`, { listed: true })).status, 200);
      assert.deepEqual(JSON.parse(t.a.hub.landing!), { venues: [{ name: "Main room", secret: t.first, plots: 1 }] });
      await t.moveTo();
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
      await stageplotsPublisher.settle();
      const pub = (await t.venue()).publish!;
      assert.equal(pub.listed, true, "the move dropped the listing");
      assert.deepEqual(JSON.parse(t.b.hub.landing!), { venues: [{ name: "Main room", secret: pub.secret, plots: 1 }] });
      assert.deepEqual(JSON.parse(t.a.hub.landing!), { venues: [] }, "the old page still lists the venue");
    } finally {
      await call("DELETE", `/api/stageplots/venues/${t.id}`);
      await stageplotsPublisher.settle();
      await t.close();
    }
  });

  test("an old page that will not take the drop leaves the old link queued against it, in sight", async () => {
    const t = await twoPages();
    try {
      t.a.respond = (req) => (req.method === "DELETE" ? { status: 500, body: "" } : t.a.worker(req));
      await t.moveTo();
      assert.equal((await t.venue()).publish!.origin, t.pb);
      const view = frames.at(-1) as View;
      assert.deepEqual(view.pendingRemovals.map((e) => [e.origin, e.reason]), [[t.pa, "address changed"]]);
      assert.equal(t.a.hub.stagePlotKeys(t.first).length > 0, true);
    } finally {
      await t.close();
    }
  });

  test("a new page that does not know StagePlots leaves the venue on the old one, saying why, and its link alive", async () => {
    const t = await twoPages();
    try {
      t.b.respond = (req) => (/^\/_publish\/v1\/stageplots\//.test(req.path) ? { status: 404, body: '{"error":"Not found"}' } : t.b.worker(req));
      await t.moveTo();
      const pub = (await t.venue()).publish!;
      assert.deepEqual([pub.origin, pub.secret], [t.pa, t.first], "the venue left a page that still serves it");
      assert.match(pub.lastError?.message ?? "", /^Not moved to 127\.0\.0\.1:\d+: 127\.0\.0\.1:\d+ needs updating before it can show stage plots: deploy the Worker\./);
      assert.equal(t.a.hub.stagePlotKeys(t.first).length > 0, true, "the link of a venue that did not move was taken down");
      assert.deepEqual((await stageplotsStore.get()).pendingRemovals, []);
    } finally {
      await t.close();
    }
  });

  // An address saved with no token for it leaves this server with no way to reach the old page
  // after this request: its links are taken down now, while the old token is still in hand, or
  // nothing could ever remove them.
  for (const [what, url] of [
    ["another address with no token", "b"],
    ["the address cleared", ""],
  ] as const) {
    test(`${what}: the venues on the old page are taken down with its token and unpublished`, async () => {
      const t = await twoPages();
      try {
        const said = await warnings(() => t.save({ url: url === "b" ? t.pb : "" }));
        assert.equal(t.a.hub.stageplots.size, 0, "the old page still serves a link no token here can remove");
        assert.equal((await t.venue()).publish, undefined, "the venue still claims a link on a page this server cannot reach");
        assert.deepEqual((await stageplotsStore.get()).pendingRemovals, []);
        assert.ok(said.some((l) => l.includes('"Main room" unpublished') && l.includes(`removed from ${new URL(t.pa).host}`)), said.join(" / "));
        // The new page's token, saved after: nothing is left to move, and nothing appears on either page.
        if (url === "b") await t.save({ url: t.pb, token: TOKEN });
        assert.equal(t.a.hub.stageplots.size, 0);
        assert.equal(t.b.hub.stageplots.size, 0);
      } finally {
        await t.close();
      }
    });
  }

  test("the old page refusing that take-down leaves the link queued against it, in sight", async () => {
    const t = await twoPages();
    try {
      t.a.respond = (req) => (req.method === "DELETE" ? { status: 500, body: "" } : t.a.worker(req));
      await t.save({ url: t.pb });
      assert.equal((await t.venue()).publish, undefined);
      const view = frames.at(-1) as View;
      assert.deepEqual(view.pendingRemovals.map((e) => [e.origin, e.reason]), [[t.pa, "address changed"]]);
    } finally {
      await t.close();
    }
  });

  test("the token cleared on the same address takes nothing down: the token can be entered again", async () => {
    const t = await twoPages();
    try {
      await t.save({ url: t.pa, token: "" });
      const pub = (await t.venue()).publish!;
      assert.deepEqual([pub.origin, pub.secret], [t.pa, t.first]);
      assert.ok(t.a.hub.stagePlotKeys(t.first).length > 0, "a token clear took the venue's link down");
    } finally {
      await t.close();
    }
  });

  test("a token saved for the page set up removes the old links waiting on it", async () => {
    const t = await twoPages();
    try {
      const { forgetPublishToken } = await import("../servicecue-publish-store.js");
      await forgetPublishToken();
      const off = await call("POST", `/api/stageplots/venues/${t.id}/unpublish`);
      assert.equal(off.status, 200);
      assert.deepEqual((await stageplotsStore.get()).pendingRemovals.map((e) => [e.origin, e.reason]), [[t.pa, "unpublished"]]);
      const { stageplotsPublisher } = await import("../stageplots-publish-instance.js");
      await stageplotsPublisher.settle();
      assert.ok(t.a.hub.stagePlotKeys(t.first).length > 0, "the link went before the token was saved");
      await t.save({ url: t.pa, token: TOKEN });
      assert.deepEqual((await stageplotsStore.get()).pendingRemovals, []);
      assert.equal(t.a.hub.stageplots.size, 0, "the token was saved and the old link is still live");
    } finally {
      await t.close();
    }
  });
});

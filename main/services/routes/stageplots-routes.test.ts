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
const { STAGEPLOTS_CHANNEL } = await import("../../types/stageplots.js");
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
  await stageplotsStore.update(() => ({ venues: [], backgrounds: [], plots: [] }));
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

/** Every [stageplots] warning `run` logs. */
async function warnings(run: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const real = console.warn;
  console.warn = (...a: unknown[]) => void seen.push(a.join(" "));
  try {
    await run();
  } finally {
    console.warn = real;
  }
  return seen.filter((w) => w.startsWith("[stageplots]"));
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

async function filesIn(dir: string): Promise<string[]> {
  return fs.readdir(path.join(TMP, dir)).catch(() => []);
}

describe("stage plot routes", () => {
  test("GET answers the document with each background's URLs", async () => {
    const r = await call("GET", "/api/stageplots");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { venues: [], backgrounds: [], plots: [] });
  });

  test("venues: create, rename, change kind and notes, delete with its plots", async () => {
    const v = await venue();
    const p = await plot(v.id);
    let r = await call("PATCH", `/api/stageplots/venues/${v.id}`, { name: "  Chapel ", kind: "offsite", notes: "Side door" });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(r.json, { id: v.id, name: "Chapel", kind: "offsite", notes: "Side door", plotIds: [p.id], defaultPlotId: p.id });
    r = await call("DELETE", `/api/stageplots/venues/${v.id}`);
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(await stageplotsStore.get(), { venues: [], backgrounds: [], plots: [] });
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

  test("deleting the default plot is 409, another plot deletes", async () => {
    const v = await venue();
    const a = await plot(v.id, "Standard");
    const b = await plot(v.id, "Baptism");
    const r = await call("DELETE", `/api/stageplots/plots/${a.id}`);
    assert.equal(r.status, 409);
    assert.match((r.json as { error: string }).error, /default/);
    assert.equal((await call("DELETE", `/api/stageplots/plots/${b.id}`)).status, 200);
    assert.deepEqual((await stageplotsStore.get()).plots.map((p) => p.id), [a.id]);
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
    assert.deepEqual(saidCap, ['[stageplots] upload refused: "big.jpg" is over the 12288 KB cap']);
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
    await call("DELETE", `/api/stageplots/plots/${a.id}`);
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
      venues: Array.from({ length: 50 }, (_, i) => ({ id: `v-${i}`, name: `Room ${i}`, kind: "home" as const, notes: "", plotIds: [], defaultPlotId: null })),
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

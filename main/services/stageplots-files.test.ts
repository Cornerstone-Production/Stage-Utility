// Where a stage-plot background's files live, what is served from them, and
// that a config backup carries them all.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import sharp from "sharp";

import { serveOnSocket, type SocketServer } from "./fixtures/socket-server.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stageplots-files-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const files = await import("./stageplots-files.js");
const { stageplotsStore } = await import("./stageplots-store.js");
const { configSnapshot, restoreCeilingNote } = await import("./config-snapshot.js");
const { MAX_CONFIG_BODY_BYTES } = await import("./routes/context.js");
const { RemoteServer } = await import("./remote-server.js");
const asRoot = process.getuid?.() === 0;

/** A minimal PDF, written here: one empty page. */
function tinyPdf(tag: string): Buffer {
  return Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>endobj\ntrailer<</Root 1 0 R>>\n%${tag}\n%%EOF\n`, "latin1");
}

async function webp(seed: number): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 30, channels: 3, background: { r: seed, g: 200, b: 160 } } }).webp().toBuffer();
}

async function png(seed: number): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 30, channels: 3, background: { r: seed, g: 90, b: 40 } } }).png().toBuffer();
}

const EMPTY_DOC = { venues: [], backgrounds: [], plots: [], overrides: [], pendingRemovals: [] };

/** A tidy source over `get`, not standing in for a damaged file. */
function source(get: () => Promise<typeof EMPTY_DOC>) {
  return { get, loadedFromCorrupt: false };
}

/** A new instance of the real store over the same file, as a restart makes. */
async function freshStoreFactory() {
  const { DataStore } = await import("./data-store.js");
  const { checkStagePlotsDoc } = await import("./stageplots-store.js");
  const { checked } = await import("./restore-check.js");
  return () => {
    const store = new DataStore("stageplots.json", EMPTY_DOC, "config", { restoreCheck: checked(checkStagePlotsDoc) });
    return { get: () => store.loadStrict(), get loadedFromCorrupt() { return store.loadedFromCorrupt; } };
  };
}

async function age(dir: string, file: string): Promise<void> {
  const old = new Date(Date.now() - files.STAGEPLOT_FILE_GRACE_MS - 60_000);
  await fs.utimes(path.join(TMP, dir, file), old, old);
}

/** Background files a saved stageplots.json names, aged past the grace window,
 *  then the file cut short as a power cut mid-write leaves it. */
async function damagedStore(): Promise<string[]> {
  const converted = await files.storeStagePlotImage(await webp(21), "webp");
  const src = await files.storeStagePlotImage(await png(21), "png");
  const pdfHash = await files.storeStagePlotOriginal(tinyPdf("damaged"));
  await stageplotsStore.update(() => ({
    venues: [],
    plots: [],
    overrides: [],
    pendingRemovals: [],
    backgrounds: [
      {
        id: "b-kept",
        name: "Plan",
        original: { hash: pdfHash, mime: "application/pdf", bytes: 10 },
        source: { hash: src, ext: "png" },
        converted: { hash: converted, width: 40, height: 30, bytes: 10 },
        cleanup: true,
        pdfPage: 1,
        pdfPages: 1,
      },
    ],
  }));
  const kept = [`${files.STAGEPLOT_IMAGE_DIR}/${converted}.webp`, `${files.STAGEPLOT_IMAGE_DIR}/${src}.png`, `${files.STAGEPLOT_ORIGINAL_DIR}/${pdfHash}.pdf`];
  for (const f of kept) await age(path.dirname(f), path.basename(f));
  const full = path.join(TMP, "stageplots.json");
  await fs.writeFile(full, (await fs.readFile(full, "utf8")).slice(0, 40));
  return kept;
}

/** Which of `files` are gone. */
async function missing(list: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of list) if (!(await fs.stat(path.join(TMP, f)).catch(() => null))) out.push(f);
  return out;
}

let freshStore: Awaited<ReturnType<typeof freshStoreFactory>>;
let server: SocketServer;
before(async () => {
  freshStore = await freshStoreFactory();
  server = await serveOnSocket(new RemoteServer().handle);
});
after(async () => {
  await server.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("stage-plot files", () => {
  test("an image stored twice is one file", async () => {
    const bytes = await webp(1);
    const a = await files.storeStagePlotImage(bytes, "webp");
    const b = await files.storeStagePlotImage(bytes, "webp");
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.deepEqual((await fs.readdir(path.join(TMP, files.STAGEPLOT_IMAGE_DIR))).filter((f) => f.startsWith(a)), [`${a}.webp`]);
  });

  test("an image whose bytes are not its type is refused", async () => {
    await assert.rejects(() => files.storeStagePlotImage(Buffer.from("not a webp at all"), "webp"), /not a valid image\/webp image/);
  });

  test("a PDF original is kept by its hash, and anything else is refused", async () => {
    const hash = await files.storeStagePlotOriginal(tinyPdf("a"));
    assert.equal(await files.stagePlotOriginalBytes(hash), tinyPdf("a").length);
    assert.equal(await files.stagePlotOriginalBytes("0000000000000000"), null);
    assert.equal(await files.stagePlotOriginalBytes("../../x"), null);
    await assert.rejects(() => files.storeStagePlotOriginal(Buffer.from("PK\x03\x04 a zip")), /not a PDF/);
    await assert.rejects(() => files.storeStagePlotOriginal(Buffer.concat([tinyPdf("big"), Buffer.alloc(files.MAX_STAGEPLOT_PDF_BYTES)])), /too large/);
  });

  test("GET /stageplot-images/<hash>.webp answers with immutable cache headers", async () => {
    const hash = await files.storeStagePlotImage(await webp(2), "webp");
    const r = await server.send("GET", files.stagePlotImageUrl(hash, "webp"));
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "image/webp");
    assert.equal(r.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.match(String(r.headers["content-security-policy"]), /sandbox/);
    assert.equal((await server.send("GET", `/${files.STAGEPLOT_IMAGE_DIR}/0000000000000000.webp`)).status, 404);
  });

  test("no route serves stageplot-originals: the PDF bytes never come back", async () => {
    const hash = await files.storeStagePlotOriginal(tinyPdf("served?"));
    for (const p of [`/${files.STAGEPLOT_ORIGINAL_DIR}/${hash}.pdf`, `/${files.STAGEPLOT_IMAGE_DIR}/${hash}.pdf`, `/${files.STAGEPLOT_IMAGE_DIR}/..%2F${files.STAGEPLOT_ORIGINAL_DIR}%2F${hash}.pdf`]) {
      const r = await server.send("GET", p);
      assert.ok(!r.body.includes("%PDF-"), `${p} answered with the PDF`);
      assert.notEqual(r.headers["content-type"], "application/pdf", `${p} answered as a PDF`);
    }
  });

  test("removeUnreferenced keeps files any background still names, and recent ones", async () => {
    const kept = await files.storeStagePlotImage(await webp(3), "webp");
    const keptSource = await files.storeStagePlotImage(await png(3), "png");
    const keptPdf = await files.storeStagePlotOriginal(tinyPdf("kept"));
    const orphan = await files.storeStagePlotImage(await webp(4), "webp");
    const orphanPdf = await files.storeStagePlotOriginal(tinyPdf("orphan"));
    const recent = await files.storeStagePlotImage(await webp(5), "webp");
    for (const [dir, f] of [
      [files.STAGEPLOT_IMAGE_DIR, `${kept}.webp`],
      [files.STAGEPLOT_IMAGE_DIR, `${keptSource}.png`],
      [files.STAGEPLOT_ORIGINAL_DIR, `${keptPdf}.pdf`],
      [files.STAGEPLOT_IMAGE_DIR, `${orphan}.webp`],
      [files.STAGEPLOT_ORIGINAL_DIR, `${orphanPdf}.pdf`],
    ]) await age(dir, f);
    const doc = {
      venues: [],
      plots: [],
      overrides: [],
    pendingRemovals: [],
      backgrounds: [
        {
          id: "b-1",
          name: "Plan",
          original: { hash: keptPdf, mime: "application/pdf" as const, bytes: 10 },
          source: { hash: keptSource, ext: "png" as const },
          converted: { hash: kept, width: 40, height: 30, bytes: 10 },
          cleanup: false,
          pdfPage: 1,
          pdfPages: 1,
        },
      ],
    };
    const result = await files.removeUnreferenced(doc);
    assert.deepEqual(result.failed, []);
    const images = await fs.readdir(path.join(TMP, files.STAGEPLOT_IMAGE_DIR));
    const originals = await fs.readdir(path.join(TMP, files.STAGEPLOT_ORIGINAL_DIR));
    for (const f of [`${kept}.webp`, `${keptSource}.png`, `${recent}.webp`]) assert.ok(images.includes(f), `${f} was removed`);
    assert.ok(originals.includes(`${keptPdf}.pdf`), "the named PDF was removed");
    assert.ok(!images.includes(`${orphan}.webp`), "an old orphan was kept");
    assert.ok(!originals.includes(`${orphanPdf}.pdf`), "an old orphaned PDF was kept");
    assert.ok(result.removed >= 2);
  });

  test("the daily tidy removes an aged orphan, and deletes nothing when the document cannot be read", async () => {
    const orphan = await files.storeStagePlotImage(await webp(11), "webp");
    const orphanPdf = await files.storeStagePlotOriginal(tinyPdf("daily orphan"));
    await age(files.STAGEPLOT_IMAGE_DIR, `${orphan}.webp`);
    await age(files.STAGEPLOT_ORIGINAL_DIR, `${orphanPdf}.pdf`);
    const here = async () => [
      ...(await fs.readdir(path.join(TMP, files.STAGEPLOT_IMAGE_DIR))),
      ...(await fs.readdir(path.join(TMP, files.STAGEPLOT_ORIGINAL_DIR))),
    ];
    const unreadable = await files.tidyStagePlotFiles(source(async () => {
      throw new Error("stageplots.json could not be read");
    }));
    assert.deepEqual(unreadable, { skipped: "the stage plots could not be read: stageplots.json could not be read" });
    assert.ok((await here()).includes(`${orphan}.webp`), "an unreadable document deleted a file");
    assert.ok((await here()).includes(`${orphanPdf}.pdf`), "an unreadable document deleted a PDF");
    const tidied = await files.tidyStagePlotFiles(source(async () => EMPTY_DOC));
    assert.ok("removed" in tidied && tidied.removed >= 2, JSON.stringify(tidied));
    assert.ok(!(await here()).includes(`${orphan}.webp`));
    assert.ok(!(await here()).includes(`${orphanPdf}.pdf`));
  });

  test("a damaged stageplots.json, read first by the tidy itself, deletes no file, nor after a restart", async () => {
    const kept = await damagedStore();
    // No read before the tidy: at boot, the daily tidy is the store's first reader.
    const afterDamage = freshStore();
    const r1 = await files.tidyStagePlotFiles(afterDamage);
    assert.ok("skipped" in r1, JSON.stringify(r1));
    assert.equal(afterDamage.loadedFromCorrupt, true);
    assert.deepEqual(await missing(kept), [], "the tidy deleted files a damaged stageplots.json named");
    // The next start: the damaged file is gone, the store reads empty, and the
    // .corrupt- copy beside it holds the tidy off.
    const afterRestart = freshStore();
    const r2 = await files.tidyStagePlotFiles(afterRestart);
    assert.ok("skipped" in r2 && /stageplots\.json\.corrupt-/.test(r2.skipped), JSON.stringify(r2));
    assert.deepEqual(await missing(kept), []);
    // Once the copy is moved away, the tidy runs again.
    for (const f of await fs.readdir(TMP)) if (f.startsWith("stageplots.json.corrupt-")) await fs.rm(path.join(TMP, f));
    assert.ok("removed" in (await files.tidyStagePlotFiles(freshStore())));
  });

  test("a damaged stageplots.json that could not be moved aside still deletes no file", { skip: asRoot && "mode bits do not stop root" }, async () => {
    const kept = await damagedStore();
    // A read-only data folder: the store reads the file but cannot rename it.
    await fs.chmod(TMP, 0o555);
    let result: Awaited<ReturnType<typeof files.tidyStagePlotFiles>>;
    const store = freshStore();
    try {
      result = await files.tidyStagePlotFiles(store);
    } finally {
      await fs.chmod(TMP, 0o755);
    }
    assert.ok((await fs.readdir(TMP)).every((f) => !f.startsWith("stageplots.json.corrupt-")), "the rename was not refused; the test is not testing that");
    assert.equal(store.loadedFromCorrupt, true);
    assert.ok("skipped" in result, JSON.stringify(result));
    assert.deepEqual(await missing(kept), []);
    await fs.rm(path.join(TMP, "stageplots.json"), { force: true });
  });

  test("a data folder that cannot be listed holds the tidy off", { skip: asRoot && "mode bits do not stop root" }, async () => {
    const orphan = await files.storeStagePlotImage(await webp(31), "webp");
    await age(files.STAGEPLOT_IMAGE_DIR, `${orphan}.webp`);
    // Not readable, still searchable: the image folder inside can be listed,
    // the data folder where a .corrupt- copy would sit cannot.
    await fs.chmod(TMP, 0o333);
    let result: Awaited<ReturnType<typeof files.tidyStagePlotFiles>>;
    try {
      result = await files.tidyStagePlotFiles(source(async () => EMPTY_DOC));
    } finally {
      await fs.chmod(TMP, 0o755);
    }
    assert.ok("skipped" in result && /could not be listed/.test(result.skipped), JSON.stringify(result));
    assert.ok((await fs.readdir(path.join(TMP, files.STAGEPLOT_IMAGE_DIR))).includes(`${orphan}.webp`));
  });

  test("only originals written inside the hour count as waiting for their page", async () => {
    const old: string[] = [];
    for (let i = 0; i < 6; i++) {
      const h = await files.storeStagePlotOriginal(tinyPdf(`old ${i}`));
      await age(files.STAGEPLOT_ORIGINAL_DIR, `${h}.pdf`);
      old.push(`${h}.pdf`);
    }
    const fresh = `${await files.storeStagePlotOriginal(tinyPdf("fresh"))}.pdf`;
    const pending = await files.pendingOriginals(EMPTY_DOC);
    assert.ok(pending.includes(fresh));
    assert.deepEqual(pending.filter((f) => old.includes(f)), []);
  });

  test("a config backup carries stageplots.json, the image folder and the originals folder, and a restore onto an empty data dir brings all three back", async () => {
    const converted = await webp(7);
    const source = await png(7);
    const pdf = tinyPdf("backup");
    const convertedHash = await files.storeStagePlotImage(converted, "webp");
    const sourceHash = await files.storeStagePlotImage(source, "png");
    const pdfHash = await files.storeStagePlotOriginal(pdf);
    await stageplotsStore.update(() => ({
      pendingRemovals: [],
      venues: [{ id: "v-1", name: "Main room", kind: "home", notes: "Side door", plotIds: ["p-1", "p-2"], defaultPlotId: "p-1" }],
      backgrounds: [
        {
          id: "b-1",
          name: "Plan",
          original: { hash: pdfHash, mime: "application/pdf", bytes: pdf.length },
          source: { hash: sourceHash, ext: "png" },
          converted: { hash: convertedHash, width: 40, height: 30, bytes: converted.length },
          cleanup: true,
          pdfPage: 1,
          pdfPages: 1,
        },
      ],
      plots: [
        { id: "p-1", venueId: "v-1", name: "Standard", backgroundId: "b-1", bgFade: 0.4, items: [], version: 1 },
        { id: "p-2", venueId: "v-1", name: "Baptism", backgroundId: null, bgFade: 0.4, items: [], version: 0 },
      ],
      overrides: [{ planId: "101", venueId: "v-1", plotId: "p-2", planDate: "2026-11-16T15:00:00.000Z" }],
    }));
    const bundle = JSON.parse(JSON.stringify(await configSnapshot.build()));
    assert.ok(bundle.files["stageplots.json"], "the backup has no stageplots.json");
    assert.ok(bundle.images[`${files.STAGEPLOT_IMAGE_DIR}/${convertedHash}.webp`], "the backup has no converted image");
    assert.ok(bundle.images[`${files.STAGEPLOT_IMAGE_DIR}/${sourceHash}.png`], "the backup has no source raster");
    assert.ok(bundle.originals?.[`${files.STAGEPLOT_ORIGINAL_DIR}/${pdfHash}.pdf`], "the backup has no PDF original");

    // An empty data dir: nothing of the feature left on disk.
    for (const name of ["stageplots.json", files.STAGEPLOT_IMAGE_DIR, files.STAGEPLOT_ORIGINAL_DIR]) {
      await fs.rm(path.join(TMP, name), { recursive: true, force: true });
    }
    const applied = await configSnapshot.apply(bundle);
    assert.ok(applied.includes("stageplots.json"));
    assert.ok(applied.includes(`${files.STAGEPLOT_ORIGINAL_DIR}/${pdfHash}.pdf`));

    const restored = JSON.parse(await fs.readFile(path.join(TMP, "stageplots.json"), "utf8"));
    assert.equal(restored.venues[0].name, "Main room");
    assert.deepEqual(restored.overrides, [{ planId: "101", venueId: "v-1", plotId: "p-2", planDate: "2026-11-16T15:00:00.000Z" }], "a plan's override did not come back");
    const bg = restored.backgrounds[0];
    assert.equal(restored.plots[0].backgroundId, bg.id, "the plot's background no longer resolves");
    assert.deepEqual(await fs.readFile(path.join(TMP, files.STAGEPLOT_IMAGE_DIR, `${bg.converted.hash}.webp`)), converted);
    assert.deepEqual(await files.readStagePlotSource(bg.source.hash, "png"), source);
    assert.deepEqual(await files.readStagePlotOriginal(`${bg.original.hash}.pdf`), pdf);
  });

  test("a backup past what a downloaded file can restore says so on [config-snapshot]", async () => {
    assert.equal(restoreCeilingNote(MAX_CONFIG_BODY_BYTES), null);
    assert.match(restoreCeilingNote(MAX_CONFIG_BODY_BYTES + 1) ?? "", /past the 64\.0 MB a downloaded backup can restore/);
    // Five 10 MB phone photos' sources: 50 MB, about 67 MB as the backup carries it.
    const dir = path.join(TMP, files.STAGEPLOT_IMAGE_DIR);
    await fs.mkdir(dir, { recursive: true });
    const big = Array.from({ length: 5 }, (_, i) => path.join(dir, `${"b".repeat(15)}${i}.jpg`));
    for (const f of big) await fs.writeFile(f, Buffer.alloc(10 * 1024 * 1024, 7));
    const warned: string[] = [];
    const real = console.warn;
    console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
    try {
      await configSnapshot.build();
    } finally {
      console.warn = real;
      for (const f of big) await fs.rm(f);
    }
    assert.equal(warned.filter((w) => w.startsWith("[config-snapshot] this backup carries")).length, 1, warned.join("\n"));
    assert.match(warned.find((w) => w.includes("this backup carries"))!, /6\d\.\d MB of uploaded images and originals/);
    // A small backup says nothing.
    const quiet: string[] = [];
    console.warn = (...a: unknown[]) => void quiet.push(a.join(" "));
    try {
      await configSnapshot.build();
    } finally {
      console.warn = real;
    }
    assert.deepEqual(quiet.filter((w) => w.includes("this backup carries")), []);
  });

  test("a restore refuses an original that is not the PDF its name says", async () => {
    const bundle = {
      kind: "stage-utility-config",
      version: 1,
      appVersion: "test",
      createdAt: "2026-11-12T00:00:00.000Z",
      files: {},
      originals: { [`${files.STAGEPLOT_ORIGINAL_DIR}/0123456789abcdef.pdf`]: Buffer.from("%PDF-1.4 forged").toString("base64") },
    };
    await assert.rejects(() => configSnapshot.apply(bundle), /does not match its contents/);
    // A folder this build keeps no originals in is skipped, as an unknown image
    // folder is: a backup from a newer build still restores the rest.
    const elsewhere = { ...bundle, originals: { "settings/0123456789abcdef.pdf": Buffer.from("%PDF-").toString("base64") } };
    assert.deepEqual(await configSnapshot.apply(elsewhere), []);
    await assert.rejects(() => fs.access(path.join(TMP, "settings", "0123456789abcdef.pdf")));
  });
});

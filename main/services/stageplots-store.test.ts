import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stageplots-store-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { checkStagePlotsDoc, validateVenueInput, validatePlotInput, limitProblem, stageplotsStore } = await import(
  "./stageplots-store.js"
);
const { restoreCheckFor } = await import("./store-registry.js");

const HASH = "0123456789abcdef";

function background(id = "b-1") {
  return {
    id,
    name: "Plan",
    original: { hash: HASH, mime: "image/png", bytes: 1000 },
    source: { hash: HASH, ext: "png" },
    converted: { hash: "fedcba9876543210", width: 2400, height: 1600, bytes: 400_000 },
    cleanup: true,
    pdfPage: null,
    pdfPages: null,
  };
}

function goodDoc() {
  return {
    venues: [{ id: "v-1", name: "Main room", kind: "home", notes: "", plotIds: ["p-1"], defaultPlotId: "p-1" }],
    backgrounds: [background()],
    plots: [{ id: "p-1", venueId: "v-1", name: "Standard", backgroundId: "b-1" as string | null, bgFade: 0.4, items: [], version: 1 }],
  };
}

function refusal(raw: unknown): string {
  try {
    checkStagePlotsDoc(raw);
  } catch (err) {
    return (err as Error).message;
  }
  assert.fail("expected a refusal");
}

describe("stageplots store restore check", () => {
  test("the store is registered with its restore check", async () => {
    const check = restoreCheckFor("stageplots.json");
    assert.ok(check, "stageplots.json has no restore check");
    assert.deepEqual(await check(goodDoc()), { ok: true, value: goodDoc() });
  });

  test("restore check accepts the empty doc", () => {
    assert.deepEqual(checkStagePlotsDoc({ venues: [], backgrounds: [], plots: [] }), { venues: [], backgrounds: [], plots: [] });
  });

  test("restore check refuses a plot whose venueId is unknown", () => {
    const doc = goodDoc();
    doc.plots[0].venueId = "v-nowhere";
    assert.match(refusal(doc), /plot "p-1".*venue/);
  });

  test("restore check refuses a venue whose defaultPlotId is not one of its plotIds", () => {
    const doc = goodDoc();
    doc.venues[0].defaultPlotId = "p-9";
    assert.match(refusal(doc), /default plot/);
  });

  test("restore check refuses a venue with plots and no default", () => {
    const doc = goodDoc();
    (doc.venues[0] as { defaultPlotId: string | null }).defaultPlotId = null;
    assert.match(refusal(doc), /default plot/);
  });

  test("restore check refuses a plot its venue does not list", () => {
    const doc = goodDoc();
    doc.plots.push({ id: "p-2", venueId: "v-1", name: "Other", backgroundId: null, bgFade: 0, items: [], version: 0 });
    assert.match(refusal(doc), /p-2/);
  });

  test("restore check refuses a plot whose background is unknown", () => {
    const doc = goodDoc();
    doc.plots[0].backgroundId = "b-gone";
    assert.match(refusal(doc), /background/);
  });

  test("restore check refuses a background with a hash that is not 16 hex chars", () => {
    const doc = goodDoc();
    doc.backgrounds[0].converted.hash = "../../etc/passwd";
    assert.match(refusal(doc), /hash/);
    const long = goodDoc();
    long.backgrounds[0].source.hash = HASH + HASH;
    assert.match(refusal(long), /hash/);
  });

  test("restore check refuses a background whose original is not png, jpeg or pdf", () => {
    const doc = goodDoc();
    doc.backgrounds[0].original.mime = "image/svg+xml";
    assert.match(refusal(doc), /original/);
  });

  test("restore check refuses a fade outside 0 to 1", () => {
    const doc = goodDoc();
    doc.plots[0].bgFade = 2;
    assert.match(refusal(doc), /fade/);
  });

  test("restore check refuses an id that could not go in a URL", () => {
    const doc = goodDoc();
    doc.venues[0].id = "v/../1";
    assert.match(refusal(doc), /id/);
  });

  test("limits: the 51st venue is refused", () => {
    const venues = Array.from({ length: 50 }, (_, i) => ({ id: `v-${i}`, name: `Room ${i}`, kind: "home", notes: "", plotIds: [], defaultPlotId: null }));
    const doc = { venues, backgrounds: [], plots: [] };
    assert.deepEqual(checkStagePlotsDoc(doc).venues.length, 50);
    assert.match(limitProblem(checkStagePlotsDoc(doc), "venue") ?? "", /50 venues/);
    const over = { ...doc, venues: [...venues, { ...venues[0], id: "v-50" }] };
    assert.match(refusal(over), /50 venues/);
  });

  test("limits: the 21st plot in a venue and the 51st background are refused", () => {
    const plots = Array.from({ length: 20 }, (_, i) => ({ id: `p-${i}`, venueId: "v-1", name: `Plot ${i}`, backgroundId: null, bgFade: 0, items: [], version: 0 }));
    const doc = checkStagePlotsDoc({
      venues: [{ id: "v-1", name: "Main", kind: "home", notes: "", plotIds: plots.map((p) => p.id), defaultPlotId: "p-0" }],
      backgrounds: Array.from({ length: 50 }, (_, i) => background(`b-${i}`)),
      plots,
    });
    assert.match(limitProblem(doc, "plot", "v-1") ?? "", /20 plots/);
    assert.match(limitProblem(doc, "background") ?? "", /50 backgrounds/);
    assert.equal(limitProblem(doc, "venue"), null);
  });
});

describe("stageplots input validation", () => {
  test("validateVenueInput refuses a 61-char name and a kind other than home/offsite", () => {
    assert.equal(validateVenueInput({ name: "Main", kind: "home", notes: "" }, { partial: false }), null);
    assert.match(validateVenueInput({ name: "x".repeat(61), kind: "home", notes: "" }, { partial: false }) ?? "", /60/);
    assert.match(validateVenueInput({ name: "Main", kind: "garage", notes: "" }, { partial: false }) ?? "", /home or offsite/);
    assert.match(validateVenueInput({ name: "   ", kind: "home" }, { partial: false }) ?? "", /name/);
    assert.match(validateVenueInput({ notes: "x".repeat(501) }, { partial: true }) ?? "", /500/);
    assert.match(validateVenueInput({ kind: "home" }, { partial: false }) ?? "", /name/);
    assert.equal(validateVenueInput({ kind: "offsite" }, { partial: true }), null);
    assert.match(validateVenueInput([], { partial: true }) ?? "", /object/);
  });

  test("validatePlotInput refuses a bad name, fade and background id", () => {
    assert.equal(validatePlotInput({ name: "Standard", bgFade: 0.4, backgroundId: null }, { partial: true }), null);
    assert.match(validatePlotInput({ name: "" }, { partial: true }) ?? "", /name/);
    assert.match(validatePlotInput({ bgFade: 1.5 }, { partial: true }) ?? "", /fade/);
    assert.match(validatePlotInput({ bgFade: "0.4" }, { partial: true }) ?? "", /fade/);
    assert.match(validatePlotInput({ backgroundId: 7 }, { partial: true }) ?? "", /background/);
    assert.match(validatePlotInput({}, { partial: false }) ?? "", /name/);
  });
});

describe("stageplots store", () => {
  test("update persists through the DataStore and get reads it back", async () => {
    assert.deepEqual(await stageplotsStore.get(), { venues: [], backgrounds: [], plots: [] });
    await stageplotsStore.update((d) => ({ ...d, venues: [{ id: "v-1", name: "Main", kind: "home", notes: "", plotIds: [], defaultPlotId: null }] }));
    const onDisk = JSON.parse(await fs.readFile(path.join(TMP, "stageplots.json"), "utf8"));
    assert.equal(onDisk.venues[0].name, "Main");
    assert.equal((await stageplotsStore.get()).venues.length, 1);
  });
});

import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "branding-"));
process.env.STAGE_UTILITY_DATA = dataDir;

const { BRANDING_IMAGE_DIR, externalizeBrandingImages, migrateInlineBrandingImages } = await import(
  "./branding-image-store.js"
);
const { readImage } = await import("./image-files.js");

// A one-pixel PNG, as the branding editor would hand it over.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const DATA_URL = `data:image/png;base64,${PNG_B64}`;

test("an inline image is stored as a file and replaced by its reference", async () => {
  const out = await externalizeBrandingImages({ appLogo: DATA_URL });
  const ref = out.appLogo as string;
  assert.match(ref, /^\/branding-images\/[0-9a-f]{16}\.png$/, ref);

  const img = await readImage(BRANDING_IMAGE_DIR, ref.split("/").pop() as string);
  assert.ok(img, "the bytes landed on disk");
  assert.equal(img.mime, "image/png");
  assert.equal(img.data.toString("base64"), PNG_B64, "byte-for-byte");
});

test("a value that is already a reference passes through untouched", async () => {
  const ref = "/branding-images/abc123.png";
  const out = await externalizeBrandingImages({ appLogo: ref });
  assert.equal(out.appLogo, ref, "patching settings repeatedly must not re-store");
});

test("null and absent keys are left alone", async () => {
  assert.deepEqual(await externalizeBrandingImages({ appLogo: null }), { appLogo: null });
  assert.deepEqual(await externalizeBrandingImages({ appName: "Stage" }), { appName: "Stage" });
});

test("identical images dedupe to one file", async () => {
  const a = (await externalizeBrandingImages({ appLogo: DATA_URL })).appLogo;
  const b = (await externalizeBrandingImages({ emptySlotLogo: DATA_URL })).emptySlotLogo;
  assert.equal(a, b, "content-addressed, so the same bytes are the same file");
});

test("every branding key is externalized, including the pre-crop originals", async () => {
  const out = await externalizeBrandingImages({
    appLogo: DATA_URL,
    appLogoOriginal: DATA_URL,
    emptySlotLogo: DATA_URL,
    emptySlotLogoOriginal: DATA_URL,
    defaultAvatar: DATA_URL,
    defaultAvatarOriginal: DATA_URL,
  });
  for (const [k, v] of Object.entries(out)) {
    assert.match(v as string, /^\/branding-images\//, `${k} was left inline`);
  }
});

test("migration converts an install still holding base64, and reports what it moved", async () => {
  const settings = { appLogo: DATA_URL, emptySlotLogo: null, appName: "Stage" };
  const { patch, converted } = await migrateInlineBrandingImages(settings as never);
  assert.deepEqual(converted, ["appLogo"]);
  assert.match(patch.appLogo as string, /^\/branding-images\//);
  assert.ok(!("appName" in patch), "only image keys are touched");
});

test("migration is a no-op once already converted", async () => {
  const settings = { appLogo: "/branding-images/abc123.png" };
  const { patch, converted } = await migrateInlineBrandingImages(settings as never);
  assert.deepEqual(converted, []);
  assert.deepEqual(patch, {}, "steady state writes nothing");
});

test("a malformed image does not block boot", async () => {
  const settings = { appLogo: "data:image/png;base64,!!!not-base64!!!" };
  const { converted } = await migrateInlineBrandingImages(settings as never);
  assert.deepEqual(converted, [], "left inline rather than throwing — the old behaviour still works");
});

test("a traversal attempt in a served name is refused", async () => {
  assert.equal(await readImage(BRANDING_IMAGE_DIR, "../settings.json"), null);
  assert.equal(await readImage(BRANDING_IMAGE_DIR, "..%2Fsettings.json"), null);
  assert.equal(await readImage(BRANDING_IMAGE_DIR, "notes.txt"), null, "unknown extension refused");
});

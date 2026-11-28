// A config backup carries the photo themes and the edits themselves, and a
// restore of it brings both back as they were: the book through its restore
// check, each edit through the image rules (its name is a hash of its bytes).
// The OpenAI key is in secrets.bin, which no backup carries.

import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-photo-themes-backup-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { photoThemes, PHOTO_THEME_IMAGE_DIR } = await import("./service.js");
const { configSnapshot } = await import("../config-snapshot.js");
const { approveShown, fakeServer, pcoPhoto, startFakeOpenAi } = await import("./photo-themes-harness.js");

const KEY = "sk-proj-BACKUPKEY0123456789abcdefgh";
let fake: Awaited<ReturnType<typeof startFakeOpenAi>>;

before(async () => {
  fake = await startFakeOpenAi();
  process.env.STAGE_UTILITY_OPENAI_BASE_URL = fake.base;
  const srv = await fakeServer();
  srv.rosters.set("2001", [{ personId: "1001", name: "Alex R.", photoUrl: pcoPhoto("1001") }]);
  await photoThemes.start(srv.deps, { sweep: false });
});
after(async () => {
  photoThemes.stop();
  await fake.close();
  delete process.env.STAGE_UTILITY_OPENAI_BASE_URL;
});

it("round-trips the themes and their photos through a backup", async () => {
  await photoThemes.connection.saveKey(KEY);
  const theme = await photoThemes.createTheme({ name: "Christmas 2026", prompt: "Warm lights" });
  await photoThemes.choosePlan("2001", { serviceTypeId: "100", sortDate: "2026-12-24T16:00:00Z", themeId: theme.id });
  await photoThemes.generate("2001", "100", "missing");
  await photoThemes.idle();
  await approveShown(photoThemes, theme.id, "1001");
  const before = photoThemes.state();
  const [file] = await fs.readdir(path.join(TMP, PHOTO_THEME_IMAGE_DIR));
  const bytes = await fs.readFile(path.join(TMP, PHOTO_THEME_IMAGE_DIR, file!));

  const bundle = await configSnapshot.build("test");
  assert.ok(bundle.files["photo-themes.json"], "the book is in the backup");
  assert.equal(bundle.images?.[`${PHOTO_THEME_IMAGE_DIR}/${file}`], bytes.toString("base64"), "the edit is in the backup");
  assert.ok(!JSON.stringify(bundle).includes(KEY), "the key is not");

  // A box that lost both.
  await fs.rm(path.join(TMP, "photo-themes.json"));
  await fs.rm(path.join(TMP, PHOTO_THEME_IMAGE_DIR), { recursive: true });

  const applied = await configSnapshot.apply(JSON.parse(JSON.stringify(bundle)));
  assert.ok(applied.includes("photo-themes.json"));
  assert.ok(applied.includes(`${PHOTO_THEME_IMAGE_DIR}/${file}`));
  assert.deepEqual(await fs.readFile(path.join(TMP, PHOTO_THEME_IMAGE_DIR, file!)), bytes);

  // The restart a restore ends in.
  await photoThemes.reloadForTests();
  assert.deepEqual(photoThemes.state().themes, before.themes);
  assert.equal(photoThemes.shownPhotos("2001").get("1001"), `photo-theme:${file}`);
});

it("refuses a backup whose edit is not the image its name says", async () => {
  const bundle = await configSnapshot.build("test");
  const name = Object.keys(bundle.images ?? {}).find((k) => k.startsWith(`${PHOTO_THEME_IMAGE_DIR}/`))!;
  bundle.images![name] = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");
  await assert.rejects(() => configSnapshot.apply(bundle), /photo-theme-images\/[0-9a-f]{16}\.webp: is not a valid webp image/);
});

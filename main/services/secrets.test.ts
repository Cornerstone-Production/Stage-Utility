// A decrypt failure used to be indistinguishable from "no secrets yet": both
// produced an empty blob, and the next setSecret() wrote that empty blob back
// over the file. The realistic trigger is a wrong key — setting
// $STAGE_UTILITY_KEY on a box that already has an encryption.key — after which
// every integration reports "not configured", the operator re-enters one
// credential to fix it, and that save destroys the rest permanently.

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-secrets-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { secretsStore } = await import("./secrets.js");
const BIN = path.join(TMP, "secrets.bin");

const corruptFiles = async (): Promise<string[]> =>
  (await fs.readdir(TMP)).filter((f) => f.startsWith("secrets.bin.corrupt-"));

describe("secrets store", () => {
  before(async () => {
    await secretsStore.setSecrets("planning-center", { appId: "app-1", secret: "sec-1" });
    await secretsStore.setSecrets("propresenter", { password: "pp-pass" });
  });

  it("round-trips what it was given", async () => {
    assert.deepEqual(await secretsStore.getSecrets("planning-center"), { appId: "app-1", secret: "sec-1" });
  });

  it("leaves no plaintext credential in the file on disk", async () => {
    const raw = await fs.readFile(BIN);
    assert.ok(!raw.toString("utf8").includes("sec-1"), "secret found in cleartext on disk");
  });

  it("writes atomically, leaving no temp file behind", async () => {
    assert.equal((await fs.readdir(TMP)).filter((f) => f.endsWith(".tmp")).length, 0);
  });

  describe("when the file will not decrypt", () => {
    before(async () => {
      // Simulate the wrong key / a truncated write, and drop the memoised cache
      // so the next read actually goes to disk.
      await fs.writeFile(BIN, Buffer.from("not a valid GCM payload"));
      (secretsStore as unknown as { cache: unknown }).cache = null;
    });

    it("preserves the original bytes instead of destroying them", async () => {
      await secretsStore.getSecrets("planning-center");
      const backups = await corruptFiles();
      assert.equal(backups.length, 1, "expected exactly one quarantined copy");
      assert.equal(
        await fs.readFile(path.join(TMP, backups[0]!), "utf8"),
        "not a valid GCM payload",
        "the quarantined copy must be the original bytes, byte for byte",
      );
    });

    it("reports empty rather than throwing, so the app still starts", async () => {
      assert.deepEqual(await secretsStore.getSecrets("planning-center"), {});
    });

    it("a later save cannot clobber the quarantined copy", async () => {
      // This is the data loss: re-entering one credential used to overwrite the
      // file that held the others. The backup is what makes it recoverable.
      await secretsStore.setSecrets("planning-center", { appId: "new", secret: "new" });
      const backups = await corruptFiles();
      assert.equal(backups.length, 1);
      assert.equal(await fs.readFile(path.join(TMP, backups[0]!), "utf8"), "not a valid GCM payload");
    });
  });
});

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

const keptFiles = async (): Promise<string[]> =>
  (await fs.readdir(TMP)).filter((f) => f.startsWith("secrets.bin.unreadable-"));

const UNREADABLE = "not a valid GCM payload";

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

  it("survives concurrent saves without corrupting the blob", async () => {
    // The bug: every caller wrote a fixed `${file}.tmp`. Two overlapping saves
    // — wireless persisting per connection while integration config saves, both
    // reachable from unauthenticated LAN POSTs — interleaved their bytes, and the
    // winning rename promoted a blob whose GCM tag no longer verified. Every
    // credential gone, and the loser's rename threw ENOENT at an HTTP handler.
    const ids = Array.from({ length: 12 }, (_, i) => `svc-${i}`);
    await Promise.all(ids.map((id) => secretsStore.setSecrets(id, { token: `t-${id}` })));

    // Re-read from disk, not from the cache, or this proves nothing.
    (secretsStore as unknown as { cache: unknown }).cache = null;
    for (const id of ids) {
      assert.deepEqual(await secretsStore.getSecrets(id), { token: `t-${id}` }, `${id} lost`);
    }
    assert.equal((await fs.readdir(TMP)).filter((f) => f.includes(".tmp")).length, 0, "temp file left behind");
  });

  describe("when the file cannot be read", () => {
    before(async () => {
      // Stands in for both causes that look identical here: damaged ciphertext,
      // and a wrong or unavailable key. Drop the memoised cache so the next read
      // actually goes to disk.
      await fs.writeFile(BIN, Buffer.from(UNREADABLE));
      (secretsStore as unknown as { cache: unknown; unreadable: boolean }).cache = null;
    });

    it("reports empty rather than throwing, so the app still starts", async () => {
      assert.deepEqual(await secretsStore.getSecrets("planning-center"), {});
    });

    it("leaves the file completely untouched on a read", async () => {
      // The important case: the KEY may be what is wrong, and the file perfectly
      // good. Moving it aside here would turn "fix the key and restart" into
      // permanent loss.
      await secretsStore.getSecrets("propresenter");
      assert.equal(await fs.readFile(BIN, "utf8"), UNREADABLE, "the file must not be modified");
      assert.deepEqual(await keptFiles(), [], "nothing should be set aside on a read");
    });

    it("preserves the old bytes at the moment a save would destroy them", async () => {
      // Re-entering one credential used to overwrite the file holding the others.
      await secretsStore.setSecrets("planning-center", { appId: "new", secret: "new" });
      const kept = await keptFiles();
      assert.equal(kept.length, 1, "expected the old file to be set aside exactly once");
      assert.equal(
        await fs.readFile(path.join(TMP, kept[0]!), "utf8"),
        UNREADABLE,
        "the preserved copy must be the original bytes, byte for byte",
      );
    });

    it("writes the new secrets normally once the old file is preserved", async () => {
      assert.deepEqual(await secretsStore.getSecrets("planning-center"), { appId: "new", secret: "new" });
    });

    it("does not set the file aside again on the next save", async () => {
      await secretsStore.setSecrets("obs", { password: "p" });
      assert.equal((await keptFiles()).length, 1, "one preserved copy, not one per save");
    });
  });

  describe("when the file cannot be opened at all", () => {
    // Distinct from "will not decrypt": here the read itself fails — EACCES after
    // a restore changed ownership, EIO on a dying card, EPERM on a late mount.
    // This used to rethrow. getSecrets is awaited unguarded inside
    // integrationManager.init(), itself a top-level await in server.ts, so an
    // unreadable file stopped the appliance booting at all and it kept dying on
    // every supervisor restart — where beta came up degraded but fully serving.
    // Root ignores mode bits, so skip rather than pass vacuously.
    const asRoot = process.getuid?.() === 0;

    it("resolves empty instead of rejecting, so boot survives", async (t) => {
      if (asRoot) return t.skip("mode bits do not apply to root");
      await secretsStore.setSecrets("planning-center", { appId: "keep-me" });
      await fs.chmod(BIN, 0o000);
      (secretsStore as unknown as { cache: unknown; unreadable: boolean }).cache = null;
      try {
        assert.deepEqual(
          await secretsStore.getSecrets("planning-center"),
          {},
          "must degrade to empty, not reject",
        );
      } finally {
        await fs.chmod(BIN, 0o600);
      }
    });

    it("leaves the unreadable file untouched", async (t) => {
      if (asRoot) return t.skip("mode bits do not apply to root");
      // Fixing the permissions and restarting must recover in place.
      (secretsStore as unknown as { cache: unknown; unreadable: boolean }).cache = null;
      (secretsStore as unknown as { unreadable: boolean }).unreadable = false;
      assert.deepEqual(await secretsStore.getSecrets("planning-center"), { appId: "keep-me" });
    });
  });
});

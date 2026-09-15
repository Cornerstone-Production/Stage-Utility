// A secret save that did not reach disk must not read as saved.
//
// The failure, driven on a real server before this existed: with the data
// directory read-only, `POST /api/cues/<name>` answered 200 with EACCES in the
// detail, `GET /api/cues/tokens` then reported a lastUsedAt, and a restart
// reported null. The store had mutated its cached blob and THEN persisted, with
// nothing to undo the mutation when the persist threw — so every read until the
// next restart reported a value the file had never held. That is this repo's own
// "a failed save read as saved until the next restart lost the work", and it
// applies to every integration credential, not only cue tokens.
//
// A rollback would have been the wrong fix and the concurrency case below is
// why. The store re-encrypts the WHOLE file per save and the queue only
// serialises the writes, so with the mutation outside the queue two callers
// interleave: A mutates, B mutates, A's write carries both and fails, and A
// undoing its own slot takes B's successful change with it. The fix moves the
// mutation inside the queue and moves the cache only after the bytes are down —
// see commit() in secrets.ts.
//
// Everything here drives the REAL store: a real encrypted file, a real
// read-only directory, and a real concurrent pair of callers.

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-secrets-fail-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { secretsStore } = await import("./secrets.js");

/** Root ignores mode bits, so the read-only case would pass vacuously there. */
const asRoot = process.getuid?.() === 0;

/** The store's memoised blob, reachable for the "what would a restart see" read. */
const memo = secretsStore as unknown as { cache: unknown };

/** What the process is answering right now, without touching disk. */
const inMemory = (id: string) => secretsStore.getSecrets(id);

/** What a restart would read: drop the memoised blob and decrypt the file. */
async function fromDisk(id: string): Promise<Record<string, string>> {
  memo.cache = null;
  return secretsStore.getSecrets(id);
}

before(async () => {
  await secretsStore.setSecrets("planning-center", { appId: "app-1", secret: "sec-1" });
});

after(async () => {
  await fs.chmod(TMP, 0o700).catch(() => {});
  await fs.rm(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

describe("a save that cannot reach disk", () => {
  it("is REPORTED to the caller rather than answered as success", async (t) => {
    if (asRoot) return t.skip("mode bits do not apply to root");
    await fs.chmod(TMP, 0o555);
    try {
      await assert.rejects(
        secretsStore.setSecret("planning-center", "secret", "never-written"),
        /EACCES|EPERM/,
        "the save resolved, so a caller has no way to tell it did not land",
      );
    } finally {
      await fs.chmod(TMP, 0o700);
    }
  });

  it("leaves the cache reading exactly what a restart would read", async (t) => {
    if (asRoot) return t.skip("mode bits do not apply to root");
    // IN MEMORY FIRST — reading disk first would repopulate the cache and hide
    // the disagreement this whole file is about.
    const now = await inMemory("planning-center");
    const afterRestart = await fromDisk("planning-center");
    assert.deepEqual(
      now,
      afterRestart,
      "the cache claimed a value the file does not hold — this is the bug",
    );
    assert.deepEqual(now, { appId: "app-1", secret: "sec-1" }, "the stored value changed");
  });

  it("does not leave a scratch file behind in the data directory", async () => {
    assert.deepEqual(
      (await fs.readdir(TMP)).filter((f) => f.includes(".tmp")),
      [],
      "a failed write left scratch behind, which makes the next attempt fail too",
    );
  });

  it("the next save, once the directory is writable, lands normally", async () => {
    await secretsStore.setSecret("planning-center", "secret", "sec-2");
    assert.deepEqual(await inMemory("planning-center"), { appId: "app-1", secret: "sec-2" });
    assert.deepEqual(await fromDisk("planning-center"), { appId: "app-1", secret: "sec-2" });
  });
});

describe("one caller's failed save and another's successful one, overlapping", () => {
  /**
   * Fail the NEXT write only.
   *
   * A read-only directory fails every write at once, which cannot express "A
   * failed while B succeeded" — the case a rollback gets wrong. So the failure
   * is injected at writeBlob, the one collaborator, and commit() — the ordering
   * actually under test — runs for real, including the queue.
   */
  function failNextWrite(): () => void {
    const store = secretsStore as unknown as {
      writeBlob: (blob: unknown) => Promise<void>;
    };
    const real = store.writeBlob.bind(secretsStore);
    let remaining = 1;
    store.writeBlob = async (blob: unknown) => {
      if (remaining-- > 0) {
        throw Object.assign(new Error("EACCES: permission denied, open 'secrets.bin'"), {
          code: "EACCES",
        });
      }
      return real(blob);
    };
    return () => {
      store.writeBlob = real;
    };
  }

  it("keeps the survivor's change and drops only the one that failed", async () => {
    await secretsStore.setSecrets("pco-pair", { token: "old" });
    const restore = failNextWrite();
    try {
      // Started together, neither awaited before the other begins — which is how
      // integration config and a cue token write actually overlap.
      const failing = secretsStore.setSecret("pco-pair", "token", "A-new");
      const landing = secretsStore.setSecret("pco-pair", "appId", "B-new");
      await assert.rejects(failing, /EACCES/);
      await landing;
    } finally {
      restore();
    }

    const expected = { token: "old", appId: "B-new" };
    assert.deepEqual(
      await inMemory("pco-pair"),
      expected,
      "the cache does not hold exactly the survivor's change over the untouched value",
    );
    assert.deepEqual(
      await fromDisk("pco-pair"),
      expected,
      "the file does not hold exactly the survivor's change over the untouched value",
    );
  });

  it("and a clear that fails leaves the slot readable", async () => {
    await secretsStore.setSecrets("pco-clear", { token: "keep" });
    const restore = failNextWrite();
    try {
      await assert.rejects(secretsStore.clearSecrets("pco-clear"), /EACCES/);
    } finally {
      restore();
    }
    assert.deepEqual(await inMemory("pco-clear"), { token: "keep" });
    assert.deepEqual(await fromDisk("pco-clear"), { token: "keep" });
  });
});

describe("an integration id that is a prototype member name", () => {
  // Same family as the registries in extern-keyed.ts, with one extra edge that
  // only a STORE has: `blob["__proto__"] = {...}` on an ordinary object replaces
  // the prototype instead of adding a key, so JSON.stringify writes {} and the
  // credential is gone — while the cache goes on answering with it by
  // inheritance. A value the cache claims and the file does not hold.
  const NAMES = ["__proto__", "constructor", "valueOf", "toString"];

  it("stores and reloads like any other id", async () => {
    for (const id of NAMES) {
      await secretsStore.setSecrets(id, { token: `t-${id}` });
      assert.deepEqual(await inMemory(id), { token: `t-${id}` }, `${id} in memory`);
      assert.deepEqual(await fromDisk(id), { token: `t-${id}` }, `${id} after a restart`);
    }
  });

  it("does not leak into an unrelated id", async () => {
    assert.deepEqual(await inMemory("nothing-was-ever-stored-here"), {});
    assert.deepEqual(await fromDisk("nothing-was-ever-stored-here"), {});
  });

  it("clears like any other id", async () => {
    for (const id of NAMES) {
      await secretsStore.clearSecrets(id);
      assert.deepEqual(await inMemory(id), {}, `${id} survived a clear`);
      assert.deepEqual(await fromDisk(id), {}, `${id} came back after a restart`);
    }
  });
});

// Secret store. Each integration gets one secret slot.
// Secrets are stored as an encrypted JSON blob at userData/secrets.bin,
// using the AES-256-GCM backend in encryption.ts.

import * as fs from "fs/promises";
import * as path from "path";

import { getEncryptionBackend } from "./encryption.js";
import { getUserDataPath } from "./app-paths.js";
import { externKeyed } from "../types/extern-keyed.js";
import { errorMessage } from "./errors.js";
import { WriteQueue, atomicWrite } from "./write-queue.js";

type SecretsBlob = Record<string, Record<string, string>>;

/**
 * An empty blob with NO PROTOTYPE.
 *
 * The keys are integration ids, and those arrive on HTTP bodies — so this is the
 * same hazard as any externally-keyed table (see main/types/extern-keyed.ts),
 * plus one that is specific to a store: on an ordinary object
 * `blob["__proto__"] = { token: "..." }` does not add a property at all, it
 * REPLACES the object's prototype. JSON.stringify then writes `{}` and the
 * credential is gone, while `getSecrets("__proto__")` goes on answering with it
 * out of the prototype chain — a value the cache claims and the file does not
 * hold, which is the whole thing this file has to stop.
 */
const emptyBlob = (): SecretsBlob => externKeyed({} as SecretsBlob);

class SecretsStore {
  private cache: SecretsBlob | null = null;
  private filePath: string | null = null;
  /** In-flight load, so concurrent callers share one decrypt. */
  private loading: Promise<SecretsBlob> | null = null;
  /** The file on disk exists but could not be read — do not overwrite it blind. */
  private unreadable = false;
  /** Serialises saves. Integration config, wireless config and the boot-time
   *  migration all write this file, several from unauthenticated LAN routes. */
  private writes = new WriteQueue();

  private async getFilePath(): Promise<string> {
    if (!this.filePath) {
      const userDataPath = getUserDataPath();
      await fs.mkdir(userDataPath, { recursive: true });
      this.filePath = path.join(userDataPath, "secrets.bin");
    }
    return this.filePath;
  }

  private async load(): Promise<SecretsBlob> {
    if (this.cache !== null) return this.cache;
    // Callers arrive concurrently (wireless-manager hydrates every connection
    // through Promise.all), and without this each one decrypts separately and
    // logs its own copy of any failure.
    if (!this.loading) {
      this.loading = this.loadOnce().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  private async loadOnce(): Promise<SecretsBlob> {
    const filePath = await this.getFilePath();

    let raw: Buffer;
    try {
      raw = await fs.readFile(filePath);
    } catch (err) {
      // No file yet is the ordinary first run — nothing is at risk, so no flag.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.cache = emptyBlob();
        return this.cache;
      }
      // Anything else — EACCES after a restore changed ownership, EIO on a dying
      // card, EPERM on a data dir mounted late — means a file we could not read,
      // NOT the absence of secrets. This used to rethrow, which was worse than the
      // bug it guarded: getSecrets is awaited unguarded inside
      // integrationManager.init(), itself a top-level await, so an unreadable file
      // stopped the appliance booting at all and it kept dying on every supervisor
      // restart. Degrade the way an undecryptable file does — empty, loudly, file
      // untouched — and let the `unreadable` flag protect the bytes on the next
      // save. That flag is what preserves the data; rejecting here never did.
      this.unreadable = true;
      console.error(
        `[secrets] secrets.bin could not be read (${(err as NodeJS.ErrnoException)?.code ?? "error"}). ` +
          "Starting with no secrets; the file has been left untouched. Fix the " +
          "permissions or the mount and restart to recover in place.",
        err,
      );
      this.cache = emptyBlob();
      return this.cache;
    }

    const backend = getEncryptionBackend();
    try {
      // externKeyed, not a bare parse: the file is JSON somebody could have
      // hand-edited or restored, and a top-level "__proto__" or "constructor"
      // key in it would otherwise be reachable by inheritance from every other
      // lookup into the blob.
      this.cache = externKeyed(
        JSON.parse(
          (await backend.isAvailable()) ? await backend.decrypt(raw) : raw.toString("utf-8"),
        ) as SecretsBlob,
      );
      return this.cache;
    } catch (err) {
      // The file exists and did not yield secrets. Two very different causes look
      // identical here: the ciphertext is damaged, OR the key is wrong/missing
      // (a malformed $STAGE_UTILITY_KEY, a key file on a mount that is not up yet,
      // a key file that is not 32 bytes — encryption.ts even generates a fresh key
      // when the file is absent, which fails the auth tag on a perfectly good
      // file). In the key cases the file is intact and fixing the key recovers
      // everything, so moving it aside now would turn a recoverable problem into a
      // permanent one.
      //
      // So nothing is renamed here. The file stays exactly where it is, and the
      // flag makes the NEXT save preserve it first — a save is the only moment
      // where the old bytes were actually at risk.
      this.unreadable = true;
      console.error(
        "[secrets] secrets.bin exists but could not be read — wrong or unavailable " +
          "encryption key, or damaged ciphertext. Starting with no secrets; the file " +
          "has been left untouched. Restore the original key and restart to recover " +
          "in place. Re-entering credentials will set it aside as secrets.bin.unreadable-*.",
        err,
      );
      this.cache = emptyBlob();
      return this.cache;
    }
  }

  /** Encrypt and write one blob. Throws on any failure; writes nothing else. */
  private async writeBlob(blob: SecretsBlob): Promise<void> {
    const backend = getEncryptionBackend();
    const filePath = await this.getFilePath();

    // The load could not read the existing file, and we are about to write over
    // it. THIS is the moment the old bytes are at risk, so preserve them now
    // rather than on the read — an operator who fixes the key and restarts never
    // reaches here, and gets their secrets back in place.
    if (this.unreadable) {
      const kept = `${filePath}.unreadable-${Date.now()}`;
      try {
        await fs.rename(filePath, kept);
        console.error(
          `[secrets] kept the unreadable secrets.bin as ${kept} before writing a new one.`,
        );
        // Cleared only once the old bytes are SAFELY ASIDE. It used to clear
        // whether the rename worked or not, which spent the one-time
        // preservation on a rename that had not happened: the file was still
        // sitting there unreadable and the next save would overwrite it.
        this.unreadable = false;
      } catch (err) {
        // Genuinely best-effort — the write below still proceeds, because an
        // operator re-entering a credential is how they recover from this and
        // refusing the save would strand them. But it is said out loud, and the
        // flag stays set so the next save tries again.
        console.error(
          `[secrets] could not set the unreadable secrets.bin aside as ${kept}: ` +
            `${errorMessage(err)}. Writing the new file over it.`,
        );
      }
    }

    const json = JSON.stringify(blob);
    const body = (await backend.isAvailable())
      ? await backend.encrypt(json)
      : Buffer.from(json, "utf-8");
    // Atomic, and with a uniquely-named scratch file — see write-queue.ts.
    await atomicWrite(filePath, body, { mode: 0o600 });
  }

  /**
   * Apply `mutate` and save — CACHE LAST, and inside the write queue.
   *
   * The order is the whole point. This used to mutate the cached blob and then
   * persist, with nothing to undo the mutation when the persist threw: a save
   * onto a read-only data directory answered EACCES, and every read until the
   * next restart went on reporting the value that had never reached disk. That
   * is the repository's own "a failed save read as saved" failure.
   *
   * A rollback is NOT the fix, and this is why it is written this way instead.
   * The whole file is re-encrypted per save and the queue only serialises the
   * WRITES, so with the mutation outside the queue two callers interleave:
   *
   *   A mutates its slot, B mutates its slot, A's write runs (carrying BOTH
   *   changes) and fails. A restores its own slot — and takes B's change out of
   *   the cache with it, though B has not failed. B's write then runs over the
   *   rolled-back blob and B is lost from the file too, silently.
   *
   * Mutating INSIDE the queue removes the interleaving instead of trying to
   * unwind it. Each caller builds its next blob from the cache as it stands when
   * its turn comes — so it already contains every earlier committed change — and
   * the cache only moves once the bytes are down. A failure leaves the cache
   * byte-for-byte what a fresh load from disk would give, and is RETHROWN so the
   * caller can tell a save that landed from one that did not.
   */
  private async commit(mutate: (blob: SecretsBlob) => void): Promise<void> {
    // Outside the queue: the decrypt has nothing to serialise against, and
    // loadOnce already shares one in-flight read between concurrent callers.
    await this.load();
    return this.writes.enqueue(async () => {
      // A copy, one level deep. Every mutator below REPLACES a slot rather than
      // editing one in place, but copying the slots too means that stays a
      // property of this function rather than a rule the next mutator has to
      // know about.
      // Re-read rather than `?? {}` if the cache is somehow gone by the time our
      // turn comes: starting from empty here would write a blob with every other
      // credential missing, which is the one outcome worse than not saving.
      const base = this.cache ?? (await this.load());
      const next = emptyBlob();
      for (const [id, slot] of Object.entries(base)) next[id] = { ...slot };
      mutate(next);
      try {
        await this.writeBlob(next);
      } catch (err) {
        console.error(
          `[secrets] save FAILED (${errorMessage(err)}). Nothing was changed in memory ` +
            "either, so the value being read now is the one the file still holds. Fix " +
            "the permissions or the mount and save again.",
        );
        throw err;
      }
      this.cache = next;
    });
  }

  /** One integration's slot. A COPY: the cache only ever changes through
   *  commit(), so handing out the live object would let a caller edit it into
   *  disagreeing with the file without ever writing. */
  async getSecrets(integrationId: string): Promise<Record<string, string>> {
    const blob = await this.load();
    return { ...(blob[integrationId] ?? {}) };
  }

  /**
   * Is the file on disk present but unreadable — a wrong key, or damaged bytes?
   *
   * For a caller that would write of its OWN accord rather than because the
   * operator asked it to. An operator-initiated save must still go through:
   * re-entering a credential is how someone recovers from this, and persist()
   * sets the old bytes aside as secrets.bin.unreadable-* first so nothing is
   * lost. But a save nobody asked for spends that one-time preservation on the
   * operator's behalf, and after it the old file is no longer IN PLACE — so
   * fixing the key and restarting stops recovering on its own, which is the
   * whole point of not renaming on the read.
   *
   * The boot-time credential migration in integration-manager is that caller.
   * Loads first, because "unreadable" is not known until something has tried.
   */
  async isUnreadable(): Promise<boolean> {
    await this.load();
    return this.unreadable;
  }

  /** Set one field. Throws if the save did not reach disk, having changed
   *  nothing in memory — see commit(). */
  async setSecret(integrationId: string, key: string, value: string): Promise<void> {
    await this.commit((blob) => {
      blob[integrationId] = { ...(blob[integrationId] ?? {}), [key]: value };
    });
  }

  /** Replace a whole slot. Same contract as setSecret. */
  async setSecrets(integrationId: string, secrets: Record<string, string>): Promise<void> {
    await this.commit((blob) => {
      blob[integrationId] = { ...secrets };
    });
  }

  /**
   * Replace several slots in one write.
   *
   * The whole blob is re-encrypted and rewritten on every save, so a caller with
   * N things to store must not call setSecrets N times — wireless did, once per
   * connection, on every edit and on the boot migration. On a Pi's SD card that
   * is a visible stall on the request path, and it widens the window for any
   * concurrent write.
   */
  async setManySecrets(entries: Record<string, Record<string, string>>): Promise<void> {
    await this.commit((blob) => {
      for (const [id, secrets] of Object.entries(entries)) {
        if (Object.keys(secrets).length === 0) delete blob[id];
        else blob[id] = { ...secrets };
      }
    });
  }

  /** Same contract as setSecret: a slot is gone from memory only once it is gone
   *  from the file. */
  async clearSecrets(integrationId: string): Promise<void> {
    await this.commit((blob) => {
      delete blob[integrationId];
    });
  }
}

export const secretsStore = new SecretsStore();

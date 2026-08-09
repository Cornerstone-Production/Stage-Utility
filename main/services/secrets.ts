// Secret store. Each integration gets one secret slot.
// Secrets are stored as an encrypted JSON blob at userData/secrets.bin,
// using the AES-256-GCM backend in encryption.ts.

import * as fs from "fs/promises";
import * as path from "path";

import { getEncryptionBackend } from "./encryption.js";
import { getUserDataPath } from "./app-paths.js";
import { WriteQueue, atomicWrite } from "./write-queue.js";

type SecretsBlob = Record<string, Record<string, string>>;

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
        this.cache = {};
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
      this.cache = {};
      return this.cache;
    }

    const backend = getEncryptionBackend();
    try {
      this.cache = JSON.parse(
        (await backend.isAvailable()) ? await backend.decrypt(raw) : raw.toString("utf-8"),
      ) as SecretsBlob;
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
      this.cache = {};
      return this.cache;
    }
  }

  /**
   * Encrypt and write the whole blob.
   *
   * Serialised: integration config, wireless config and the boot migration all
   * write this one file, several of them from unauthenticated LAN routes. Two
   * overlapping saves used to share a fixed `.tmp` path and could splice into a
   * blob that no longer decrypted — every credential lost.
   */
  private persist(): Promise<void> {
    return this.writes.enqueue(async () => {
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
        } catch {
          /* best-effort: if it cannot be preserved, the write below still proceeds */
        }
        this.unreadable = false;
      }

      const json = JSON.stringify(this.cache ?? {});
      const body = (await backend.isAvailable())
        ? await backend.encrypt(json)
        : Buffer.from(json, "utf-8");
      // Atomic, and with a uniquely-named scratch file — see write-queue.ts.
      await atomicWrite(filePath, body, { mode: 0o600 });
    });
  }

  async getSecrets(integrationId: string): Promise<Record<string, string>> {
    const blob = await this.load();
    return blob[integrationId] ?? {};
  }

  async setSecret(integrationId: string, key: string, value: string): Promise<void> {
    const blob = await this.load();
    blob[integrationId] = { ...(blob[integrationId] ?? {}), [key]: value };
    await this.persist();
  }

  async setSecrets(integrationId: string, secrets: Record<string, string>): Promise<void> {
    const blob = await this.load();
    blob[integrationId] = secrets;
    await this.persist();
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
    const blob = await this.load();
    for (const [id, secrets] of Object.entries(entries)) {
      if (Object.keys(secrets).length === 0) delete blob[id];
      else blob[id] = secrets;
    }
    await this.persist();
  }

  async clearSecrets(integrationId: string): Promise<void> {
    const blob = await this.load();
    delete blob[integrationId];
    await this.persist();
  }
}

export const secretsStore = new SecretsStore();

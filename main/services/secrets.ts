// Secret store. Each integration gets one secret slot.
// Secrets are stored as an encrypted JSON blob at userData/secrets.bin,
// using the AES-256-GCM backend in encryption.ts.

import * as fs from "fs/promises";
import * as path from "path";

import { getEncryptionBackend } from "./encryption.js";
import { getUserDataPath } from "./app-paths.js";

type SecretsBlob = Record<string, Record<string, string>>;

class SecretsStore {
  private cache: SecretsBlob | null = null;
  private filePath: string | null = null;
  /** In-flight load, so concurrent callers share one decrypt. */
  private loading: Promise<SecretsBlob> | null = null;
  /** The file on disk exists but could not be read — do not overwrite it blind. */
  private unreadable = false;

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
      // No file yet is the ordinary first run. Anything else — a permissions
      // problem, an I/O error — is NOT evidence that there are no secrets, and
      // must not be answered with an empty blob that the next save writes back.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.cache = {};
        return this.cache;
      }
      throw err;
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

  private async persist(): Promise<void> {
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
        console.error(`[secrets] kept the unreadable secrets.bin as ${kept} before writing a new one.`);
      } catch {
        /* best-effort: if it cannot be preserved, the write below still proceeds */
      }
      this.unreadable = false;
    }

    const json = JSON.stringify(this.cache ?? {});
    const body = (await backend.isAvailable()) ? await backend.encrypt(json) : Buffer.from(json, "utf-8");
    // Atomic, for the same reason data-store is: a plain writeFile truncates in
    // place, so an update or a power cut mid-write leaves a short file that fails
    // its GCM auth tag on the next boot — every credential gone.
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, body, { mode: 0o600 });
    await fs.rename(tmp, filePath);
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

  async clearSecrets(integrationId: string): Promise<void> {
    const blob = await this.load();
    delete blob[integrationId];
    await this.persist();
  }
}

export const secretsStore = new SecretsStore();

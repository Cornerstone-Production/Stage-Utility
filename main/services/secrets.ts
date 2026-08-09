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
      // The file EXISTS but will not decrypt or parse — a truncated write, or the
      // wrong key (setting $STAGE_UTILITY_KEY on a box that already had a key file
      // does exactly this). Treating that as "no secrets" is how every credential
      // gets destroyed: the operator sees them all disconnected, re-enters one, and
      // that save persists a blob containing only the one. Keep the bytes so the
      // real key can still recover them, the way data-store does.
      try {
        await fs.rename(filePath, `${filePath}.corrupt-${Date.now()}`);
      } catch {
        /* best-effort backup */
      }
      console.error(
        "[secrets] secrets.bin could not be decrypted (wrong key, or a truncated write). " +
          "Backed up to secrets.bin.corrupt-* and starting empty — restore the original " +
          "encryption key and rename that file back to recover, rather than re-entering keys.",
        err,
      );
      this.cache = {};
      return this.cache;
    }
  }

  private async persist(): Promise<void> {
    const backend = getEncryptionBackend();
    const filePath = await this.getFilePath();
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

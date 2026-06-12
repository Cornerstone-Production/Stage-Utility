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
    const backend = getEncryptionBackend();
    try {
      const filePath = await this.getFilePath();
      const raw = await fs.readFile(filePath);
      if (!(await backend.isAvailable())) {
        // Fall back to plaintext JSON if encryption unavailable.
        this.cache = JSON.parse(raw.toString("utf-8")) as SecretsBlob;
      } else {
        const decrypted = await backend.decrypt(raw);
        this.cache = JSON.parse(decrypted) as SecretsBlob;
      }
      return this.cache;
    } catch {
      this.cache = {};
      return this.cache;
    }
  }

  private async persist(): Promise<void> {
    const backend = getEncryptionBackend();
    const filePath = await this.getFilePath();
    const json = JSON.stringify(this.cache ?? {});
    if (!(await backend.isAvailable())) {
      await fs.writeFile(filePath, json, "utf-8");
    } else {
      const encrypted = await backend.encrypt(json);
      await fs.writeFile(filePath, encrypted);
    }
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

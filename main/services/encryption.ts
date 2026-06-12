// encryption.ts — AES-256-GCM encryption backed by a key file in the data dir.
//
// The key is a 32-byte random value stored at $DATA_DIR/encryption.key
// (mode 0o600), generated automatically on first use. All secret storage goes
// through getEncryptionBackend(); callers never touch crypto or key material.
//
// Ciphertext layout: [ 12-byte IV ][ 16-byte authTag ][ encrypted bytes ]

import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

import { getUserDataPath } from "./app-paths.js";

export interface EncryptionBackend {
  /** Returns true if encryption is supported in this environment. */
  isAvailable(): Promise<boolean>;
  /** Encrypt a UTF-8 string; returns a Buffer of ciphertext. */
  encrypt(plaintext: string): Promise<Buffer>;
  /** Decrypt a Buffer of ciphertext; returns the original UTF-8 string. */
  decrypt(ciphertext: Buffer): Promise<string>;
}

// Key is loaded (or generated) lazily on first use and memoised.
let _keyPromise: Promise<Buffer> | null = null;

function getKey(): Promise<Buffer> {
  if (!_keyPromise) _keyPromise = loadOrCreateKey();
  return _keyPromise;
}

async function loadOrCreateKey(): Promise<Buffer> {
  const keyFile = path.join(getUserDataPath(), "encryption.key");
  try {
    const key = await fs.readFile(keyFile);
    if (key.length !== 32) {
      throw new Error(`[encryption] key at ${keyFile} is ${key.length} bytes; expected 32`);
    }
    return key;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // Key file doesn't exist yet — generate and save.
    const key = crypto.randomBytes(32);
    await fs.writeFile(keyFile, key, { mode: 0o600 });
    console.log(`[encryption] generated new key → ${keyFile}`);
    return key;
  }
}

const backend: EncryptionBackend = {
  isAvailable: async () => true,

  encrypt: async (plaintext: string): Promise<Buffer> => {
    const key = await getKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag(); // always 16 bytes
    return Buffer.concat([iv, authTag, encrypted]);
  },

  decrypt: async (ciphertext: Buffer): Promise<string> => {
    if (ciphertext.length < 28) {
      throw new Error("[encryption] decrypt: ciphertext too short (< 28 bytes)");
    }
    const key = await getKey();
    const iv = ciphertext.subarray(0, 12);
    const authTag = ciphertext.subarray(12, 28);
    const encrypted = ciphertext.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted).toString("utf8") + decipher.final("utf8");
  },
};

/** Return the active encryption backend. */
export function getEncryptionBackend(): EncryptionBackend {
  return backend;
}

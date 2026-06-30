// encryption.ts — AES-256-GCM encryption backed by a 32-byte key.
//
// The key is resolved from the first of these sources that is set (the default
// keeps every existing install working with no migration):
//   1. $STAGE_UTILITY_KEY      — a raw 32-byte key as base64 or hex. Used
//      directly; NO key file is read or written. Lets the key live in a systemd
//      unit, secrets manager, or Docker secret, never on the data disk.
//   2. $STAGE_UTILITY_KEY_FILE — absolute path to a key file outside the data
//      dir. Read if present, else generated + written there (mode 0o600). Keeps
//      the key out of a backed-up/synced data dir.
//   3. (default)               — $DATA_DIR/encryption.key (mode 0o600),
//      generated automatically on first use.
//
// Whatever the source, the running service must be able to read the key
// unattended at boot, so it shares the service user's trust domain — see
// SECURITY.md for the threat model. All secret storage goes through
// getEncryptionBackend(); callers never touch crypto or key material.
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
  // 1. Inline key from the environment — used directly, never written to disk.
  const inline = process.env.STAGE_UTILITY_KEY?.trim();
  if (inline) return parseInlineKey(inline);

  // 2. Operator-chosen key file (outside the data dir), else 3. the default.
  const keyFile = process.env.STAGE_UTILITY_KEY_FILE?.trim()
    ? path.resolve(process.env.STAGE_UTILITY_KEY_FILE.trim())
    : path.join(getUserDataPath(), "encryption.key");

  try {
    const key = await fs.readFile(keyFile);
    if (key.length !== 32) {
      throw new Error(`[encryption] key at ${keyFile} is ${key.length} bytes; expected 32`);
    }
    // Best-effort: tighten perms on a key written before mode 0o600 was enforced
    // (and a no-op on filesystems/OSes that don't honour POSIX modes).
    void fs.chmod(keyFile, 0o600).catch(() => {});
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

// Decode a $STAGE_UTILITY_KEY value (base64 or hex) into a 32-byte key.
function parseInlineKey(value: string): Buffer {
  // Try hex first when it looks like hex (64 chars, hex alphabet), else base64.
  const isHex = value.length === 64 && /^[0-9a-fA-F]+$/.test(value);
  const key = Buffer.from(value, isHex ? "hex" : "base64");
  if (key.length !== 32) {
    throw new Error(
      `[encryption] $STAGE_UTILITY_KEY must decode to 32 bytes (got ${key.length}); ` +
        `provide a 32-byte key as base64 (e.g. \`openssl rand -base64 32\`) or hex (64 chars).`,
    );
  }
  return key;
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

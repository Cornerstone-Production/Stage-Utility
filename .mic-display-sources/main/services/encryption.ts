// encryption.ts — Portable encryption backend.
//
// In Glaze mode, index.ts calls setEncryptionBackend({ ... safeStorage ... })
// wrapping Glaze's async safeStorage calls.
//
// In standalone mode, server.ts calls setEncryptionBackend() with an
// AES-256-GCM implementation backed by a key file in the data directory.
//
// All consumers call getEncryptionBackend() and use the returned interface —
// they never import safeStorage or Node's crypto directly.

export interface EncryptionBackend {
  /** Returns true if encryption is supported in this environment. */
  isAvailable(): Promise<boolean>;
  /** Encrypt a UTF-8 string; returns a Buffer of ciphertext. */
  encrypt(plaintext: string): Promise<Buffer>;
  /** Decrypt a Buffer of ciphertext; returns the original UTF-8 string. */
  decrypt(ciphertext: Buffer): Promise<string>;
}

let _backend: EncryptionBackend | null = null;

/** Set the encryption backend.  Must be called in the entry point before any
 *  secrets store operation. */
export function setEncryptionBackend(backend: EncryptionBackend): void {
  _backend = backend;
}

/** Return the active backend.  Throws if not yet configured. */
export function getEncryptionBackend(): EncryptionBackend {
  if (!_backend) {
    throw new Error(
      "[encryption] getEncryptionBackend() called before setEncryptionBackend(). " +
        "Call setEncryptionBackend() in the entry point (index.ts or server.ts).",
    );
  }
  return _backend;
}

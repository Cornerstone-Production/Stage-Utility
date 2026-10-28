// A throwaway release signing key, for tests only.
//
// Made fresh in each test process and never written into the tree: a committed
// private key, test-only or not, is what the secret scan exists to stop, and a key
// pair a test makes for itself proves the same things. The production public key
// is scripts/kiosk/release-signing.pub.pem and nothing here reads it.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TestSigningKey {
  /** PKCS#8 PEM of the private half. */
  privatePem: string;
  /** SubjectPublicKeyInfo PEM of the public half, as the server serves it. */
  publicPem: string;
  /** .NET's <RSAKeyValue> of the public half, as the server serves it. */
  publicXml: string;
  /** A PKCS#1 v1.5 SHA-256 signature of `data`, as CI makes one. */
  sign(data: Buffer | string): Buffer;
  /** A file holding the public PEM (made once, removed at exit). */
  publicFile(): string;
}

function makeKey(bits: number): TestSigningKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: bits });
  const jwk = publicKey.export({ format: "jwk" });
  const b64 = (v: string | undefined) => Buffer.from(v ?? "", "base64url").toString("base64");
  const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  let file: string | null = null;
  return {
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicPem,
    publicXml: `<RSAKeyValue><Modulus>${b64(jwk.n)}</Modulus><Exponent>${b64(jwk.e)}</Exponent></RSAKeyValue>`,
    sign: (data) => crypto.sign("sha256", typeof data === "string" ? Buffer.from(data) : data, privateKey),
    publicFile: () => {
      if (file) return file;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "su-test-signing-key-"));
      process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
      file = path.join(dir, "TEST-ONLY-release-signing.pub.pem");
      fs.writeFileSync(file, publicPem);
      return file;
    },
  };
}

const made = new Map<string, TestSigningKey>();

/** The process's test key of `bits` (3072, the release key's size, by default).
 *  A different `name` is a different key of the same size: a key a test can use
 *  to stand for a rotated one, or for one an attacker made. */
export function testSigningKey(bits = 3072, name = "release"): TestSigningKey {
  const id = `${name}:${bits}`;
  let key = made.get(id);
  if (!key) {
    key = makeKey(bits);
    made.set(id, key);
  }
  return key;
}

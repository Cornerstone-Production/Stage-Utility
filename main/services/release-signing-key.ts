// release-signing-key.ts — the public half of the key every release's update
// payloads are signed with.
//
// CI signs each file a machine updates itself from (the Mac output helper's zips,
// the Windows kiosk's launcher) with a private key held only as a GitHub Actions
// secret. This server never has that key. It serves the public half, from one
// file in the tree, to the installers, which write it beside the updater they
// install; the updater then checks every payload against that installed copy and
// never against one fetched at update time. See docs/kiosk-devices.md.
//
// RSA-3072 with PKCS#1 v1.5 and SHA-256, because both machines verify it with
// what they already have: macOS's /usr/bin/openssl (LibreSSL, whose command line
// has no Ed25519) and Windows PowerShell 5.1 on .NET Framework, which reads an RSA
// key from XML and nothing else. So the one PEM file is served as it is for a Mac
// and as .NET's <RSAKeyValue> for Windows, derived here.

import * as crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { APP_ROOT } from "./app-root.js";
import { errorMessage } from "./errors.js";

/** The one copy of the public key, in the tree the server runs from. In
 *  scripts/kiosk, because that folder ships in every release archive. */
export const RELEASE_SIGNING_KEY_FILE = path.join(APP_ROOT, "scripts", "kiosk", "release-signing.pub.pem");

/**
 * The key file the server serves: RELEASE_SIGNING_KEY_FILE, unless the test hook
 * says otherwise. STAGE_UTILITY_TEST_SIGNING_KEY_FILE exists so a route test can
 * serve a throwaway key; it is not an operator setting and is not documented as
 * one, and it is said on a log line the first time it is used.
 */
export function signingKeyFile(): string {
  const file = process.env.STAGE_UTILITY_TEST_SIGNING_KEY_FILE?.trim();
  if (!file) return RELEASE_SIGNING_KEY_FILE;
  if (!testHookAnnounced) {
    testHookAnnounced = true;
    console.warn("[helper-update] serving the release signing key from STAGE_UTILITY_TEST_SIGNING_KEY_FILE, a test hook");
  }
  return file;
}
let testHookAnnounced = false;

/** The size the release key is, and the only one accepted. */
export const RELEASE_SIGNING_KEY_BITS = 3072;

export interface SigningKey {
  /** SubjectPublicKeyInfo PEM, what `openssl dgst -verify` reads. */
  pem: string;
  /** `<RSAKeyValue>`, what RSA.FromXmlString reads on .NET Framework. */
  xml: string;
}

/** The key in both forms, or a throw that says what is wrong with the text. */
export function parseSigningKey(text: string): SigningKey {
  // createPublicKey would take a private key too, and serve its public half;
  // the private half in this public tree is the one thing that must never be.
  if (/PRIVATE KEY-----/.test(text)) throw new Error("it holds a private key; only the public key belongs in the tree");
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey({ key: text, format: "pem" });
  } catch (err) {
    throw new Error(`it is not a PEM public key (${errorMessage(err)})`, { cause: err });
  }
  if (key.asymmetricKeyType !== "rsa") throw new Error(`it is a ${key.asymmetricKeyType ?? "unknown"} key, not RSA`);
  const bits = key.asymmetricKeyDetails?.modulusLength;
  if (bits !== RELEASE_SIGNING_KEY_BITS) throw new Error(`it is a ${bits ?? "?"}-bit RSA key, not ${RELEASE_SIGNING_KEY_BITS}-bit`);
  const jwk = key.export({ format: "jwk" });
  if (typeof jwk.n !== "string" || typeof jwk.e !== "string") throw new Error("its modulus or exponent could not be read");
  const b64 = (v: string) => Buffer.from(v, "base64url").toString("base64");
  return {
    pem: key.export({ format: "pem", type: "spki" }).toString(),
    xml: `<RSAKeyValue><Modulus>${b64(jwk.n)}</Modulus><Exponent>${b64(jwk.e)}</Exponent></RSAKeyValue>`,
  };
}

/** The key this build carries. Throws, naming the file, when it is missing or is
 *  not an RSA-3072 public key: an installer must not be handed something no
 *  signature can verify against. */
export async function readSigningKey(file = signingKeyFile()): Promise<SigningKey> {
  const text = await readFile(file, "utf8");
  try {
    return parseSigningKey(text);
  } catch (err) {
    throw new Error(`${path.basename(file)} is not usable: ${errorMessage(err)}`, { cause: err });
  }
}

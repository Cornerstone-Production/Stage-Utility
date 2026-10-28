// The release signing key the server hands installers: one PEM file in the tree,
// served as it is and as .NET's <RSAKeyValue>.
//
// Every case runs the real parser over a real key. The XML is checked by using
// it: the modulus and exponent it carries rebuild a key that verifies a real
// signature, so an XML with the right shape and the wrong numbers fails here.

import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { testSigningKey } from "./fixtures/test-signing-key.js";
import { parseSigningKey, readSigningKey, RELEASE_SIGNING_KEY_FILE } from "./release-signing-key.js";

/** The key the XML describes, rebuilt as a KeyObject. */
function fromXml(xml: string): crypto.KeyObject {
  const m = /^<RSAKeyValue><Modulus>([A-Za-z0-9+/=]+)<\/Modulus><Exponent>([A-Za-z0-9+/=]+)<\/Exponent><\/RSAKeyValue>$/.exec(xml);
  assert.ok(m, `not an RSAKeyValue: ${xml.slice(0, 80)}`);
  const url = (b: string) => Buffer.from(b, "base64").toString("base64url");
  return crypto.createPublicKey({ key: { kty: "RSA", n: url(m[1]), e: url(m[2]) }, format: "jwk" });
}

describe("parseSigningKey", () => {
  const key = testSigningKey();

  it("gives the PEM back, and an XML key that verifies what the private half signed", () => {
    const parsed = parseSigningKey(key.publicPem);
    assert.equal(parsed.pem, key.publicPem);
    const data = Buffer.from("a payload");
    const sig = key.sign(data);
    assert.equal(crypto.verify("sha256", data, fromXml(parsed.xml), sig), true);
    assert.equal(crypto.verify("sha256", Buffer.from("another payload"), fromXml(parsed.xml), sig), false);
    // .NET reads the modulus as big-endian bytes, exactly 384 of them for 3072 bits.
    const modulus = /<Modulus>([^<]+)</.exec(parsed.xml)?.[1] ?? "";
    assert.equal(Buffer.from(modulus, "base64").length, 384);
  });

  for (const [label, text, why] of [
    ["the placeholder text", "PLACEHOLDER: the production release signing public key goes here.\n", /not a PEM public key/],
    ["a 2048-bit RSA key", testSigningKey(2048).publicPem, /2048-bit RSA key, not 3072-bit/],
    ["an Ed25519 key", crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString(), /ed25519 key, not RSA/],
    ["a private key", key.privatePem, /holds a private key/],
  ] as const) {
    it(`refuses ${label}`, () => {
      assert.throws(() => parseSigningKey(text), why);
    });
  }

  it("names the file when it reads one that is not usable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "su-signing-key-"));
    try {
      const file = path.join(dir, "release-signing.pub.pem");
      fs.writeFileSync(file, "not a key");
      await assert.rejects(readSigningKey(file), /^Error: release-signing\.pub\.pem is not usable: it is not a PEM public key/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// EXPECTED RED until the maintainer commits the production public key: the file
// holds a placeholder on the branch that introduced it. Green means every
// installer can be handed a key a release signature verifies against.
describe("the production release signing key", () => {
  it("is an RSA-3072 public key", async () => {
    const parsed = await readSigningKey(RELEASE_SIGNING_KEY_FILE);
    assert.match(parsed.pem, /^-----BEGIN PUBLIC KEY-----\n/);
  });
});
